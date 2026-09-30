import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  hasGlobalPermission,
  requireActor,
  scopeFilterFor,
  type ServiceContext,
} from "@isela/auth";
import { and, asc, count, desc, eq, inArray, isNull, schema, type SQL } from "@isela/database";
import {
  evaluateCustomerPaymentTerms,
  lockCustomerFinance,
  paymentPolicySchema,
  recordPaymentRiskEvaluation,
  type PaymentPolicy,
} from "@isela/payment-risk";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { operationsConfigSchema, type OperationsConfig } from "./config.ts";
import {
  applyBookingTransition,
  applyJobTransition,
  findJobOfBooking,
  lockBooking,
  pgErrorCode,
  requireGlobal,
} from "./internal.ts";
import {
  BOOKING_STATUSES,
  paymentRequirementFor,
  type BookingStatus,
  type JobStatus,
  type PaymentRequirement,
  type PaymentStatus,
} from "./state-machines.ts";
import { localTime } from "./time.ts";

/*
 * Bookings. A booking is created only from an ACCEPTED quote by staff with booking:write.
 * Customer, property, address, items and amounts are copied on the server from the stored
 * quote – the browser only chooses the quote, the time window and the duration. The payment
 * requirement comes from the central payment-terms engine over the customer's recorded
 * history (day 6); without an approved credit decision it is always VORKASSE_REQUIRED and the
 * booking waits in PENDING_PAYMENT. An overdue invoice immediately forces prepayment again.
 */

export interface PaymentPolicySnapshot {
  readonly policy: PaymentPolicy;
  /** Version of the `payment.policy` setting (null = code default). */
  readonly version: number | null;
}

const createBookingInput = z.strictObject({
  quoteId: z.uuid(),
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  durationMinutes: z.number().int().min(15).max(1440),
  operationalNotes: z.string().trim().max(2000).optional(),
});

