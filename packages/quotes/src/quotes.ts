import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  hasGlobalPermission,
  requireActor,
  scopeFilterFor,
  type Actor,
  type Permission,
  type ServiceContext,
} from "@isela/auth";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  schema,
  type Database,
  type SQL,
  type Transaction,
} from "@isela/database";
import { DomainError, type Clock } from "@isela/shared";
import { parseInput, trimmedText, z } from "@isela/validation";
import { addDays, businessDate, quoteConfigSchema, type QuoteConfig } from "./config.ts";
import { calculateLine, calculateTotals, quantitySchema, unitPriceCentsSchema } from "./pricing.ts";
import {
  CUSTOMER_VISIBLE_QUOTE_STATUSES,
  QUOTE_STATUSES,
  assertQuoteTransition,
  permissionForQuoteTransition,
  type QuoteStatus,
} from "./state-machine.ts";

/*
 * Quote services. Ownership (customer), creator and amounts are always derived on the
 * server: the browser can never set customerId on an existing quote, createdBy, totals or a
 * status. Only DRAFT quotes can be edited; every status change goes through the state machine.
 */

export const SERVICE_UNITS = ["HOUR", "SQUARE_METER", "FLAT", "UNIT"] as const;

/** Staff-only operations need GLOBAL permissions (OWN customer scopes are not enough). */
function requireStaff(actor: Actor, permission: Permission): void {
  if (!hasGlobalPermission(actor, permission)) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission });
  }
}

function assertConfig(config: QuoteConfig): QuoteConfig {
  const parsed = quoteConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new DomainError("CONFIGURATION_ERROR", "Invalid quote configuration");
  }
  return parsed.data;
}

const optionalNotes = z.string().trim().max(4000).optional();

const createQuoteInput = z.strictObject({
  customerId: z.uuid(),
  propertyId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  notes: optionalNotes,
});

