import { recordAudit, type AuditActor } from "@isela/audit";
import { authorize, type Actor, type ServiceContext } from "@isela/auth";
import {
  and,
  consumeRateLimit,
  count,
  desc,
  eq,
  inArray,
  schema,
  type Database,
} from "@isela/database";
import { DomainError, type Clock } from "@isela/shared";
import {
  countryCodeSchema,
  emailSchema,
  isValidPostalCode,
  normalizeEmail,
  parseInput,
  phoneSchema,
  trimmedText,
  z,
} from "@isela/validation";
import { keyedHash, type CrmConfig } from "./identity.ts";
import { geocodeSubmittedRequest, type GeocodingDeps } from "./request-geocoding.ts";
import { loadUsableLeadSource, suppressionHashes } from "./leads.ts";
import type { LeadStatus } from "./lead-state-machine.ts";

/** The website form source (seeded, INTERNAL_INBOUND). */
export const WEBSITE_REQUEST_SOURCE_KEY = "internal-website-form";

export const REQUEST_FREQUENCIES = ["ONCE", "WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM"] as const;
export const REQUEST_CUSTOMER_TYPES = ["PRIVATE", "BUSINESS", "PROPERTY_MANAGEMENT"] as const;
export const REQUEST_PROPERTY_TYPES = [
  "APARTMENT",
  "HOUSE",
  "OFFICE",
  "PRACTICE",
  "STAIRWELL",
  "COMMERCIAL",
  "OTHER",
] as const;

/**
 * Public request form ("Reinigung anfragen"). Strict: unknown fields are rejected.
 * The privacy notice acknowledgement is required (information duty, pre-contractual
 * processing – not consent). Marketing consent is optional and only stored when given.
 */
export const serviceRequestInputSchema = z
  .strictObject({
    customerType: z.enum(REQUEST_CUSTOMER_TYPES),
    fullName: trimmedText(120),
    companyName: trimmedText(200).optional(),
    email: emailSchema,
    phone: phoneSchema.optional(),
    street: trimmedText(200),
    houseNumber: trimmedText(20),
    postalCode: trimmedText(10),
    city: trimmedText(120),
    country: countryCodeSchema.default("DE"),
    serviceCategoryKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    propertyType: z.enum(REQUEST_PROPERTY_TYPES),
    approximateAreaSqm: z.number().positive().max(1_000_000).optional(),
    frequency: z.enum(REQUEST_FREQUENCIES),
    /** Property management only (optional, prepares multi-property handling). */
    numberOfProperties: z.number().int().min(1).max(100_000).optional(),
    message: z.string().trim().max(2000).optional(),
    privacyNoticeAcknowledged: z.literal(true, { error: "Privacy notice must be acknowledged" }),
    privacyNoticeVersion: z.string().trim().min(1).max(50),
    marketingConsent: z.boolean().default(false),
    marketingConsentTextVersion: z.string().trim().min(1).max(50).optional(),
  })
  // Customer-type rules: companies need a company name (fullName is then the contact person);
  // property counts only make sense for property management.
  .refine((r) => r.customerType === "PRIVATE" || r.companyName !== undefined, {
    message: "companyName is required for business requests",
    path: ["companyName"],
  })
  .refine((r) => r.numberOfProperties === undefined || r.customerType === "PROPERTY_MANAGEMENT", {
    message: "numberOfProperties is only allowed for property management",
    path: ["numberOfProperties"],
  })
  .refine((r) => isValidPostalCode(r.postalCode, r.country), {
    message: "Invalid postal code for country",
    path: ["postalCode"],
  })
  .refine((r) => !r.marketingConsent || r.marketingConsentTextVersion !== undefined, {
    message: "Consent text version is required when consent is given",
    path: ["marketingConsentTextVersion"],
  });

export type ServiceRequestInput = z.input<typeof serviceRequestInputSchema>;

export interface SubmitServiceRequestDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly config: CrmConfig;
  /** Signed-in user, if any (a CUSTOMER's request is linked to its customer record). */
  readonly requester: Actor | null;
  /** Client identifier for rate limiting (e.g. the client IP); hashed before storage. */
  readonly clientKey: string;
  readonly rateLimitPerHour: number;
  readonly correlationId?: string | undefined;
  /** Geocoding + service-area check after storing; omitted or provider null = not configured. */
  readonly geocoding?: GeocodingDeps;
}

