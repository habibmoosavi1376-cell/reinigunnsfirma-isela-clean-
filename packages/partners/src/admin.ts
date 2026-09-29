import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  authorize,
  hasGlobalPermission,
  requireActor,
  scopeFilterFor,
  type ServiceContext,
} from "@isela/auth";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  or,
  schema,
  type SQL,
  type Transaction,
} from "@isela/database";
import { DomainError } from "@isela/shared";
import { latitudeSchema, longitudeSchema, parseInput, trimmedText, z } from "@isela/validation";

/*
 * Partner administration (partner:manage). A partner starts as PENDING_VERIFICATION and is
 * ACTIVE only after a person verified the required documents (kinds are configuration passed
 * in by the caller; the database additionally requires verified_at for ACTIVE). Verification
 * evidence is metadata only – no files and no document content are stored here.
 */

export const PARTNER_DOCUMENT_KIND_VALUES = [
  "TRADE_REGISTRATION",
  "LIABILITY_INSURANCE",
  "OTHER",
] as const;
type DocumentKind = (typeof PARTNER_DOCUMENT_KIND_VALUES)[number];

function requireManage(ctx: ServiceContext) {
  const actor = requireActor(ctx.actor);
  if (!hasGlobalPermission(actor, "partner:manage")) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission: "partner:manage" });
  }
  return actor;
}

async function lockPartner(tx: Transaction, partnerId: string) {
  const [row] = await tx
    .select()
    .from(schema.partner)
    .where(and(eq(schema.partner.id, partnerId), isNull(schema.partner.archivedAt)))
    .for("update")
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Partner not found");
  return row;
}

const createInput = z.strictObject({
  legalName: trimmedText(200),
  baseLatitude: latitudeSchema,
  baseLongitude: longitudeSchema,
  serviceRadiusM: z.number().int().min(1).max(300_000),
  maxConcurrentJobs: z.number().int().min(1).max(1000).nullable().optional(),
});

export async function createPartner(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireManage(ctx);
  const data = parseInput(createInput, input);
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.partner)
      .values({
        legalName: data.legalName,
        status: "PENDING_VERIFICATION",
        baseLatitude: data.baseLatitude,
        baseLongitude: data.baseLongitude,
        serviceRadiusM: data.serviceRadiusM,
        maxConcurrentJobs: data.maxConcurrentJobs ?? null,
      })
      .returning({ id: schema.partner.id });
    if (row === undefined) throw new DomainError("CONFLICT", "Partner could not be created");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "partner.created",
      entityType: "partner",
      entityId: row.id,
      after: {
        serviceRadiusM: data.serviceRadiusM,
        maxConcurrentJobs: data.maxConcurrentJobs ?? null,
      },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const capacityInput = z.strictObject({
  partnerId: z.uuid(),
  maxConcurrentJobs: z.number().int().min(1).max(1000).nullable(),
});

export async function setPartnerCapacity(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireManage(ctx);
  const data = parseInput(capacityInput, input);
  await ctx.db.transaction(async (tx) => {
    const partner = await lockPartner(tx, data.partnerId);
    await tx
      .update(schema.partner)
      .set({ maxConcurrentJobs: data.maxConcurrentJobs, updatedAt: ctx.clock.now() })
      .where(eq(schema.partner.id, partner.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "partner.capacity_changed",
      entityType: "partner",
      entityId: partner.id,
      before: { maxConcurrentJobs: partner.maxConcurrentJobs },
      after: { maxConcurrentJobs: data.maxConcurrentJobs },
      correlationId: ctx.correlationId,
    });
  });
}

const servicesInput = z.strictObject({
  partnerId: z.uuid(),
  serviceIds: z.array(z.uuid()).max(200),
});

export async function setPartnerServices(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireManage(ctx);
  const data = parseInput(servicesInput, input);
  const serviceIds = [...new Set(data.serviceIds)];
  await ctx.db.transaction(async (tx) => {
    const partner = await lockPartner(tx, data.partnerId);
    if (serviceIds.length > 0) {
      const found = await tx
        .select({ id: schema.service.id })
        .from(schema.service)
        .where(inArray(schema.service.id, serviceIds));
      if (found.length !== serviceIds.length)
        throw new DomainError("NOT_FOUND", "Service not found");
    }
    await tx.delete(schema.partnerService).where(eq(schema.partnerService.partnerId, partner.id));
    if (serviceIds.length > 0) {
      await tx
        .insert(schema.partnerService)
        .values(serviceIds.map((serviceId) => ({ partnerId: partner.id, serviceId })));
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "partner.services_changed",
      entityType: "partner",
      entityId: partner.id,
      after: { serviceIds },
      correlationId: ctx.correlationId,
    });
  });
}