export async function createQuoteDraft(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireActor(ctx.actor);
  requireStaff(actor, "quote:write");
  const data = parseInput(createQuoteInput, input);

  return ctx.db.transaction(async (tx) => {
    const [customer] = await tx
      .select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, data.customerId), isNull(schema.customer.archivedAt)))
      .limit(1);
    if (customer === undefined) {
      throw new DomainError("NOT_FOUND", "Customer not found");
    }
    if (data.propertyId !== undefined) {
      await assertPropertyOfCustomer(tx, data.customerId, data.propertyId);
    }
    if (data.leadId !== undefined) {
      // The lead must already be linked to this customer (no foreign leads on a quote).
      const [linked] = await tx
        .select({ id: schema.serviceRequest.id })
        .from(schema.serviceRequest)
        .where(
          and(
            eq(schema.serviceRequest.leadId, data.leadId),
            eq(schema.serviceRequest.customerId, data.customerId),
          ),
        )
        .limit(1);
      if (linked === undefined) {
        throw new DomainError("NOT_FOUND", "Lead not linked to this customer");
      }
    }
    const [row] = await tx
      .insert(schema.quote)
      .values({
        customerId: data.customerId,
        propertyId: data.propertyId ?? null,
        leadId: data.leadId ?? null,
        notes: data.notes === undefined || data.notes === "" ? null : data.notes,
        createdByUserId: actor.userId,
      })
      .returning({ id: schema.quote.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Quote could not be created");
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "quote.created",
      entityType: "quote",
      entityId: row.id,
      after: {
        customerId: data.customerId,
        propertyId: data.propertyId ?? null,
        leadId: data.leadId ?? null,
      },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

async function assertPropertyOfCustomer(
  tx: Transaction,
  customerId: string,
  propertyId: string,
): Promise<void> {
  const [property] = await tx
    .select({ id: schema.property.id })
    .from(schema.property)
    .where(
      and(
        eq(schema.property.id, propertyId),
        eq(schema.property.customerId, customerId),
        isNull(schema.property.archivedAt),
      ),
    )
    .limit(1);
  if (property === undefined) {
    throw new DomainError("NOT_FOUND", "Property not found for this customer");
  }
}

type QuoteRow = typeof schema.quote.$inferSelect;

async function lockQuote(tx: Transaction, quoteId: string): Promise<QuoteRow> {
  const [row] = await tx
    .select()
    .from(schema.quote)
    .where(eq(schema.quote.id, quoteId))
    .for("update")
    .limit(1);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Quote not found");
  }
  return row;
}

function assertDraft(quote: QuoteRow): void {
  if (quote.status !== "DRAFT") {
    throw new DomainError("INVALID_STATE_TRANSITION", "Only draft quotes can be edited", {
      status: quote.status,
    });
  }
}

/** Recomputes the quote totals from its items (server-side only). */
async function recalculateTotals(tx: Transaction, quoteId: string, now: Date): Promise<void> {
  const items = await tx
    .select({
      netCents: schema.quoteItem.netCents,
      taxRateBasisPoints: schema.quoteItem.taxRateBasisPoints,
    })
    .from(schema.quoteItem)
    .where(eq(schema.quoteItem.quoteId, quoteId));
  const totals = calculateTotals(items);
  await tx
    .update(schema.quote)
    .set({
      netCents: totals.netCents,
      taxCents: totals.taxCents,
      grossCents: totals.grossCents,
      updatedAt: now,
    })
    .where(eq(schema.quote.id, quoteId));
}

const addItemInput = z.strictObject({
  quoteId: z.uuid(),
  serviceCategoryId: z.uuid(),
  serviceId: z.uuid().optional(),
  description: trimmedText(500),
  quantity: quantitySchema,
  unit: z.enum(SERVICE_UNITS),
  unitPriceCents: unitPriceCentsSchema,
  taxRateBasisPoints: z.number().int().min(0).max(10_000).optional(),
});

export async function addQuoteItem(
  ctx: ServiceContext,
  input: unknown,
  quoteConfig: QuoteConfig,
): Promise<string> {
  const actor = requireActor(ctx.actor);
  requireStaff(actor, "quote:write");
  const data = parseInput(addItemInput, input);
  const config = assertConfig(quoteConfig);
  const taxRate = data.taxRateBasisPoints ?? config.defaultVatRateBasisPoints;
  if (!config.vatRatesBasisPoints.includes(taxRate)) {
    throw new DomainError("VALIDATION_FAILED", "Tax rate is not allowed");
  }

  return ctx.db.transaction(async (tx) => {
    const quote = await lockQuote(tx, data.quoteId);
    assertDraft(quote);
    const [category] = await tx
      .select({ id: schema.serviceCategory.id })
      .from(schema.serviceCategory)
      .where(
        and(
          eq(schema.serviceCategory.id, data.serviceCategoryId),
          eq(schema.serviceCategory.active, true),
        ),
      )
      .limit(1);
    if (category === undefined) {
      throw new DomainError("NOT_FOUND", "Service category not found");
    }
    if (data.serviceId !== undefined) {
      const [service] = await tx
        .select({ unit: schema.service.unit })
        .from(schema.service)
        .where(
          and(
            eq(schema.service.id, data.serviceId),
            eq(schema.service.categoryId, data.serviceCategoryId),
            eq(schema.service.active, true),
          ),
        )
        .limit(1);
      if (service === undefined) {
        throw new DomainError("NOT_FOUND", "Service not found in this category");
      }
      if (service.unit !== data.unit) {
        throw new DomainError("VALIDATION_FAILED", "Unit does not match the service");
      }
    }
    const [stats] = await tx
      .select({ items: count(), lastPosition: max(schema.quoteItem.position) })
      .from(schema.quoteItem)
      .where(eq(schema.quoteItem.quoteId, quote.id));
    if ((stats?.items ?? 0) >= config.maxItemsPerQuote) {
      throw new DomainError("POLICY_VIOLATION", "Maximum number of quote items reached");
    }
    const amounts = calculateLine({
      quantity: data.quantity,
      unitPriceCents: data.unitPriceCents,
      taxRateBasisPoints: taxRate,
    });
    const [item] = await tx
      .insert(schema.quoteItem)
      .values({
        quoteId: quote.id,
        position: (stats?.lastPosition ?? 0) + 1,
        serviceCategoryId: data.serviceCategoryId,
        serviceId: data.serviceId ?? null,
        description: data.description,
        quantity: data.quantity,
        unit: data.unit,
        unitPriceCents: data.unitPriceCents,
        taxRateBasisPoints: taxRate,
        ...amounts,
      })
      .returning({ id: schema.quoteItem.id });
    if (item === undefined) {
      throw new DomainError("CONFLICT", "Quote item could not be created");
    }
    await recalculateTotals(tx, quote.id, ctx.clock.now());
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "quote.item_added",
      entityType: "quote",
      entityId: quote.id,
      after: { itemId: item.id, netCents: amounts.netCents, taxRateBasisPoints: taxRate },
      correlationId: ctx.correlationId,
    });
    return item.id;
  });
}

