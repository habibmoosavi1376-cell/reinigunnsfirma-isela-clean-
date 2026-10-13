import { recordAudit, type AuditActor } from "@isela/audit";
import { and, consumeRateLimit, eq, inArray, schema, type Database } from "@isela/database";
import { DomainError } from "@isela/shared";
import {
  countryCodeSchema,
  isValidPostalCode,
  normalizePhone,
  parseInput,
  phoneSchema,
  trimmedText,
  z,
} from "@isela/validation";
import { keyedHash } from "./identity.ts";
import { loadUsableLeadSource, suppressionHashes } from "./leads.ts";
import {
  isUniqueViolation,
  REQUEST_CUSTOMER_TYPES,
  submissionTokenSchema,
  WEBSITE_REQUEST_SOURCE_KEY,
  type SubmitServiceRequestDeps,
} from "./service-requests.ts";

export const CALLBACK_TIME_WINDOWS = ["ANY", "MORNING", "MIDDAY", "AFTERNOON"] as const;

/**
 * Public "Rückruf anfordern" (day 7). Data minimisation: name and phone number are the only
 * personal data required; postal code and service are optional and only help to route the
 * call. The privacy notice must be acknowledged (information duty, not consent).
 */
export const callbackRequestInputSchema = z
  .strictObject({
    customerType: z.enum(REQUEST_CUSTOMER_TYPES),
    fullName: trimmedText(120),
    phone: phoneSchema,
    postalCode: trimmedText(10).optional(),
    country: countryCodeSchema.default("DE"),
    serviceCategoryKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64)
      .optional(),
    preferredWindow: z.enum(CALLBACK_TIME_WINDOWS).default("ANY"),
    message: z.string().trim().max(500).optional(),
    privacyNoticeAcknowledged: z.literal(true, { error: "Privacy notice must be acknowledged" }),
    privacyNoticeVersion: z.string().trim().min(1).max(50),
    submissionToken: submissionTokenSchema.optional(),
  })
  .refine((r) => r.postalCode === undefined || isValidPostalCode(r.postalCode, r.country), {
    message: "Invalid postal code for country",
    path: ["postalCode"],
  });

export type CallbackRequestInput = z.input<typeof callbackRequestInputSchema>;

export interface SubmitCallbackRequestResult {
  readonly callbackRequestId: string;
  readonly leadId: string;
  /** true if this submission repeated an already stored form (nothing new was stored). */
  readonly duplicate: boolean;
}

type CallbackDeps = Omit<SubmitServiceRequestDeps, "geocoding">;

async function findBySubmission(
  db: Database,
  submissionKeyHash: string,
): Promise<SubmitCallbackRequestResult | null> {
  const c = schema.callbackRequest;
  const [row] = await db
    .select({ callbackRequestId: c.id, leadId: c.leadId })
    .from(c)
    .where(eq(c.submissionKeyHash, submissionKeyHash))
    .limit(1);
  return row === undefined ? null : { ...row, duplicate: true };
}

/**
 * Public operation (no permission required): stores a callback wish as lead + contact +
 * callback details. It never promises a time slot, availability or a price. Abuse
 * protection: per-client and per-phone rate limits (hashed keys), strict validation,
 * idempotent form token.
 */