export async function createBookingFromQuote(
  ctx: ServiceContext,
  input: unknown,
  options: { readonly paymentPolicy: PaymentPolicySnapshot; readonly config: OperationsConfig },
): Promise<{ bookingId: string; status: BookingStatus; paymentRequirement: PaymentRequirement }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(createBookingInput, input);
  const config = operationsConfigSchema.parse(options.config);
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  const windowStart = new Date(data.windowStart);
  const windowEnd = new Date(data.windowEnd);
  const now = ctx.clock.now();
  const windowMinutes = (windowEnd.getTime() - windowStart.getTime()) / 60_000;
  if (windowStart.getTime() <= now.getTime()) {
    throw new DomainError("VALIDATION_FAILED", "The time window must be in the future");
  }
  if (windowMinutes <= 0 || windowMinutes > config.maxBookingWindowHours * 60) {
    throw new DomainError("VALIDATION_FAILED", "Invalid time window");
  }
  if (data.durationMinutes > windowMinutes) {
    throw new DomainError("VALIDATION_FAILED", "Duration exceeds the time window");
  }

  const result = await ctx.db
    .transaction(async (tx) => {
      const [quote] = await tx
        .select()
        .from(schema.quote)
        .where(eq(schema.quote.id, data.quoteId))
        .for("update")
        .limit(1);
      if (quote === undefined) throw new DomainError("NOT_FOUND", "Quote not found");
      // Only an accepted quote becomes a booking – never a declined, expired or cancelled one.
      if (quote.status !== "ACCEPTED") {
        throw new DomainError("POLICY_VIOLATION", "Only accepted quotes can be booked", {
          quoteStatus: quote.status,
        });
      }
      if (quote.grossCents <= 0) {
        throw new DomainError("POLICY_VIOLATION", "The quote has no billable amount");
      }
      const [existing] = await tx
        .select({ id: schema.booking.id })
        .from(schema.booking)
        .where(eq(schema.booking.quoteId, quote.id))
        .limit(1);
      if (existing !== undefined) {
        throw new DomainError("CONFLICT", "A booking already exists for this quote");
      }
      if (quote.propertyId === null) {
        throw new DomainError("VALIDATION_FAILED", "The quote has no property");
      }
      const [property] = await tx
        .select({ id: schema.property.id, addressId: schema.property.addressId })
        .from(schema.property)
        .where(
          and(
            eq(schema.property.id, quote.propertyId),
            eq(schema.property.customerId, quote.customerId),
            isNull(schema.property.archivedAt),
            eq(schema.property.active, true),
          ),
        )
        .limit(1);
      if (property === undefined) {
        throw new DomainError("NOT_FOUND", "Property not found for this customer");
      }
      const [customer] = await tx
        .select({
          status: schema.customer.status,
          duplicateReviewStatus: schema.customer.duplicateReviewStatus,
          kind: schema.customer.kind,
        })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, quote.customerId), isNull(schema.customer.archivedAt)))
        .limit(1);
      if (customer === undefined) throw new DomainError("NOT_FOUND", "Customer not found");
      if (customer.status === "BLOCKED") {
        throw new DomainError("POLICY_VIOLATION", "The customer is blocked");
      }
      const items = await tx
        .select()
        .from(schema.quoteItem)
        .where(eq(schema.quoteItem.quoteId, quote.id))
        .orderBy(asc(schema.quoteItem.position));
      if (items.length === 0) throw new DomainError("POLICY_VIOLATION", "The quote has no items");

      // Payment risk: history is derived on the server from recorded invoices, payments and
      // credit decisions (never from input), serialised per customer.
      await lockCustomerFinance(tx, quote.customerId);
      const evaluation = await evaluateCustomerPaymentTerms(tx, quote.customerId, {
        policy,
        now,
        timeZone: config.timeZone,
        requestedAmountCents: quote.grossCents,
      });
      const decision = evaluation.decision;
      if (decision.outcome === "BLOCKED") {
        throw new DomainError("POLICY_VIOLATION", "The customer is blocked");
      }
      await recordPaymentRiskEvaluation(tx, {
        customerId: quote.customerId,
        evaluation,
        policyVersion: options.paymentPolicy.version,
        trigger: "BOOKING",
        actorUserId: actor.userId,
        now,
      });
      const paymentRequirement = paymentRequirementFor(decision);
      const initialPayment: PaymentStatus | null =
        paymentRequirement === "VORKASSE_REQUIRED" ? "PAYMENT_REQUIRED" : null;
      const [booking] = await tx
        .insert(schema.booking)
        .values({
          customerId: quote.customerId,
          propertyId: property.id,
          addressId: property.addressId,
          quoteId: quote.id,
          source: "QUOTE",
          status: "REQUESTED",
          requestedDate: localTime(windowStart, config.timeZone).date,
          windowStart,
          windowEnd,
          durationMinutes: data.durationMinutes,
          currency: quote.currency,
          netCents: quote.netCents,
          taxCents: quote.taxCents,
          grossCents: quote.grossCents,
          paymentRequirement,
          paymentStatus: initialPayment,
          paymentDecision: {
            outcome: decision.outcome,
            terms: decision.terms,
            reasons: [...decision.reasons],
            invoiceReviewEligible: decision.invoiceReviewEligible,
            policyVersion: options.paymentPolicy.version,
          },
          operationalNotes:
            data.operationalNotes === undefined || data.operationalNotes === ""
              ? null
              : data.operationalNotes,
          createdByUserId: actor.userId,
        })
        .returning();
      if (booking === undefined) throw new DomainError("CONFLICT", "Booking could not be created");
      await tx.insert(schema.bookingItem).values(
        items.map((item) => ({
          bookingId: booking.id,
          position: item.position,
          quoteItemId: item.id,
          serviceCategoryId: item.serviceCategoryId,
          serviceId: item.serviceId,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unitPriceCents: item.unitPriceCents,
          taxRateBasisPoints: item.taxRateBasisPoints,
          netCents: item.netCents,
          taxCents: item.taxCents,
          grossCents: item.grossCents,
        })),
      );
      await tx.insert(schema.bookingStatusTransition).values({
        bookingId: booking.id,
        fromStatus: null,
        toStatus: "REQUESTED",
        actorUserId: actor.userId,
        reason: null,
      });
      if (initialPayment !== null) {
        await tx.insert(schema.paymentStatusTransition).values({
          bookingId: booking.id,
          fromStatus: null,
          toStatus: initialPayment,
          actorUserId: actor.userId,
          reference: null,
        });
      }
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "booking.created",
        entityType: "booking",
        entityId: booking.id,
        after: {
          quoteId: quote.id,
          customerId: quote.customerId,
          propertyId: property.id,
          grossCents: quote.grossCents,
          paymentRequirement,
          paymentReasons: [...decision.reasons],
        },
        correlationId: ctx.correlationId,
      });
      const next = await applyBookingTransition(
        tx,
        booking,
        paymentRequirement === "VORKASSE_REQUIRED" ? "PENDING_PAYMENT" : "CONFIRMED",
        null,
        {
          actor: auditActorOf(actor),
          actorUserId: actor.userId,
          reason: null,
          now,
          correlationId: ctx.correlationId,
        },
      );
      return { bookingId: booking.id, status: next.status, paymentRequirement };
    })
    .catch((error: unknown) => {
      // Two concurrent conversions of the same quote: the unique index decides.
      if (pgErrorCode(error) === "23505") {
        throw new DomainError("CONFLICT", "A booking already exists for this quote");
      }
      throw error;
    });
  ctx.logger?.info("booking.created", {
    bookingId: result.bookingId,
    status: result.status,
    paymentRequirement: result.paymentRequirement,
    correlationId: ctx.correlationId ?? null,
  });
  return result;
}