const removeItemInput = z.strictObject({ quoteId: z.uuid(), itemId: z.uuid() });

export async function removeQuoteItem(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireStaff(actor, "quote:write");
  const data = parseInput(removeItemInput, input);
  await ctx.db.transaction(async (tx) => {
    const quote = await lockQuote(tx, data.quoteId);
    assertDraft(quote);
    const deleted = await tx
      .delete(schema.quoteItem)
      .where(and(eq(schema.quoteItem.id, data.itemId), eq(schema.quoteItem.quoteId, quote.id)))
      .returning({ id: schema.quoteItem.id });
    if (deleted.length === 0) {
      throw new DomainError("NOT_FOUND", "Quote item not found");
    }
    await recalculateTotals(tx, quote.id, ctx.clock.now());
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "quote.item_removed",
      entityType: "quote",
      entityId: quote.id,
      after: { itemId: data.itemId },
      correlationId: ctx.correlationId,
    });
  });
}

const updateDetailsInput = z.strictObject({
  quoteId: z.uuid(),
  propertyId: z.uuid().nullable().optional(),
  validUntil: z.iso.date().nullable().optional(),
  notes: optionalNotes,
});

export async function updateQuoteDetails(
  ctx: ServiceContext,
  input: unknown,
  quoteConfig: QuoteConfig,
): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireStaff(actor, "quote:write");
  const data = parseInput(updateDetailsInput, input);
  const config = assertConfig(quoteConfig);
  await ctx.db.transaction(async (tx) => {
    const quote = await lockQuote(tx, data.quoteId);
    assertDraft(quote);
    const patch: Partial<typeof schema.quote.$inferInsert> = {};
    if (data.propertyId !== undefined) {
      if (data.propertyId !== null) {
        // Owner comes from the stored quote, never from input.
        await assertPropertyOfCustomer(tx, quote.customerId, data.propertyId);
      }
      patch.propertyId = data.propertyId;
    }
    if (data.validUntil !== undefined) {
      if (
        data.validUntil !== null &&
        data.validUntil < businessDate(ctx.clock.now(), config.timeZone)
      ) {
        throw new DomainError("VALIDATION_FAILED", "Validity date must not be in the past");
      }
      patch.validUntil = data.validUntil;
    }
    if (data.notes !== undefined) patch.notes = data.notes === "" ? null : data.notes;
    const changedFields = Object.keys(patch).filter(
      (key) => patch[key as keyof typeof patch] !== quote[key as keyof QuoteRow],
    );
    if (changedFields.length === 0) {
      throw new DomainError("VALIDATION_FAILED", "Nothing to update");
    }
    await tx
      .update(schema.quote)
      .set({ ...patch, updatedAt: ctx.clock.now() })
      .where(eq(schema.quote.id, quote.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "quote.updated",
      entityType: "quote",
      entityId: quote.id,
      // Field names only – notes are free text.
      after: { changedFields },
      correlationId: ctx.correlationId,
    });
  });
}

const transitionInput = z.strictObject({
  quoteId: z.uuid(),
  to: z.enum(QUOTE_STATUSES),
  reason: z.string().trim().max(1000).optional(),
});