export interface SubmitServiceRequestResult {
  readonly requestId: string;
  readonly leadId: string;
  /** UNKNOWN unless the address was geocoded with sufficient quality. */
  readonly serviceAreaStatus: "AVAILABLE" | "NOT_AVAILABLE" | "UNKNOWN";
  /** true if the post-commit geocoding step failed unexpectedly (caller logs it). */
  readonly geocodingFailed: boolean;
}

/**
 * Public operation (no permission required): records a website request as lead + contact +
 * request details. It never quotes a price, books, charges or assigns a partner.
 * Abuse protection: per-client and per-e-mail rate limits (hashed keys), strict validation.
 */
export async function submitServiceRequest(
  input: unknown,
  deps: SubmitServiceRequestDeps,
): Promise<SubmitServiceRequestResult> {
  const data = parseInput(serviceRequestInputSchema, input);
  const now = deps.clock.now();
  const email = normalizeEmail(data.email);

  const clientLimit = await consumeRateLimit(
    deps.db,
    `service-request:client:${keyedHash(deps.config, "rate-limit:client", deps.clientKey)}`,
    deps.rateLimitPerHour,
    3600,
    now,
  );
  const emailLimit = await consumeRateLimit(
    deps.db,
    `service-request:email:${keyedHash(deps.config, "rate-limit:email", email)}`,
    3,
    24 * 3600,
    now,
  );
  if (!clientLimit.allowed || !emailLimit.allowed) {
    throw new DomainError("RATE_LIMITED", "Too many requests, please try again later");
  }

  const source = await loadUsableLeadSource(deps.db, WEBSITE_REQUEST_SOURCE_KEY);
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

  const customerAssignment = deps.requester?.roles.find((r) => r.role === "CUSTOMER");
  const customerId = customerAssignment?.customerId ?? null;
  const auditActor: AuditActor =
    deps.requester === null ? { type: "SYSTEM" } : { type: "USER", id: deps.requester.userId };

  const stored = await deps.db.transaction(async (tx) => {
    const [lead] = await tx
      .insert(schema.lead)
      .values({
        sourceId: source.id,
        companyName: data.companyName ?? data.fullName,
        segment: data.customerType,
        postalCode: data.postalCode,
        city: data.city,
        collectedAt: now,
      })
      .returning({ id: schema.lead.id });
    if (lead === undefined) {
      throw new DomainError("CONFLICT", "Request could not be stored");
    }

    const hashes = suppressionHashes(deps.config, email, data.phone ?? null);
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
    const suppressed = blocked.length > 0;

    const [contact] = await tx
      .insert(schema.leadContact)
      .values({
        leadId: lead.id,
        fullName: data.fullName,
        email,
        phone: data.phone ?? null,
        sourceId: source.id,
        legalBasis: "GDPR_ART6_1B_CONTRACT",
        consentStatus: data.marketingConsent ? "GRANTED" : "NOT_REQUIRED",
        suppressed,
        suppressedAt: suppressed ? now : null,
        suppressionReason: suppressed ? "GLOBAL_SUPPRESSION_LIST" : null,
      })
      .returning({ id: schema.leadContact.id });
    if (contact === undefined) {
      throw new DomainError("CONFLICT", "Request could not be stored");
    }

    const [request] = await tx
      .insert(schema.serviceRequest)
      .values({
        leadId: lead.id,
        customerId,
        submittedByUserId: deps.requester?.userId ?? null,
        customerType: data.customerType,
        serviceCategoryId: category.id,
        propertyType: data.propertyType,
        approximateAreaSqm: data.approximateAreaSqm ?? null,
        frequency: data.frequency,
        numberOfProperties: data.numberOfProperties ?? null,
        message: data.message === undefined || data.message === "" ? null : data.message,
        street: data.street,
        houseNumber: data.houseNumber,
        postalCode: data.postalCode,
        city: data.city,
        country: data.country,
        privacyNoticeVersion: data.privacyNoticeVersion,
        privacyNoticeAcknowledgedAt: now,
      })
      .returning({ id: schema.serviceRequest.id });
    if (request === undefined) {
      throw new DomainError("CONFLICT", "Request could not be stored");
    }

    if (data.marketingConsent && data.marketingConsentTextVersion !== undefined) {
      await tx.insert(schema.consent).values({
        subjectType: "LEAD_CONTACT",
        subjectId: contact.id,
        purpose: "MARKETING_EMAIL",
        legalBasis: "GDPR_ART6_1A",
        status: "GRANTED",
        grantedAt: now,
        source: "WEBSITE_FORM",
        textVersion: data.marketingConsentTextVersion,
        evidenceReference: `service_request:${request.id}`,
      });
    }

    await recordAudit(tx, {
      actor: auditActor,
      action: "lead.created",
      entityType: "lead",
      entityId: lead.id,
      after: { source: WEBSITE_REQUEST_SOURCE_KEY, status: "DISCOVERED" },
      correlationId: deps.correlationId,
    });
    await recordAudit(tx, {
      actor: auditActor,
      action: "service_request.submitted",
      entityType: "service_request",
      entityId: request.id,
      after: {
        leadId: lead.id,
        serviceCategoryKey: data.serviceCategoryKey,
        customerType: data.customerType,
        frequency: data.frequency,
        marketingConsent: data.marketingConsent,
        linkedCustomer: customerId !== null,
      },
      correlationId: deps.correlationId,
    });

    return { requestId: request.id, leadId: lead.id };
  });

  // Geocoding runs after the commit (external HTTP call, never inside a DB transaction). The
  // request is already stored: a failure here must not lose it – staff can re-run geocoding.
  let serviceAreaStatus: SubmitServiceRequestResult["serviceAreaStatus"] = "UNKNOWN";
  let geocodingFailed = false;
  if (deps.geocoding !== undefined) {
    try {
      const run = await geocodeSubmittedRequest(
        { db: deps.db, clock: deps.clock, actor: auditActor, correlationId: deps.correlationId },
        stored.requestId,
        deps.geocoding,
      );
      serviceAreaStatus = run.serviceAvailability;
    } catch {
      geocodingFailed = true;
    }
  }
  return { ...stored, serviceAreaStatus, geocodingFailed };
}