const cancelInput = z.strictObject({
  bookingId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
});

/**
 * Cancels a booking (before the job started). An open job is cancelled with it and its
 * assignment released. Payments are not touched: refunds are a separate, audited finance step.
 */
export async function cancelBooking(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(cancelInput, input);
  const now = ctx.clock.now();
  await ctx.db.transaction(async (tx) => {
    const booking = await lockBooking(tx, data.bookingId);
    const job = await findJobOfBooking(tx, booking.id);
    const options = {
      actor: auditActorOf(actor),
      actorUserId: actor.userId,
      reason: data.reason,
      now,
      correlationId: ctx.correlationId,
    };
    const cancelled = await applyBookingTransition(
      tx,
      booking,
      "CANCELLED",
      job?.status ?? null,
      options,
    );
    if (job !== null && job.status !== "CANCELLED") {
      const released = await tx
        .update(schema.jobAssignment)
        .set({
          status: "RELEASED",
          releasedAt: now,
          releasedByUserId: actor.userId,
          releaseReason: "Buchung storniert",
        })
        .where(
          and(eq(schema.jobAssignment.jobId, job.id), eq(schema.jobAssignment.status, "ACTIVE")),
        )
        .returning({ id: schema.jobAssignment.id });
      await applyJobTransition(
        tx,
        job,
        "CANCELLED",
        { hasActiveAssignment: false, booking: cancelled },
        options,
      );
      if (released.length > 0) {
        await recordAudit(tx, {
          actor: auditActorOf(actor),
          action: "job.assignment_released",
          entityType: "job",
          entityId: job.id,
          after: { reason: "BOOKING_CANCELLED" },
          correlationId: ctx.correlationId,
        });
      }
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "booking.cancelled",
      entityType: "booking",
      entityId: booking.id,
      before: { status: booking.status, paymentStatus: booking.paymentStatus },
      after: { status: "CANCELLED", jobCancelled: job !== null },
      correlationId: ctx.correlationId,
    });
  });
}

// ------------------------------------------------------------------------------------------
// Read models
// ------------------------------------------------------------------------------------------

export interface BookingItemView {
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unit: "HOUR" | "SQUARE_METER" | "FLAT" | "UNIT";
  readonly unitPriceCents: number;
  readonly taxRateBasisPoints: number;
  readonly netCents: number;
  readonly taxCents: number;
  readonly grossCents: number;
}

/** Customer-facing booking: no staff, partners, internal notes, costs or margins. */
export interface CustomerBookingView {
  readonly id: string;
  readonly status: BookingStatus;
  readonly propertyName: string;
  readonly addressLine: string;
  readonly requestedDate: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly durationMinutes: number;
  readonly currency: string;
  readonly netCents: number;
  readonly taxCents: number;
  readonly grossCents: number;
  readonly paymentRequirement: PaymentRequirement;
  readonly paymentStatus: PaymentStatus | null;
  readonly items: readonly BookingItemView[];
}

