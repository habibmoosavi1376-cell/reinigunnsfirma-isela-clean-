import { recordAudit } from "@isela/audit";
import { auditActorOf, authorize, requireActor, type ServiceContext } from "@isela/auth";
import { findServiceAreasForPoint, geoPointSchema, geographyPointSql } from "@isela/catalog";
import { and, eq, inArray, schema } from "@isela/database";
import { assertProviderUsable, type LeadProviderDescriptor } from "@isela/lead-finder";
import { DomainError } from "@isela/shared";
import {
  emailSchema,
  normalizeEmail,
  normalizePhone,
  parseInput,
  phoneSchema,
  trimmedText,
  z,
} from "@isela/validation";
import { hashIdentity, type CrmConfig } from "./identity.ts";
import { LEAD_STATUSES, assertLeadTransition, type LeadStatus } from "./lead-state-machine.ts";

const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(500);

const createLeadInput = z.strictObject({
  sourceKey: z.string().trim().min(1).max(64),
  sourceReference: z.string().trim().min(1).max(200).optional(),
  companyName: trimmedText(200),
  segment: trimmedText(100).optional(),
  website: httpUrlSchema.optional(),
  postalCode: trimmedText(10).optional(),
  city: trimmedText(120).optional(),
  location: geoPointSchema.optional(),
});

async function loadSource(ctx: ServiceContext, sourceKey: string) {
  const [source] = await ctx.db
    .select()
    .from(schema.leadSource)
    .where(eq(schema.leadSource.key, sourceKey))
    .limit(1);
  if (source === undefined) {
    throw new DomainError("NOT_FOUND", "Lead source not found");
  }
  const descriptor: LeadProviderDescriptor = {
    providerId: source.key,
    providerKind: source.providerKind,
    legalBasis: source.legalBasis,
    termsReviewedAt: source.termsReviewedAt,
    allowedUse: source.allowedUse,
    retentionDays: source.retentionDays,
    rateLimitPerMinute: source.rateLimitPerMinute,
    enabled: source.enabled,
    sourceMetadata: source.sourceMetadata,
  };
  assertProviderUsable(descriptor);
  return source;
}

/** Records a lead from an approved source. New leads always start as DISCOVERED. */
export async function createLead(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead:create");
  const data = parseInput(createLeadInput, input);
  const source = await loadSource(ctx, data.sourceKey);
  const outsideServiceArea =
    data.location === undefined
      ? null
      : (await findServiceAreasForPoint(ctx.db, data.location)).length === 0;

  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.lead)
      .values({
        sourceId: source.id,
        sourceReference: data.sourceReference ?? null,
        companyName: data.companyName,
        segment: data.segment ?? null,
        website: data.website ?? null,
        postalCode: data.postalCode ?? null,
        city: data.city ?? null,
        location: data.location === undefined ? null : geographyPointSql(data.location),
        outsideServiceArea,
        ownerUserId: actor.userId,
        collectedAt: ctx.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: schema.lead.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Lead with this source reference already exists");
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "lead.created",
      entityType: "lead",
      entityId: row.id,
      after: { source: source.key, status: "DISCOVERED", outsideServiceArea },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const transitionInput = z.strictObject({
  leadId: z.uuid(),
  to: z.enum(LEAD_STATUSES),
  reason: z.string().trim().max(500).optional(),
});

/**
 * The only way to change a lead's status: validated against the state machine and business
 * guards, applied with optimistic concurrency, recorded in the transition history and audit log.
 */
export async function transitionLead(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ from: LeadStatus; to: LeadStatus }> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead:transition");
  const data = parseInput(transitionInput, input);

  return ctx.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: schema.lead.status, sourceKind: schema.leadSource.providerKind })
      .from(schema.lead)
      .innerJoin(schema.leadSource, eq(schema.leadSource.id, schema.lead.sourceId))
      .where(eq(schema.lead.id, data.leadId))
      .limit(1);
    if (current === undefined) {
      throw new DomainError("NOT_FOUND", "Lead not found");
    }
    const contactable = await tx
      .select({ id: schema.leadContact.id })
      .from(schema.leadContact)
      .where(
        and(eq(schema.leadContact.leadId, data.leadId), eq(schema.leadContact.suppressed, false)),
      )
      .limit(1);

    assertLeadTransition(current.status, data.to, {
      sourceKind: current.sourceKind,
      hasContactableContact: contactable.length > 0,
      performedByHuman: true,
      reason: data.reason ?? null,
    });

    const updated = await tx
      .update(schema.lead)
      .set({ status: data.to, updatedAt: ctx.clock.now() })
      .where(and(eq(schema.lead.id, data.leadId), eq(schema.lead.status, current.status)))
      .returning({ id: schema.lead.id });
    if (updated.length === 0) {
      throw new DomainError("CONFLICT", "Lead status was changed concurrently");
    }
    await tx.insert(schema.leadStatusTransition).values({
      leadId: data.leadId,
      fromStatus: current.status,
      toStatus: data.to,
      actorUserId: actor.userId,
      reason: data.reason ?? null,
    });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "lead.status_changed",
      entityType: "lead",
      entityId: data.leadId,
      before: { status: current.status },
      after: { status: data.to, reason: data.reason ?? null },
      correlationId: ctx.correlationId,
    });
    return { from: current.status, to: data.to };
  });
}