const documentInput = z.strictObject({
  partnerId: z.uuid(),
  kind: z.enum(PARTNER_DOCUMENT_KIND_VALUES),
  reference: z.string().trim().max(100).optional(),
  validUntil: z.iso.date().optional(),
});

export async function addPartnerDocument(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireManage(ctx);
  const data = parseInput(documentInput, input);
  return ctx.db.transaction(async (tx) => {
    const partner = await lockPartner(tx, data.partnerId);
    const [row] = await tx
      .insert(schema.partnerDocument)
      .values({
        partnerId: partner.id,
        kind: data.kind,
        reference: data.reference === undefined || data.reference === "" ? null : data.reference,
        validUntil: data.validUntil ?? null,
      })
      .returning({ id: schema.partnerDocument.id });
    if (row === undefined) throw new DomainError("CONFLICT", "Document could not be recorded");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "partner.document_added",
      entityType: "partner",
      entityId: partner.id,
      after: { documentId: row.id, kind: data.kind, validUntil: data.validUntil ?? null },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const reviewInput = z.strictObject({
  partnerId: z.uuid(),
  documentId: z.uuid(),
  decision: z.enum(["VERIFIED", "REJECTED"]),
});

export async function reviewPartnerDocument(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireManage(ctx);
  const data = parseInput(reviewInput, input);
  const now = ctx.clock.now();
  await ctx.db.transaction(async (tx) => {
    const partner = await lockPartner(tx, data.partnerId);
    const updated = await tx
      .update(schema.partnerDocument)
      .set({
        status: data.decision,
        verifiedAt: now,
        verifiedByUserId: actor.userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.partnerDocument.id, data.documentId),
          eq(schema.partnerDocument.partnerId, partner.id),
          eq(schema.partnerDocument.status, "PENDING"),
        ),
      )
      .returning({ id: schema.partnerDocument.id });
    if (updated.length === 0) throw new DomainError("NOT_FOUND", "Open document not found");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "partner.document_reviewed",
      entityType: "partner",
      entityId: partner.id,
      after: { documentId: data.documentId, decision: data.decision },
      correlationId: ctx.correlationId,
    });
  });
}

const partnerIdInput = z.strictObject({ partnerId: z.uuid() });

export interface PartnerVerificationRules {
  readonly requiredDocumentKinds: readonly DocumentKind[];
  /** Business date (YYYY-MM-DD) against which document validity is checked. */
  readonly today: string;
}

const rulesSchema = z.strictObject({
  requiredDocumentKinds: z.array(z.enum(PARTNER_DOCUMENT_KIND_VALUES)).min(1).max(3),
  today: z.iso.date(),
});

/** Verification by a person: all required documents VERIFIED and valid → ACTIVE. */
export async function verifyAndActivatePartner(
  ctx: ServiceContext,
  input: unknown,
  rulesInput: PartnerVerificationRules,
): Promise<void> {
  const actor = requireManage(ctx);
  const { partnerId } = parseInput(partnerIdInput, input);
  const rules = rulesSchema.parse(rulesInput);
  const now = ctx.clock.now();
  await ctx.db.transaction(async (tx) => {
    const partner = await lockPartner(tx, partnerId);
    if (partner.status === "ACTIVE") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Partner is already active");
    }
    const d = schema.partnerDocument;
    const valid = await tx
      .selectDistinct({ kind: d.kind })
      .from(d)
      .where(
        and(
          eq(d.partnerId, partner.id),
          eq(d.status, "VERIFIED"),
          or(isNull(d.validUntil), gte(d.validUntil, rules.today)),
        ),
      );
    const missing = rules.requiredDocumentKinds.filter((k) => !valid.some((v) => v.kind === k));
    if (missing.length > 0) {
      throw new DomainError("POLICY_VIOLATION", "Required documents are missing", { missing });
    }
    await tx
      .update(schema.partner)
      .set({ status: "ACTIVE", verifiedAt: now, verifiedByUserId: actor.userId, updatedAt: now })
      .where(eq(schema.partner.id, partner.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "partner.verified",
      entityType: "partner",
      entityId: partner.id,
      before: { status: partner.status },
      after: { status: "ACTIVE", documentKinds: rules.requiredDocumentKinds },
      correlationId: ctx.correlationId,
    });
  });
}

const suspendInput = z.strictObject({
  partnerId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
});