export interface StaffBookingView extends CustomerBookingView {
  readonly customerId: string;
  readonly customerName: string;
  readonly propertyId: string;
  readonly quoteId: string | null;
  readonly source: "QUOTE";
  readonly paymentDecision: Readonly<Record<string, unknown>>;
  /** Payment protection applied – finance must clear the review before the job starts. */
  readonly paymentReviewRequired: boolean;
  readonly operationalNotes: string | null;
  readonly cancellationReason: string | null;
  readonly createdAt: Date;
  readonly job: { readonly id: string; readonly status: JobStatus } | null;
  readonly history: readonly {
    readonly kind: "BOOKING" | "PAYMENT";
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly actorName: string | null;
    readonly note: string | null;
    readonly createdAt: Date;
  }[];
}

const bookingIdInput = z.strictObject({ bookingId: z.uuid() });

async function loadBookingRow(ctx: ServiceContext, bookingId: string) {
  const b = schema.booking;
  const a = schema.customerAddress;
  const [row] = await ctx.db
    .select({
      booking: b,
      customerName: schema.customer.displayName,
      propertyName: schema.property.name,
      street: a.street,
      houseNumber: a.houseNumber,
      postalCode: a.postalCode,
      city: a.city,
    })
    .from(b)
    .innerJoin(schema.customer, eq(schema.customer.id, b.customerId))
    .innerJoin(schema.property, eq(schema.property.id, b.propertyId))
    .innerJoin(a, eq(a.id, b.addressId))
    .where(eq(b.id, bookingId))
    .limit(1);
  return row;
}