export async function submitCallbackRequest(
  input: unknown,
  deps: CallbackDeps,
): Promise<SubmitCallbackRequestResult> {
  const data = parseInput(callbackRequestInputSchema, input);
  const now = deps.clock.now();
  const phone = normalizePhone(data.phone);
  if (phone === null) {
    throw new DomainError("VALIDATION_FAILED", "Invalid phone number", {
      issues: [{ path: "phone", code: "custom" }],
    });
  }
  const submissionKeyHash =
    data.submissionToken === undefined
      ? null
      : keyedHash(deps.config, "submission:callback-request", data.submissionToken);
  if (submissionKeyHash !== null) {
    const existing = await findBySubmission(deps.db, submissionKeyHash);
    if (existing !== null) return existing;
  }

  const clientLimit = await consumeRateLimit(
    deps.db,
    `callback-request:client:${keyedHash(deps.config, "rate-limit:client", deps.clientKey)}`,
    deps.rateLimitPerHour,
    3600,
    now,
  );
  const phoneLimit = await consumeRateLimit(
    deps.db,
    `callback-request:phone:${keyedHash(deps.config, "rate-limit:phone", phone)}`,
    3,
    24 * 3600,
    now,
  );
  if (!clientLimit.allowed || !phoneLimit.allowed) {
    throw new DomainError("RATE_LIMITED", "Too many requests, please try again later");
  }

  const source = await loadUsableLeadSource(deps.db, WEBSITE_REQUEST_SOURCE_KEY);
  let categoryId: string | null = null;
  if (data.serviceCategoryKey !== undefined) {
    const [category] = await deps.db
      .select({ id: schema.serviceCategory.id })
      .from(schema.serviceCategory)
      .where(
        and(
          eq(schema.serviceCategory.key, data.serviceCategoryKey),
          eq(schema.serviceCategory.active, true),
        ),
      )
      .limit(1);
    if (category === undefined) {
      throw new DomainError("VALIDATION_FAILED", "Unknown service", {
        issues: [{ path: "serviceCategoryKey", code: "invalid_value" }],
      });
    }
    categoryId = category.id;
  }

  const auditActor: AuditActor =
    deps.requester === null ? { type: "SYSTEM" } : { type: "USER", id: deps.requester.userId };

  const store = async (): Promise<SubmitCallbackRequestResult> =>
    deps.db.transaction(async (tx) => {
      const [lead] = await tx
        .insert(schema.lead)
        .values({
          sourceId: source.id,
          companyName: data.fullName,
          segment: data.customerType,
          postalCode: data.postalCode ?? null,
          collectedAt: now,
        })
        .returning({ id: schema.lead.id });
      if (lead === undefined) throw new DomainError("CONFLICT", "Callback could not be stored");

      const hashes = suppressionHashes(deps.config, null, phone);
      const blocked =
        hashes.length === 0
          ? []
          : await tx
              .select({ id: schema.contactSuppression.id })
              .from(schema.contactSuppression)
              .where(
                inArray(
                  schema.contactSuppression.valueHash,
                  hashes.map((h) => h.valueHash),
                ),
              )
              .limit(1);
      // A suppressed number still gets its own requested callback: the visitor asked for it.
      // The flag only prevents any further (marketing) contact beyond this request.
      const suppressed = blocked.length > 0;
      await tx.insert(schema.leadContact).values({
        leadId: lead.id,
        fullName: data.fullName,
        email: null,
        phone,
        sourceId: source.id,
        legalBasis: "GDPR_ART6_1B_CONTRACT",
        consentStatus: "NOT_REQUIRED",
        suppressed,
        suppressedAt: suppressed ? now : null,
        suppressionReason: suppressed ? "GLOBAL_SUPPRESSION_LIST" : null,
      });

      const [callback] = await tx
        .insert(schema.callbackRequest)
        .values({
          leadId: lead.id,
          submittedByUserId: deps.requester?.userId ?? null,
          customerType: data.customerType,
          serviceCategoryId: categoryId,
          postalCode: data.postalCode ?? null,
          preferredWindow: data.preferredWindow,
          message: data.message === undefined || data.message === "" ? null : data.message,
          privacyNoticeVersion: data.privacyNoticeVersion,
          privacyNoticeAcknowledgedAt: now,
          submissionKeyHash,
        })
        .returning({ id: schema.callbackRequest.id });
      if (callback === undefined) {
        throw new DomainError("CONFLICT", "Callback could not be stored");
      }

      await recordAudit(tx, {
        actor: auditActor,
        action: "lead.created",
        entityType: "lead",
        entityId: lead.id,
        after: { source: WEBSITE_REQUEST_SOURCE_KEY, status: "DISCOVERED", channel: "CALLBACK" },
        correlationId: deps.correlationId,
      });
      await recordAudit(tx, {
        actor: auditActor,
        action: "callback_request.submitted",
        entityType: "callback_request",
        entityId: callback.id,
        after: {
          leadId: lead.id,
          customerType: data.customerType,
          serviceCategoryKey: data.serviceCategoryKey ?? null,
          preferredWindow: data.preferredWindow,
        },
        correlationId: deps.correlationId,
      });
      return { callbackRequestId: callback.id, leadId: lead.id, duplicate: false };
    });

  try {
    return await store();
  } catch (error) {
    if (submissionKeyHash !== null && isUniqueViolation(error)) {
      const existing = await findBySubmission(deps.db, submissionKeyHash);
      if (existing !== null) return existing;
    }
    throw error;
  }
}