/** Suspension stops new assignments (active assignments stay visible for dispatch). */
export async function suspendPartner(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireManage(ctx);
  const data = parseInput(suspendInput, input);
  await ctx.db.transaction(async (tx) => {
    const partner = await lockPartner(tx, data.partnerId);
    if (partner.status === "SUSPENDED") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Partner is already suspended");
    }
    await tx
      .update(schema.partner)
      .set({ status: "SUSPENDED", updatedAt: ctx.clock.now() })
      .where(eq(schema.partner.id, partner.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "partner.suspended",
      entityType: "partner",
      entityId: partner.id,
      before: { status: partner.status },
      after: { status: "SUSPENDED" },
      correlationId: ctx.correlationId,
    });
  });
}

// ------------------------------------------------------------------------------------------
// Read models
// ------------------------------------------------------------------------------------------

const listInput = z.strictObject({
  status: z.enum(["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED"]).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export interface PartnerListItem {
  readonly id: string;
  readonly legalName: string;
  readonly status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED";
  readonly verifiedAt: Date | null;
  readonly serviceRadiusM: number;
  readonly maxConcurrentJobs: number | null;
}

/** Staff see all partners; a partner user only its own partner (OWN scope). */
export async function listPartners(ctx: ServiceContext, input: unknown) {
  const actor = requireActor(ctx.actor);
  const scope = scopeFilterFor(actor, "partner:read");
  const f = parseInput(listInput, input ?? {});
  const p = schema.partner;
  const conditions: SQL[] = [isNull(p.archivedAt)];
  if (scope.kind === "RESTRICTED") {
    if (scope.partnerIds.length === 0)
      return { items: [], total: 0, page: f.page, pageSize: f.pageSize };
    conditions.push(inArray(p.id, [...scope.partnerIds]));
  }
  if (f.status !== undefined) conditions.push(eq(p.status, f.status));
  const where = and(...conditions);
  const [totalRow] = await ctx.db.select({ total: count() }).from(p).where(where);
  const items: PartnerListItem[] = await ctx.db
    .select({
      id: p.id,
      legalName: p.legalName,
      status: p.status,
      verifiedAt: p.verifiedAt,
      serviceRadiusM: p.serviceRadiusM,
      maxConcurrentJobs: p.maxConcurrentJobs,
    })
    .from(p)
    .where(where)
    .orderBy(asc(p.legalName), asc(p.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items, total: totalRow?.total ?? 0, page: f.page, pageSize: f.pageSize };
}

export interface PartnerDetail extends PartnerListItem {
  readonly services: readonly { readonly id: string; readonly name: string }[];
  readonly documents: readonly {
    readonly id: string;
    readonly kind: DocumentKind;
    readonly status: "PENDING" | "VERIFIED" | "REJECTED";
    readonly reference: string | null;
    readonly validUntil: string | null;
    readonly verifiedAt: Date | null;
  }[];
}

/** Partner file; OWN scope for partner users (foreign ids → FORBIDDEN via authorize). */
export async function getPartnerDetail(
  ctx: ServiceContext,
  input: unknown,
): Promise<PartnerDetail> {
  const { partnerId } = parseInput(partnerIdInput, input);
  authorize(ctx.actor, "partner:read", { partnerId });
  const p = schema.partner;
  const [row] = await ctx.db
    .select({
      id: p.id,
      legalName: p.legalName,
      status: p.status,
      verifiedAt: p.verifiedAt,
      serviceRadiusM: p.serviceRadiusM,
      maxConcurrentJobs: p.maxConcurrentJobs,
    })
    .from(p)
    .where(and(eq(p.id, partnerId), isNull(p.archivedAt)))
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Partner not found");
  const [services, documents] = await Promise.all([
    ctx.db
      .select({ id: schema.service.id, name: schema.service.name })
      .from(schema.partnerService)
      .innerJoin(schema.service, eq(schema.service.id, schema.partnerService.serviceId))
      .where(eq(schema.partnerService.partnerId, partnerId))
      .orderBy(asc(schema.service.name)),
    ctx.db
      .select({
        id: schema.partnerDocument.id,
        kind: schema.partnerDocument.kind,
        status: schema.partnerDocument.status,
        reference: schema.partnerDocument.reference,
        validUntil: schema.partnerDocument.validUntil,
        verifiedAt: schema.partnerDocument.verifiedAt,
      })
      .from(schema.partnerDocument)
      .where(eq(schema.partnerDocument.partnerId, partnerId))
      .orderBy(desc(schema.partnerDocument.createdAt)),
  ]);
  return { ...row, services, documents };
}