async function loadItems(ctx: ServiceContext, bookingId: string): Promise<BookingItemView[]> {
  const i = schema.bookingItem;
  return ctx.db
    .select({
      position: i.position,
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
    .where(eq(i.bookingId, bookingId))
    .orderBy(asc(i.position));
}

function customerView(
  row: NonNullable<Awaited<ReturnType<typeof loadBookingRow>>>,
  items: BookingItemView[],
): CustomerBookingView {
  const b = row.booking;
  return {
    id: b.id,
    status: b.status,
    propertyName: row.propertyName,
    addressLine: `${row.street} ${row.houseNumber}, ${row.postalCode} ${row.city}`,
    requestedDate: b.requestedDate,
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    durationMinutes: b.durationMinutes,
    currency: b.currency,
    netCents: b.netCents,
    taxCents: b.taxCents,
    grossCents: b.grossCents,
    paymentRequirement: b.paymentRequirement,
    paymentStatus: b.paymentStatus,
    items,
  };
}

/** Customer portal: own bookings only; anything else is NOT_FOUND (no id probing). */
export async function getCustomerBooking(
  ctx: ServiceContext,
  input: unknown,
): Promise<CustomerBookingView> {
  const actor = requireActor(ctx.actor);
  const scope = scopeFilterFor(actor, "booking:read");
  const { bookingId } = parseInput(bookingIdInput, input);
  const row = await loadBookingRow(ctx, bookingId);
  if (
    row === undefined ||
    scope.kind !== "RESTRICTED" ||
    !scope.customerIds.includes(row.booking.customerId)
  ) {
    throw new DomainError("NOT_FOUND", "Booking not found");
  }
  return customerView(row, await loadItems(ctx, bookingId));
}

/** Back office: full booking including payment decision, job and history. */
export async function getBooking(ctx: ServiceContext, input: unknown): Promise<StaffBookingView> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const { bookingId } = parseInput(bookingIdInput, input);
  const row = await loadBookingRow(ctx, bookingId);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Booking not found");
  const items = await loadItems(ctx, bookingId);
  const [job] = await ctx.db
    .select({ id: schema.job.id, status: schema.job.status })
    .from(schema.job)
    .where(eq(schema.job.bookingId, bookingId))
    .limit(1);
  const bt = schema.bookingStatusTransition;
  const pt = schema.paymentStatusTransition;
  const [bookingHistory, paymentHistory] = await Promise.all([
    ctx.db
      .select({
        fromStatus: bt.fromStatus,
        toStatus: bt.toStatus,
        actorName: schema.user.name,
        note: bt.reason,
        createdAt: bt.createdAt,
      })
      .from(bt)
      .leftJoin(schema.user, eq(schema.user.id, bt.actorUserId))
      .where(eq(bt.bookingId, bookingId)),
    ctx.db
      .select({
        fromStatus: pt.fromStatus,
        toStatus: pt.toStatus,
        actorName: schema.user.name,
        note: pt.reference,
        createdAt: pt.createdAt,
      })
      .from(pt)
      .leftJoin(schema.user, eq(schema.user.id, pt.actorUserId))
      .where(eq(pt.bookingId, bookingId)),
  ]);
  const history = [
    ...bookingHistory.map((h) => ({ kind: "BOOKING" as const, ...h })),
    ...paymentHistory.map((h) => ({ kind: "PAYMENT" as const, ...h })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const b = row.booking;
  return {
    ...customerView(row, items),
    customerId: b.customerId,
    customerName: row.customerName,
    propertyId: b.propertyId,
    quoteId: b.quoteId,
    source: b.source,
    paymentDecision: b.paymentDecision,
    paymentReviewRequired: b.paymentReviewRequired,
    operationalNotes: b.operationalNotes,
    cancellationReason: b.cancellationReason,
    createdAt: b.createdAt,
    job: job ?? null,
    history,
  };
}

export const bookingListQuerySchema = z.strictObject({
  status: z.enum(BOOKING_STATUSES).optional(),
  customerId: z.uuid().optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export interface BookingListItem {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly propertyName: string;
  readonly status: BookingStatus;
  readonly paymentRequirement: PaymentRequirement;
  readonly paymentStatus: PaymentStatus | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly currency: string;
  readonly grossCents: number;
}

async function queryBookings(
  ctx: ServiceContext,
  conditions: SQL[],
  page: number,
  pageSize: number,
): Promise<{ items: BookingListItem[]; total: number; page: number; pageSize: number }> {
  const b = schema.booking;
  const where = and(...conditions);
  const [totalRow] = await ctx.db.select({ total: count() }).from(b).where(where);
  const items = await ctx.db
    .select({
      id: b.id,
      customerId: b.customerId,
      customerName: schema.customer.displayName,
      propertyName: schema.property.name,
      status: b.status,
      paymentRequirement: b.paymentRequirement,
      paymentStatus: b.paymentStatus,
      windowStart: b.windowStart,
      windowEnd: b.windowEnd,
      currency: b.currency,
      grossCents: b.grossCents,
    })
    .from(b)
    .innerJoin(schema.customer, eq(schema.customer.id, b.customerId))
    .innerJoin(schema.property, eq(schema.property.id, b.propertyId))
    .where(where)
    .orderBy(desc(b.windowStart), desc(b.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items, total: totalRow?.total ?? 0, page, pageSize };
}

/** Back-office list (GLOBAL booking:read). */
export async function listBookings(ctx: ServiceContext, input: unknown) {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const f = parseInput(bookingListQuerySchema, input ?? {});
  const conditions: SQL[] = [];
  if (f.status !== undefined) conditions.push(eq(schema.booking.status, f.status));
  if (f.customerId !== undefined) conditions.push(eq(schema.booking.customerId, f.customerId));
  return queryBookings(ctx, conditions, f.page, f.pageSize);
}

const customerListInput = z.strictObject({
  page: z.number().int().min(1).max(10_000).default(1),
});

/** Customer portal list: only the actor's own customers (OWN scope). */
export async function listCustomerBookings(ctx: ServiceContext, input: unknown) {
  const actor = requireActor(ctx.actor);
  const scope = scopeFilterFor(actor, "booking:read");
  const f = parseInput(customerListInput, input ?? {});
  if (scope.kind !== "RESTRICTED" || scope.customerIds.length === 0) {
    return { items: [], total: 0, page: f.page, pageSize: 25 };
  }
  return queryBookings(
    ctx,
    [inArray(schema.booking.customerId, [...scope.customerIds])],
    f.page,
    25,
  );
}

/** Whether the actor may see internal financial data (costs, margins). */
export function canSeeInternalFinance(ctx: ServiceContext): boolean {
  return hasGlobalPermission(ctx.actor, "finance:internal_read");
}

const quoteIdInput = z.strictObject({ quoteId: z.uuid() });

/** Booking created from a quote, if any (back office, GLOBAL booking:read). */
export async function findBookingForQuote(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ id: string; status: BookingStatus } | null> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const { quoteId } = parseInput(quoteIdInput, input);
  const [row] = await ctx.db
    .select({ id: schema.booking.id, status: schema.booking.status })
    .from(schema.booking)
    .where(eq(schema.booking.quoteId, quoteId))
    .limit(1);
  return row ?? null;
}