async function applyTransition(
  tx: Transaction,
  quote: QuoteRow,
  to: QuoteStatus,
  options: {
    readonly actor: Actor | null;
    readonly reason: string | null;
    readonly now: Date;
    readonly config: QuoteConfig;
    readonly correlationId: string | undefined;
  },
): Promise<void> {
  const [items] = await tx
    .select({ items: count() })
    .from(schema.quoteItem)
    .where(eq(schema.quoteItem.quoteId, quote.id));
  const today = businessDate(options.now, options.config.timeZone);
  const validUntil =
    to === "SENT" && quote.validUntil === null
      ? addDays(today, options.config.validityDays)
      : quote.validUntil;
  assertQuoteTransition(quote.status, to, {
    itemCount: items?.items ?? 0,
    validUntil,
    today,
    reason: options.reason,
    performedBySystem: options.actor === null,
    actorIsCreator: options.actor?.userId === quote.createdByUserId,
    requireFourEyesApproval: options.config.requireFourEyesApproval,
  });

  const patch: Partial<typeof schema.quote.$inferInsert> = {
    status: to,
    updatedAt: options.now,
  };
  if (to === "SENT") {
    patch.validUntil = validUntil;
    patch.sentAt = options.now;
  }
  if (to === "ACCEPTED" || to === "DECLINED" || to === "EXPIRED" || to === "CANCELLED") {
    patch.decidedAt = options.now;
  }
  // Optimistic guard: the row is locked, the status condition documents the invariant.
  const updated = await tx
    .update(schema.quote)
    .set(patch)
    .where(and(eq(schema.quote.id, quote.id), eq(schema.quote.status, quote.status)))
    .returning({ id: schema.quote.id });
  if (updated.length !== 1) {
    throw new DomainError("CONFLICT", "Quote was changed concurrently");
  }
  await tx.insert(schema.quoteStatusTransition).values({
    quoteId: quote.id,
    fromStatus: quote.status,
    toStatus: to,
    actorUserId: options.actor?.userId ?? null,
    reason: options.reason,
  });
  await recordAudit(tx, {
    actor: options.actor === null ? { type: "SYSTEM" } : auditActorOf(options.actor),
    action: "quote.status_changed",
    entityType: "quote",
    entityId: quote.id,
    before: { status: quote.status },
    after: { status: to, ...(to === "SENT" ? { validUntil, grossCents: quote.grossCents } : {}) },
    correlationId: options.correlationId,
  });
}

export async function transitionQuote(
  ctx: ServiceContext,
  input: unknown,
  quoteConfig: QuoteConfig,
): Promise<void> {
  const actor = requireActor(ctx.actor);
  const data = parseInput(transitionInput, input);
  requireStaff(actor, permissionForQuoteTransition(data.to));
  const config = assertConfig(quoteConfig);
  await ctx.db.transaction(async (tx) => {
    const quote = await lockQuote(tx, data.quoteId);
    await applyTransition(tx, quote, data.to, {
      actor,
      reason: data.reason === undefined || data.reason === "" ? null : data.reason,
      now: ctx.clock.now(),
      config,
      correlationId: ctx.correlationId,
    });
  });
}

/** Scheduler job: SENT quotes past their validity date become EXPIRED (system actor). */
export async function expireQuotes(
  db: Database,
  clock: Clock,
  quoteConfig: QuoteConfig,
): Promise<number> {
  const config = assertConfig(quoteConfig);
  const now = clock.now();
  const today = businessDate(now, config.timeZone);
  const due = await db
    .select({ id: schema.quote.id })
    .from(schema.quote)
    .where(and(eq(schema.quote.status, "SENT"), lt(schema.quote.validUntil, today)))
    .limit(500);
  let expired = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const quote = await lockQuote(tx, id);
      // Re-check under the lock: the quote may have been decided in the meantime.
      if (quote.status !== "SENT" || quote.validUntil === null || quote.validUntil >= today) {
        return;
      }
      await applyTransition(tx, quote, "EXPIRED", {
        actor: null,
        reason: null,
        now,
        config,
        correlationId: undefined,
      });
      expired += 1;
    });
  }
  return expired;
}

