import { recordAudit } from "@isela/audit";
import { auditActorOf, authorize, requireActor, type ServiceContext } from "@isela/auth";
import { and, desc, eq, schema } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";

const PURPOSES = [
  "MARKETING_EMAIL",
  "MARKETING_PHONE",
  "COOKIES_ANALYTICS",
  "REVIEW_REQUEST",
  "REFERRAL_CONTACT",
  "OTHER_COMMUNICATION",
] as const;
type ConsentPurpose = (typeof PURPOSES)[number];

const subjectSchema = z.discriminatedUnion("subjectType", [
  z.strictObject({ subjectType: z.literal("CUSTOMER"), subjectId: z.uuid() }),
  z.strictObject({ subjectType: z.literal("LEAD_CONTACT"), subjectId: z.uuid() }),
  z.strictObject({ subjectType: z.literal("USER"), subjectId: z.string().min(1).max(64) }),
]);

const recordConsentInput = z.strictObject({
  subject: subjectSchema,
  purpose: z.enum(PURPOSES),
  status: z.enum(["GRANTED", "WITHDRAWN"]),
  source: z.enum(["WEBSITE_FORM", "CUSTOMER_PORTAL", "STAFF_RECORDED", "COOKIE_BANNER"]),
  textVersion: z.string().trim().min(1).max(50),
  evidenceReference: z.string().trim().min(1).max(200).optional(),
});

/** Consent-type legal basis derived from the purpose – callers cannot mislabel processing. */
function legalBasisFor(purpose: ConsentPurpose): "GDPR_ART6_1A" | "TDDDG_25_1" {
  return purpose === "COOKIES_ANALYTICS" ? "TDDDG_25_1" : "GDPR_ART6_1A";
}

function authorizeSubject(
  ctx: ServiceContext,
  permission: "consent:record" | "consent:read",
  subject: z.infer<typeof subjectSchema>,
) {
  const actor = requireActor(ctx.actor);
  if (subject.subjectType === "USER") {
    if (actor.userId !== subject.subjectId) {
      authorize(actor, permission);
    }
    return actor;
  }
  authorize(
    actor,
    permission,
    subject.subjectType === "CUSTOMER" ? { customerId: subject.subjectId } : undefined,
  );
  return actor;
}

/**
 * Appends a consent record (grant or withdrawal). Records are immutable; the latest record
 * per subject and purpose is the effective state.
 */
export async function recordConsent(ctx: ServiceContext, input: unknown): Promise<string> {
  const data = parseInput(recordConsentInput, input);
  const actor = authorizeSubject(ctx, "consent:record", data.subject);
  const now = ctx.clock.now();

  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.consent)
      .values({
        subjectType: data.subject.subjectType,
        subjectId: data.subject.subjectId,
        purpose: data.purpose,
        legalBasis: legalBasisFor(data.purpose),
        status: data.status,
        grantedAt: data.status === "GRANTED" ? now : null,
        withdrawnAt: data.status === "WITHDRAWN" ? now : null,
        source: data.source,
        textVersion: data.textVersion,
        evidenceReference: data.evidenceReference ?? null,
        recordedByUserId: actor.userId,
      })
      .returning({ id: schema.consent.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Consent could not be recorded");
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: data.status === "GRANTED" ? "consent.granted" : "consent.withdrawn",
      entityType: "consent",
      entityId: row.id,
      after: { subjectType: data.subject.subjectType, purpose: data.purpose },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const effectiveConsentInput = z.strictObject({ subject: subjectSchema, purpose: z.enum(PURPOSES) });

export async function getEffectiveConsent(
  ctx: ServiceContext,
  input: unknown,
): Promise<"GRANTED" | "WITHDRAWN" | "NONE"> {
  const data = parseInput(effectiveConsentInput, input);
  authorizeSubject(ctx, "consent:read", data.subject);
  const [latest] = await ctx.db
    .select({ status: schema.consent.status })
    .from(schema.consent)
    .where(
      and(
        eq(schema.consent.subjectType, data.subject.subjectType),
        eq(schema.consent.subjectId, data.subject.subjectId),
        eq(schema.consent.purpose, data.purpose),
      ),
    )
    .orderBy(desc(schema.consent.createdAt), desc(schema.consent.id))
    .limit(1);
  return latest?.status ?? "NONE";
}

const withdrawInput = z.strictObject({ contactId: z.uuid(), purpose: z.enum(PURPOSES) });

/**
 * Staff records a withdrawal (e.g. by phone or letter) for a lead contact. Consent records
 * stay immutable: a new WITHDRAWN record is appended with the withdrawn text version, the
 * contact's consent status follows, and both are audited.
 */
export async function withdrawLeadContactConsent(
  ctx: ServiceContext,
  input: unknown,
): Promise<string> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "consent:record");
  const data = parseInput(withdrawInput, input);
  return ctx.db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ status: schema.consent.status, textVersion: schema.consent.textVersion })
      .from(schema.consent)
      .where(
        and(
          eq(schema.consent.subjectType, "LEAD_CONTACT"),
          eq(schema.consent.subjectId, data.contactId),
          eq(schema.consent.purpose, data.purpose),
        ),
      )
      .orderBy(desc(schema.consent.createdAt), desc(schema.consent.id))
      .limit(1);
    if (latest?.status !== "GRANTED") {
      throw new DomainError("INVALID_STATE_TRANSITION", "There is no granted consent to withdraw");
    }
    const now = ctx.clock.now();
    const [row] = await tx
      .insert(schema.consent)
      .values({
        subjectType: "LEAD_CONTACT",
        subjectId: data.contactId,
        purpose: data.purpose,
        legalBasis: legalBasisFor(data.purpose),
        status: "WITHDRAWN",
        withdrawnAt: now,
        source: "STAFF_RECORDED",
        textVersion: latest.textVersion,
        recordedByUserId: actor.userId,
      })
      .returning({ id: schema.consent.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Consent could not be recorded");
    }
    await tx
      .update(schema.leadContact)
      .set({ consentStatus: "WITHDRAWN", updatedAt: now })
      .where(eq(schema.leadContact.id, data.contactId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "consent.withdrawn",
      entityType: "consent",
      entityId: row.id,
      after: { subjectType: "LEAD_CONTACT", subjectId: data.contactId, purpose: data.purpose },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}