export interface CustomerRequestView {
  readonly id: string;
  readonly createdAt: Date;
  readonly serviceName: string;
  readonly frequency: (typeof REQUEST_FREQUENCIES)[number];
  readonly status: LeadStatus;
}

const customerIdInput = z.strictObject({ customerId: z.uuid() });

/** Requests of one customer (object-level authorization: CUSTOMER sees only its own). */
export async function listCustomerServiceRequests(
  ctx: ServiceContext,
  input: unknown,
): Promise<CustomerRequestView[]> {
  const { customerId } = parseInput(customerIdInput, input);
  authorize(ctx.actor, "customer:read", { customerId });
  const r = schema.serviceRequest;
  return ctx.db
    .select({
      id: r.id,
      createdAt: r.createdAt,
      serviceName: schema.serviceCategory.name,
      frequency: r.frequency,
      status: schema.lead.status,
    })
    .from(r)
    .innerJoin(schema.serviceCategory, eq(schema.serviceCategory.id, r.serviceCategoryId))
    .innerJoin(schema.lead, eq(schema.lead.id, r.leadId))
    .where(eq(r.customerId, customerId))
    .orderBy(desc(r.createdAt))
    .limit(50);
}

export interface LeadOverview {
  readonly byStatus: readonly { status: LeadStatus; count: number }[];
  readonly latestRequests: readonly {
    id: string;
    createdAt: Date;
    serviceName: string;
    customerType: (typeof REQUEST_CUSTOMER_TYPES)[number];
    city: string;
    serviceAreaStatus: "UNKNOWN" | "AVAILABLE" | "NOT_AVAILABLE";
  }[];
}

/** Staff dashboard data (requires lead:read). */
export async function getLeadOverview(ctx: ServiceContext): Promise<LeadOverview> {
  authorize(ctx.actor, "lead:read");
  const byStatus = await ctx.db
    .select({ status: schema.lead.status, count: count() })
    .from(schema.lead)
    .groupBy(schema.lead.status);
  const r = schema.serviceRequest;
  const latestRequests = await ctx.db
    .select({
      id: r.id,
      createdAt: r.createdAt,
      serviceName: schema.serviceCategory.name,
      customerType: r.customerType,
      city: r.city,
      serviceAreaStatus: r.serviceAreaStatus,
    })
    .from(r)
    .innerJoin(schema.serviceCategory, eq(schema.serviceCategory.id, r.serviceCategoryId))
    .orderBy(desc(r.createdAt))
    .limit(10);
  return { byStatus, latestRequests };
}