export interface QuoteItemView {
  readonly id: string;
  readonly position: number;
  readonly serviceCategoryId: string;
  readonly serviceCategoryName: string;
  readonly serviceId: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unit: (typeof SERVICE_UNITS)[number];
  readonly unitPriceCents: number;
  readonly taxRateBasisPoints: number;
  readonly netCents: number;
  readonly taxCents: number;
  readonly grossCents: number;
}

export interface QuoteView {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly propertyId: string | null;
  readonly propertyName: string | null;
  readonly leadId: string | null;
  readonly status: QuoteStatus;
  readonly currency: string;
  readonly netCents: number;
  readonly taxCents: number;
  readonly grossCents: number;
  readonly taxByRate: readonly {
    readonly taxRateBasisPoints: number;
    readonly netCents: number;
    readonly taxCents: number;
  }[];
  readonly validUntil: string | null;
  readonly sentAt: Date | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly QuoteItemView[];
  /** Internal fields – null in the customer view. */
  readonly internal: {
    readonly notes: string | null;
    readonly createdByName: string | null;
    readonly history: readonly {
      readonly fromStatus: QuoteStatus;
      readonly toStatus: QuoteStatus;
      readonly actorName: string | null;
      readonly reason: string | null;
      readonly createdAt: Date;
    }[];
  } | null;
}

const quoteIdInput = z.strictObject({ quoteId: z.uuid() });

/**
 * Staff with GLOBAL quote:read see every quote including internal notes and history.
 * Customers see only their own quotes once released (SENT or later); anything else –
 * foreign quotes, drafts, reviews – is reported as NOT_FOUND so ids cannot be probed.
 */
export async function getQuote(ctx: ServiceContext, input: unknown): Promise<QuoteView> {
  const actor = requireActor(ctx.actor);
  const scope = scopeFilterFor(actor, "quote:read");
  const { quoteId } = parseInput(quoteIdInput, input);
  const q = schema.quote;
  const [row] = await ctx.db
    .select({
      id: q.id,
      customerId: q.customerId,
      customerName: schema.customer.displayName,
      propertyId: q.propertyId,
      propertyName: schema.property.name,
      leadId: q.leadId,
      status: q.status,
      currency: q.currency,
      netCents: q.netCents,
      taxCents: q.taxCents,
      grossCents: q.grossCents,
      validUntil: q.validUntil,
      sentAt: q.sentAt,
      decidedAt: q.decidedAt,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      notes: q.notes,
      createdByName: schema.user.name,
    })
    .from(q)
    .innerJoin(schema.customer, eq(schema.customer.id, q.customerId))
    .leftJoin(schema.property, eq(schema.property.id, q.propertyId))
    .leftJoin(schema.user, eq(schema.user.id, q.createdByUserId))
    .where(eq(q.id, quoteId))
    .limit(1);
  const staff = scope.kind === "ALL";
  if (
    row === undefined ||
    (!staff &&
      (!scope.customerIds.includes(row.customerId) ||
        !CUSTOMER_VISIBLE_QUOTE_STATUSES.includes(row.status)))
  ) {
    throw new DomainError("NOT_FOUND", "Quote not found");
  }
  const i = schema.quoteItem;
  const items = await ctx.db
    .select({
      id: i.id,
      position: i.position,
      serviceCategoryId: i.serviceCategoryId,
      serviceCategoryName: schema.serviceCategory.name,
      serviceId: i.serviceId,
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      unitPriceCents: i.unitPriceCents,
      taxRateBasisPoints: i.taxRateBasisPoints,
      netCents: i.netCents,
      taxCents: i.taxCents,
      grossCents: i.grossCents,
    })
    .from(i)
    .innerJoin(schema.serviceCategory, eq(schema.serviceCategory.id, i.serviceCategoryId))
    .where(eq(i.quoteId, quoteId))
    .orderBy(asc(i.position));

  let internal: QuoteView["internal"] = null;
  if (staff) {
    const t = schema.quoteStatusTransition;
    const history = await ctx.db
      .select({
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        actorName: schema.user.name,
        reason: t.reason,
        createdAt: t.createdAt,
      })
      .from(t)
      .leftJoin(schema.user, eq(schema.user.id, t.actorUserId))
      .where(eq(t.quoteId, quoteId))
      .orderBy(desc(t.createdAt), desc(t.id));
    internal = { notes: row.notes, createdByName: row.createdByName, history };
  }
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerName,
    propertyId: row.propertyId,
    propertyName: row.propertyName,
    leadId: row.leadId,
    status: row.status,
    currency: row.currency,
    netCents: row.netCents,
    taxCents: row.taxCents,
    grossCents: row.grossCents,
    validUntil: row.validUntil,
    sentAt: row.sentAt,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    taxByRate: calculateTotals(items).taxByRate,
    items,
    internal,
  };
}