const addContactInput = z
  .strictObject({
    leadId: z.uuid(),
    fullName: trimmedText(200),
    roleTitle: trimmedText(120).optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    legalBasis: z.enum([
      "GDPR_ART6_1A_CONSENT",
      "GDPR_ART6_1B_CONTRACT",
      "GDPR_ART6_1F_LEGITIMATE_INTEREST",
    ]),
    consentStatus: z.enum(["NOT_REQUIRED", "UNKNOWN", "GRANTED"]).default("UNKNOWN"),
  })
  .refine((c) => c.email !== undefined || c.phone !== undefined, {
    message: "email or phone is required",
    path: ["email"],
  });

function suppressionHashes(config: CrmConfig, email: string | null, phone: string | null) {
  const hashes: { channel: "EMAIL" | "PHONE"; valueHash: string }[] = [];
  if (email !== null) {
    hashes.push({
      channel: "EMAIL",
      valueHash: hashIdentity(config, "EMAIL", normalizeEmail(email)),
    });
  }
  const normalizedPhone = phone === null ? null : normalizePhone(phone);
  if (normalizedPhone !== null) {
    hashes.push({ channel: "PHONE", valueHash: hashIdentity(config, "PHONE", normalizedPhone) });
  }
  return hashes;
}

/**
 * Adds a contact to a lead. The contact inherits the lead's source (traceability). Contacts
 * on the global suppression list are stored as suppressed and can never be contacted.
 */
export async function addLeadContact(
  ctx: ServiceContext,
  input: unknown,
  config: CrmConfig,
): Promise<{ contactId: string; suppressed: boolean }> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead_contact:write");
  const data = parseInput(addContactInput, input);
  const email = data.email ?? null;
  const phone = data.phone ?? null;
  const hashes = suppressionHashes(config, email, phone);

  return ctx.db.transaction(async (tx) => {
    const [lead] = await tx
      .select({ sourceId: schema.lead.sourceId })
      .from(schema.lead)
      .where(eq(schema.lead.id, data.leadId))
      .limit(1);
    if (lead === undefined) {
      throw new DomainError("NOT_FOUND", "Lead not found");
    }
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
    const now = ctx.clock.now();

    const [row] = await tx
      .insert(schema.leadContact)
      .values({
        leadId: data.leadId,
        fullName: data.fullName,
        roleTitle: data.roleTitle ?? null,
        email,
        phone,
        sourceId: lead.sourceId,
        legalBasis: data.legalBasis,
        consentStatus: data.consentStatus,
        suppressed,
        suppressedAt: suppressed ? now : null,
        suppressionReason: suppressed ? "GLOBAL_SUPPRESSION_LIST" : null,
      })
      .returning({ id: schema.leadContact.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Contact could not be created");
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "lead_contact.created",
      entityType: "lead_contact",
      entityId: row.id,
      after: { leadId: data.leadId, legalBasis: data.legalBasis, suppressed },
      correlationId: ctx.correlationId,
    });
    return { contactId: row.id, suppressed };
  });
}

const suppressInput = z.strictObject({
  contactId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
});

/** Records an objection: the contact is suppressed and added to the global suppression list. */
export async function suppressLeadContact(
  ctx: ServiceContext,
  input: unknown,
  config: CrmConfig,
): Promise<void> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead_contact:suppress");
  const data = parseInput(suppressInput, input);
  await ctx.db.transaction(async (tx) => {
    const [contact] = await tx
      .select({ email: schema.leadContact.email, phone: schema.leadContact.phone })
      .from(schema.leadContact)
      .where(eq(schema.leadContact.id, data.contactId))
      .for("update")
      .limit(1);
    if (contact === undefined) {
      throw new DomainError("NOT_FOUND", "Contact not found");
    }
    const now = ctx.clock.now();
    await tx
      .update(schema.leadContact)
      .set({
        suppressed: true,
        suppressedAt: now,
        suppressionReason: data.reason,
        consentStatus: "WITHDRAWN",
        updatedAt: now,
      })
      .where(eq(schema.leadContact.id, data.contactId));
    for (const hash of suppressionHashes(config, contact.email, contact.phone)) {
      await tx
        .insert(schema.contactSuppression)
        .values({ ...hash, reason: data.reason })
        .onConflictDoNothing();
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "lead_contact.suppressed",
      entityType: "lead_contact",
      entityId: data.contactId,
      after: { suppressed: true },
      correlationId: ctx.correlationId,
    });
  });
}