export const quoteListQuerySchema = z.strictObject({
  status: z.enum(QUOTE_STATUSES).optional(),
  customerId: z.uuid().optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export interface QuoteListItem {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly propertyName: string | null;
  readonly status: QuoteStatus;
  readonly currency: string;
  readonly grossCents: number;
  readonly validUntil: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Lists quotes within the actor's scope (customers: own, released quotes only). */
export async function listQuotes(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ items: QuoteListItem[]; total: number; page: number; pageSize: number }> {
  const actor = requireActor(ctx.actor);
  const scope = scopeFilterFor(actor, "quote:read");
  const f = parseInput(quoteListQuerySchema, input ?? {});
  const q = schema.quote;
  const conditions: SQL[] = [];
  if (scope.kind === "RESTRICTED") {
    if (scope.customerIds.length === 0) {
      return { items: [], total: 0, page: f.page, pageSize: f.pageSize };
    }
    conditions.push(inArray(q.customerId, [...scope.customerIds]));
    conditions.push(inArray(q.status, [...CUSTOMER_VISIBLE_QUOTE_STATUSES]));
  }
  if (f.status !== undefined) conditions.push(eq(q.status, f.status));
  if (f.customerId !== undefined) conditions.push(eq(q.customerId, f.customerId));
  const where = and(...conditions);
  const [totalRow] = await ctx.db.select({ total: count() }).from(q).where(where);
  const items = await ctx.db
    .select({
      id: q.id,
      customerId: q.customerId,
      customerName: schema.customer.displayName,
      propertyName: schema.property.name,
      status: q.status,
      currency: q.currency,
      grossCents: q.grossCents,
      validUntil: q.validUntil,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
    })
    .from(q)
    .innerJoin(schema.customer, eq(schema.customer.id, q.customerId))
    .leftJoin(schema.property, eq(schema.property.id, q.propertyId))
    .where(where)
    .orderBy(desc(q.createdAt), desc(q.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items, total: totalRow?.total ?? 0, page: f.page, pageSize: f.pageSize };
}

export interface QuoteServiceOptions {
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly services: readonly {
    readonly id: string;
    readonly categoryId: string;
    readonly name: string;
    readonly unit: (typeof SERVICE_UNITS)[number];
  }[];
}

/** Active catalogue entries that can be used for quote items (staff with quote:write). */
export async function listQuoteServiceOptions(ctx: ServiceContext): Promise<QuoteServiceOptions> {
  const actor = requireActor(ctx.actor);
  requireStaff(actor, "quote:write");
  const [categories, services] = await Promise.all([
    ctx.db
      .select({ id: schema.serviceCategory.id, name: schema.serviceCategory.name })
      .from(schema.serviceCategory)
      .where(eq(schema.serviceCategory.active, true))
      .orderBy(asc(schema.serviceCategory.sortOrder), asc(schema.serviceCategory.key)),
    ctx.db
      .select({
        id: schema.service.id,
        categoryId: schema.service.categoryId,
        name: schema.service.name,
        unit: schema.service.unit,
      })
      .from(schema.service)
      .where(eq(schema.service.active, true))
      .orderBy(asc(schema.service.name)),
  ]);
  return { categories, services };
}
