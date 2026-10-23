import { recordAudit } from "@isela/audit";
import { auditActorOf, requireActor, scopeFilterFor, type ServiceContext } from "@isela/auth";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
  schema,
  sql,
  type SQL,
} from "@isela/database";
import { markPrepaymentExpected } from "@isela/operations";
import { businessDateOf, lockCustomerFinance, paymentPolicySchema } from "@isela/payment-risk";
import { addDays, calculateTotals } from "@isela/quotes";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { billingConfigSchema, missingBillingConfig } from "./config.ts";
import {
  applyInvoiceChange,
  invoiceRefs,
  lockBookingRow,
  lockInvoice,
  pgConstraint,
  pgErrorCode,
  requireGlobal,
  type FinanceOptions,
  type InvoiceRow,
} from "./internal.ts";
import { outstandingCents } from "./money.ts";
import { nextInvoiceNumber } from "./numbering.ts";
import {
  CUSTOMER_VISIBLE_INVOICE_STATUSES,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  deriveInvoiceStatus,
  type InvoiceKind,
  type InvoiceStatus,
  type PaymentMethod,
  type PaymentRecordStatus,
} from "./state-machines.ts";

/*
 * Invoices. An invoice is generated only on the server from a booking – the materialised,
 * ACCEPTED quote – never from browser amounts:
 * - PREPAYMENT: booking on VORKASSE_REQUIRED that still waits for its payment;
 * - FINAL: booking on credit terms whose job is COMPLETED/QUALITY_CHECK/CLOSED.
 * Declined quotes never became bookings; cancelled bookings/jobs are not invoiced (a
 * cancellation-fee policy is an owner decision → not offered). At most one active invoice per
 * booking (domain check + unique index). Items and totals are a snapshot of the booking
 * items; the totals are recomputed with the quote arithmetic and must match the booking and
 * the quote exactly – a divergence is reported, never silently "fixed".
 */

const createInput = z.strictObject({
  bookingId: z.uuid(),
  kind: z.enum(INVOICE_KINDS),
});

export async function createInvoiceForBooking(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ invoiceId: string }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:write");
  const data = parseInput(createInput, input);
  const result = await ctx.db
    .transaction(async (tx) => {
      const booking = await lockBookingRow(tx, data.bookingId);
      await lockCustomerFinance(tx, booking.customerId);
      const [job] = await tx
        .select({ id: schema.job.id, status: schema.job.status })
        .from(schema.job)
        .where(eq(schema.job.bookingId, booking.id))
        .limit(1);
      if (booking.status === "CANCELLED") {
        throw new DomainError("POLICY_VIOLATION", "Cancelled bookings are not invoiced");
      }
      if (data.kind === "PREPAYMENT") {
        if (
          booking.paymentRequirement !== "VORKASSE_REQUIRED" ||
          booking.status !== "PENDING_PAYMENT"
        ) {
          throw new DomainError("POLICY_VIOLATION", "The booking does not wait for a prepayment", {
            bookingStatus: booking.status,
          });
        }
      } else {
        if (booking.paymentRequirement !== "CREDIT_TERMS_APPROVED") {
          throw new DomainError(
            "POLICY_VIOLATION",
            "Prepayment bookings are invoiced with the prepayment invoice",
          );
        }
        if (
          job === undefined ||
          !(["COMPLETED", "QUALITY_CHECK", "CLOSED"] as const).some((s) => s === job.status)
        ) {
          throw new DomainError("POLICY_VIOLATION", "The job has not been completed");
        }
      }
      const [existing] = await tx
        .select({ id: schema.invoice.id })
        .from(schema.invoice)
        .where(
          and(
            eq(schema.invoice.bookingId, booking.id),
            sql`${schema.invoice.status} NOT IN ('CANCELLED', 'VOID')`,
          ),
        )
        .limit(1);
      if (existing !== undefined) {
        throw new DomainError("CONFLICT", "The booking already has an invoice", {
          invoiceId: existing.id,
        });
      }
      const items = await tx
        .select()
        .from(schema.bookingItem)
        .where(eq(schema.bookingItem.bookingId, booking.id))
        .orderBy(asc(schema.bookingItem.position));
      if (items.length === 0) throw new DomainError("CONFLICT", "The booking has no items");
      // Divergence guard: booking items → totals (quote arithmetic) = booking = quote.
      const totals = calculateTotals(items);
      if (
        totals.netCents !== booking.netCents ||
        totals.taxCents !== booking.taxCents ||
        totals.grossCents !== booking.grossCents
      ) {
        throw new DomainError("CONFLICT", "Booking totals diverge from its items", {
          guard: "PRICE_DIVERGENCE",
        });
      }
      if (booking.quoteId !== null) {
        const [quote] = await tx
          .select({ grossCents: schema.quote.grossCents, netCents: schema.quote.netCents })
          .from(schema.quote)
          .where(eq(schema.quote.id, booking.quoteId))
          .limit(1);
        if (
          quote === undefined ||
          quote.grossCents !== booking.grossCents ||
          quote.netCents !== booking.netCents
        ) {
          throw new DomainError("CONFLICT", "Booking totals diverge from the accepted quote", {
            guard: "PRICE_DIVERGENCE",
          });
        }
      }
      const [invoice] = await tx
        .insert(schema.invoice)
        .values({
          kind: data.kind,
          status: "DRAFT",
          customerId: booking.customerId,
          propertyId: booking.propertyId,
          bookingId: booking.id,
          quoteId: booking.quoteId,
          jobId: data.kind === "FINAL" ? (job?.id ?? null) : null,
          paymentTerms: data.kind === "PREPAYMENT" ? "VORKASSE" : "CREDIT_TERMS",
          currency: booking.currency,
          netCents: totals.netCents,
          taxCents: totals.taxCents,
          grossCents: totals.grossCents,
          createdByUserId: actor.userId,
        })
        .returning({ id: schema.invoice.id });
      if (invoice === undefined) throw new DomainError("CONFLICT", "Invoice not created");
      await tx.insert(schema.invoiceItem).values(
        items.map((item) => ({
          invoiceId: invoice.id,
          position: item.position,
          bookingItemId: item.id,
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
      await tx.insert(schema.invoiceStatusTransition).values({
        invoiceId: invoice.id,
        fromStatus: null,
        toStatus: "DRAFT",
        actorUserId: actor.userId,
        reason: null,
      });
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "invoice.created",
        entityType: "invoice",
        entityId: invoice.id,
        after: {
          bookingId: booking.id,
          customerId: booking.customerId,
          kind: data.kind,
          grossCents: totals.grossCents,
        },
        correlationId: ctx.correlationId,
      });
      return { invoiceId: invoice.id };
    })
    .catch((error: unknown) => {
      // Two concurrent generations for the same booking: the unique index decides.
      if (pgErrorCode(error) === "23505" && pgConstraint(error) === "invoice_booking_active_uq") {
        throw new DomainError("CONFLICT", "The booking already has an invoice");
      }
      throw error;
    });
  ctx.logger?.info("invoice.created", {
    invoiceId: result.invoiceId,
    kind: data.kind,
    correlationId: ctx.correlationId ?? null,
  });
  return result;
}

const invoiceIdInput = z.strictObject({ invoiceId: z.uuid() });

function actionOptions(ctx: ServiceContext, reason: string | null) {
  const actor = requireActor(ctx.actor);
  return {
    actor: auditActorOf(actor),
    actorUserId: actor.userId,
    reason,
    now: ctx.clock.now(),
    correlationId: ctx.correlationId,
  };
}

/**
 * DRAFT → ISSUED: assigns the invoice number, issue and due date (server-side, from the
 * versioned billing configuration). Without configuration: CONFIG_REQUIRED.
 */
export async function issueInvoice(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<{ invoiceNumber: string; dueDate: string }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:write");
  const { invoiceId } = parseInput(invoiceIdInput, input);
  const config = billingConfigSchema.parse(options.billing);
  const result = await ctx.db.transaction(async (tx) => {
    const refs = await invoiceRefs(tx, invoiceId);
    const booking = await lockBookingRow(tx, refs.bookingId);
    const invoice = await lockInvoice(tx, invoiceId);
    const missing = missingBillingConfig(config, invoice.kind);
    if (missing.length > 0) {
      throw new DomainError("CONFIG_REQUIRED", "Billing configuration missing", {
        missing: missing.join(","),
      });
    }
    if (booking.status === "CANCELLED") {
      throw new DomainError("POLICY_VIOLATION", "Cancelled bookings are not invoiced");
    }
    if (invoice.kind === "PREPAYMENT" && booking.paymentRequirement !== "VORKASSE_REQUIRED") {
      throw new DomainError("POLICY_VIOLATION", "The booking no longer requires a prepayment");
    }
    const opts = actionOptions(ctx, null);
    const issueDate = businessDateOf(opts.now, options.timeZone);
    const days = invoice.kind === "PREPAYMENT" ? config.prepaymentDueDays : config.paymentTermDays;
    const dueDate = addDays(issueDate, days ?? 0);
    const invoiceNumber = await nextInvoiceNumber(tx, config.invoiceNumberPrefix ?? "", issueDate);
    await applyInvoiceChange(
      tx,
      invoice,
      {
        status: "ISSUED",
        invoiceNumber,
        issueDate,
        dueDate,
        issuedAt: opts.now,
        issuedByUserId: actor.userId,
      },
      opts,
    );
    await recordAudit(tx, {
      actor: opts.actor,
      action: "invoice.issued",
      entityType: "invoice",
      entityId: invoice.id,
      after: { invoiceNumber, issueDate, dueDate, grossCents: invoice.grossCents },
      correlationId: ctx.correlationId,
    });
    return { invoiceNumber, dueDate };
  });
  ctx.logger?.info("invoice.issued", { invoiceId, correlationId: ctx.correlationId ?? null });
  return result;
}

/**
 * ISSUED → OPEN: the invoice is handed to the customer and payment is expected (visible in
 * the customer portal). A prepayment booking moves to PAYMENT_PENDING.
 */
export async function releaseInvoice(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<{ status: InvoiceStatus }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:write");
  const { invoiceId } = parseInput(invoiceIdInput, input);
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  return ctx.db.transaction(async (tx) => {
    const refs = await invoiceRefs(tx, invoiceId);
    await lockBookingRow(tx, refs.bookingId);
    let invoice = await lockInvoice(tx, invoiceId);
    const opts = actionOptions(ctx, null);
    invoice = await applyInvoiceChange(tx, invoice, { status: "OPEN" }, opts);
    const derived = deriveInvoiceStatus({
      status: invoice.status,
      grossCents: invoice.grossCents,
      paidCents: invoice.paidCents,
      dueDate: invoice.dueDate,
      today: businessDateOf(opts.now, options.timeZone),
      graceDays: policy.overdueGraceDays,
    });
    if (derived !== invoice.status) {
      invoice = await applyInvoiceChange(tx, invoice, { status: derived }, opts);
    }
    if (invoice.kind === "PREPAYMENT") {
      await markPrepaymentExpected(tx, invoice.bookingId, invoice.invoiceNumber ?? "", opts);
    }
    return { status: invoice.status };
  });
}

const reasonInput = z.strictObject({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
});

/** DRAFT → CANCELLED (no number was used). */
export async function cancelDraftInvoice(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:write");
  const data = parseInput(reasonInput, input);
  await ctx.db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, data.invoiceId);
    await applyInvoiceChange(tx, invoice, { status: "CANCELLED" }, actionOptions(ctx, data.reason));
  });
}

/**
 * Issued invoice → VOID (the number stays used, never reused). With money already received,
 * only when the booking was cancelled – the payments must then be refunded. Pending payments
 * must be resolved first. A legally required correction document (Stornorechnung/Gutschrift)
 * is an owner/tax-advisor decision and not generated here.
 */
export async function voidInvoice(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:write");
  const data = parseInput(reasonInput, input);
  await ctx.db.transaction(async (tx) => {
    const refs = await invoiceRefs(tx, data.invoiceId);
    const booking = await lockBookingRow(tx, refs.bookingId);
    const invoice = await lockInvoice(tx, data.invoiceId);
    const [pending] = await tx
      .select({ id: schema.payment.id })
      .from(schema.payment)
      .where(
        and(
          eq(schema.payment.invoiceId, invoice.id),
          inArray(schema.payment.status, ["PENDING", "AUTHORIZED"]),
        ),
      )
      .limit(1);
    if (pending !== undefined) {
      throw new DomainError("POLICY_VIOLATION", "Resolve pending payments first");
    }
    if (invoice.paidCents > 0 && booking.status !== "CANCELLED") {
      throw new DomainError(
        "POLICY_VIOLATION",
        "Paid invoices are voided only for cancelled bookings",
      );
    }
    const opts = actionOptions(ctx, data.reason);
    await applyInvoiceChange(
      tx,
      invoice,
      { status: "VOID", voidedAt: opts.now, voidReason: data.reason },
      opts,
    );
    await recordAudit(tx, {
      actor: opts.actor,
      action: "invoice.voided",
      entityType: "invoice",
      entityId: invoice.id,
      before: { status: invoice.status, paidCents: invoice.paidCents },
      after: { status: "VOID" },
      correlationId: ctx.correlationId,
    });
  });
}

const dueDateInput = z.strictObject({
  invoiceId: z.uuid(),
  dueDate: z.iso.date(),
  reason: z.string().trim().min(3).max(1000),
});

/** Manual financial override: changes the due date (audited, reason required). */
export async function changeInvoiceDueDate(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<{ status: InvoiceStatus }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:write");
  const data = parseInput(dueDateInput, input);
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  return ctx.db.transaction(async (tx) => {
    const refs = await invoiceRefs(tx, data.invoiceId);
    await lockCustomerFinance(tx, refs.customerId);
    await lockBookingRow(tx, refs.bookingId);
    let invoice = await lockInvoice(tx, data.invoiceId);
    if (
      !(["ISSUED", "OPEN", "PARTIALLY_PAID", "OVERDUE"] as const).some((s) => s === invoice.status)
    ) {
      throw new DomainError("INVALID_STATE_TRANSITION", "The due date can no longer be changed");
    }
    if (invoice.issueDate === null || data.dueDate < invoice.issueDate) {
      throw new DomainError("VALIDATION_FAILED", "The due date must not precede the issue date");
    }
    if (data.dueDate > addDays(invoice.issueDate, 365)) {
      throw new DomainError("VALIDATION_FAILED", "The due date is too far in the future");
    }
    const opts = actionOptions(ctx, data.reason);
    const before = invoice.dueDate;
    invoice = await applyInvoiceChange(tx, invoice, { dueDate: data.dueDate }, opts);
    const derived = deriveInvoiceStatus({
      status: invoice.status,
      grossCents: invoice.grossCents,
      paidCents: invoice.paidCents,
      dueDate: invoice.dueDate,
      today: businessDateOf(opts.now, options.timeZone),
      graceDays: policy.overdueGraceDays,
    });
    if (derived !== invoice.status) {
      invoice = await applyInvoiceChange(tx, invoice, { status: derived }, opts);
    }
    await recordAudit(tx, {
      actor: opts.actor,
      action: "invoice.due_date_changed",
      entityType: "invoice",
      entityId: invoice.id,
      before: { dueDate: before },
      after: { dueDate: data.dueDate, status: invoice.status, manualOverride: true },
      correlationId: ctx.correlationId,
    });
    return { status: invoice.status };
  });
}

// ------------------------------------------------------------------------------------------
// Read models
// ------------------------------------------------------------------------------------------

export interface InvoiceItemView {
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

export interface CustomerPaymentView {
  readonly id: string;
  readonly status: PaymentRecordStatus;
  readonly method: PaymentMethod;
  readonly amountCents: number;
  readonly receivedAt: Date;
  readonly references: readonly string[];
}

/** Customer-facing invoice: amounts, dates, status and own payments – nothing internal. */
export interface CustomerInvoiceView {
  readonly id: string;
  readonly invoiceNumber: string | null;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly propertyName: string;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly netCents: number;
  readonly taxCents: number;
  readonly grossCents: number;
  readonly paidCents: number;
  readonly outstandingCents: number;
  readonly taxByRate: readonly {
    readonly taxRateBasisPoints: number;
    readonly netCents: number;
    readonly taxCents: number;
  }[];
  readonly items: readonly InvoiceItemView[];
  readonly payments: readonly CustomerPaymentView[];
}

export interface StaffPaymentView extends CustomerPaymentView {
  readonly provider: string;
  readonly appliedCents: number;
  readonly excessCents: number;
  readonly statusReason: string | null;
  readonly recordedByName: string | null;
  readonly confirmedAt: Date | null;
}

export interface StaffInvoiceView extends Omit<CustomerInvoiceView, "payments"> {
  readonly customerId: string;
  readonly customerName: string;
  readonly bookingId: string;
  readonly quoteId: string | null;
  readonly jobId: string | null;
  readonly paymentTerms: "VORKASSE" | "CREDIT_TERMS";
  readonly createdAt: Date;
  readonly issuedAt: Date | null;
  readonly paidAt: Date | null;
  readonly voidReason: string | null;
  readonly version: number;
  readonly payments: readonly StaffPaymentView[];
  readonly history: readonly {
    readonly fromStatus: InvoiceStatus | null;
    readonly toStatus: InvoiceStatus;
    readonly actorName: string | null;
    readonly reason: string | null;
    readonly createdAt: Date;
  }[];
}

async function loadInvoice(ctx: ServiceContext, invoiceId: string) {
  const [row] = await ctx.db
    .select({
      invoice: schema.invoice,
      customerName: schema.customer.displayName,
      propertyName: schema.property.name,
    })
    .from(schema.invoice)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
    .innerJoin(schema.property, eq(schema.property.id, schema.invoice.propertyId))
    .where(eq(schema.invoice.id, invoiceId))
    .limit(1);
  return row;
}

async function loadItems(ctx: ServiceContext, invoiceId: string): Promise<InvoiceItemView[]> {
  const i = schema.invoiceItem;
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
    .where(eq(i.invoiceId, invoiceId))
    .orderBy(asc(i.position));
}

async function loadPayments(ctx: ServiceContext, invoiceId: string): Promise<StaffPaymentView[]> {
  const p = schema.payment;
  const rows = await ctx.db
    .select({
      id: p.id,
      status: p.status,
      method: p.method,
      provider: p.provider,
      amountCents: p.amountCents,
      appliedCents: p.appliedCents,
      receivedAt: p.receivedAt,
      confirmedAt: p.confirmedAt,
      statusReason: p.statusReason,
      recordedByName: schema.user.name,
    })
    .from(p)
    .leftJoin(schema.user, eq(schema.user.id, p.recordedByUserId))
    .where(eq(p.invoiceId, invoiceId))
    .orderBy(asc(p.receivedAt), asc(p.id));
  const refs =
    rows.length === 0
      ? []
      : await ctx.db
          .select({
            paymentId: schema.paymentReference.paymentId,
            reference: schema.paymentReference.reference,
          })
          .from(schema.paymentReference)
          .where(
            inArray(
              schema.paymentReference.paymentId,
              rows.map((r) => r.id),
            ),
          );
  return rows.map((row) => ({
    ...row,
    excessCents: row.status === "CONFIRMED" ? row.amountCents - row.appliedCents : 0,
    references: refs.filter((r) => r.paymentId === row.id).map((r) => r.reference),
  }));
}

function customerView(
  row: NonNullable<Awaited<ReturnType<typeof loadInvoice>>>,
  items: InvoiceItemView[],
  payments: StaffPaymentView[],
): CustomerInvoiceView {
  const inv: InvoiceRow = row.invoice;
  const totals = calculateTotals(items);
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    kind: inv.kind,
    status: inv.status,
    propertyName: row.propertyName,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    currency: inv.currency,
    netCents: inv.netCents,
    taxCents: inv.taxCents,
    grossCents: inv.grossCents,
    paidCents: inv.paidCents,
    outstandingCents:
      inv.status === "VOID" || inv.status === "CANCELLED"
        ? 0
        : outstandingCents(inv.grossCents, inv.paidCents),
    taxByRate: totals.taxByRate,
    items,
    payments: payments.map((p) => ({
      id: p.id,
      status: p.status,
      method: p.method,
      amountCents: p.amountCents,
      receivedAt: p.receivedAt,
      references: p.references,
    })),
  };
}

/** Back office (GLOBAL invoice:read): invoice with payments and history. */
export async function getInvoice(ctx: ServiceContext, input: unknown): Promise<StaffInvoiceView> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:read");
  const { invoiceId } = parseInput(invoiceIdInput, input);
  const row = await loadInvoice(ctx, invoiceId);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Invoice not found");
  const [items, payments] = await Promise.all([
    loadItems(ctx, invoiceId),
    loadPayments(ctx, invoiceId),
  ]);
  const t = schema.invoiceStatusTransition;
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
    .where(eq(t.invoiceId, invoiceId))
    .orderBy(desc(t.createdAt), desc(t.id));
  const inv = row.invoice;
  return {
    ...customerView(row, items, payments),
    customerId: inv.customerId,
    customerName: row.customerName,
    bookingId: inv.bookingId,
    quoteId: inv.quoteId,
    jobId: inv.jobId,
    paymentTerms: inv.paymentTerms,
    createdAt: inv.createdAt,
    issuedAt: inv.issuedAt,
    paidAt: inv.paidAt,
    voidReason: inv.voidReason,
    version: inv.version,
    payments,
    history,
  };
}

/** Customer portal: own, released invoices only; anything else is NOT_FOUND. */
export async function getCustomerInvoice(
  ctx: ServiceContext,
  input: unknown,
): Promise<CustomerInvoiceView> {
  const actor = requireActor(ctx.actor);
  const scope = scopeFilterFor(actor, "invoice:read");
  const { invoiceId } = parseInput(invoiceIdInput, input);
  const row = await loadInvoice(ctx, invoiceId);
  if (
    row === undefined ||
    scope.kind !== "RESTRICTED" ||
    !scope.customerIds.includes(row.invoice.customerId) ||
    !CUSTOMER_VISIBLE_INVOICE_STATUSES.includes(row.invoice.status)
  ) {
    throw new DomainError("NOT_FOUND", "Invoice not found");
  }
  const [items, payments] = await Promise.all([
    loadItems(ctx, invoiceId),
    loadPayments(ctx, invoiceId),
  ]);
  return customerView(row, items, payments);
}

export const invoiceListQuerySchema = z.strictObject({
  status: z.enum(INVOICE_STATUSES).optional(),
  kind: z.enum(INVOICE_KINDS).optional(),
  customerId: z.uuid().optional(),
  bookingId: z.uuid().optional(),
  /** Only invoices with an outstanding amount past the due date. */
  overdue: z.boolean().optional(),
  dueFrom: z.iso.date().optional(),
  dueTo: z.iso.date().optional(),
  minGrossCents: z.number().int().min(0).max(10_000_000_000).optional(),
  maxGrossCents: z.number().int().min(0).max(10_000_000_000).optional(),
  /** Invoice number (prefix match). */
  number: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Z0-9-]*$/)
    .optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export interface InvoiceListItem {
  readonly id: string;
  readonly invoiceNumber: string | null;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly customerId: string;
  readonly customerName: string;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly grossCents: number;
  readonly paidCents: number;
}

async function queryInvoices(
  ctx: ServiceContext,
  conditions: SQL[],
  page: number,
  pageSize: number,
): Promise<{ items: InvoiceListItem[]; total: number; page: number; pageSize: number }> {
  const i = schema.invoice;
  const where = and(...conditions);
  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(i)
    .innerJoin(schema.customer, eq(schema.customer.id, i.customerId))
    .where(where);
  const items = await ctx.db
    .select({
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      kind: i.kind,
      status: i.status,
      customerId: i.customerId,
      customerName: schema.customer.displayName,
      issueDate: i.issueDate,
      dueDate: i.dueDate,
      currency: i.currency,
      grossCents: i.grossCents,
      paidCents: i.paidCents,
    })
    .from(i)
    .innerJoin(schema.customer, eq(schema.customer.id, i.customerId))
    .where(where)
    .orderBy(desc(i.createdAt), desc(i.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items, total: totalRow?.total ?? 0, page, pageSize };
}

/** Back-office list with filters (GLOBAL invoice:read). */
export async function listInvoices(ctx: ServiceContext, input: unknown, today: string) {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:read");
  const f = parseInput(invoiceListQuerySchema, input ?? {});
  const i = schema.invoice;
  const conditions: SQL[] = [];
  if (f.status !== undefined) conditions.push(eq(i.status, f.status));
  if (f.kind !== undefined) conditions.push(eq(i.kind, f.kind));
  if (f.customerId !== undefined) conditions.push(eq(i.customerId, f.customerId));
  if (f.bookingId !== undefined) conditions.push(eq(i.bookingId, f.bookingId));
  if (f.dueFrom !== undefined) conditions.push(gte(i.dueDate, f.dueFrom));
  if (f.dueTo !== undefined) conditions.push(lte(i.dueDate, f.dueTo));
  if (f.minGrossCents !== undefined) conditions.push(gte(i.grossCents, f.minGrossCents));
  if (f.maxGrossCents !== undefined) conditions.push(lte(i.grossCents, f.maxGrossCents));
  if (f.number !== undefined && f.number !== "") {
    conditions.push(sql`${i.invoiceNumber} LIKE ${`${f.number}%`}`);
  }
  if (f.overdue === true) {
    z.iso.date().parse(today);
    conditions.push(
      sql`(${i.status} = 'OVERDUE' OR (${i.status} IN ('OPEN', 'PARTIALLY_PAID') AND ${i.dueDate} < ${today}::date))`,
    );
  }
  return queryInvoices(ctx, conditions, f.page, f.pageSize);
}

const customerListInput = z.strictObject({
  page: z.number().int().min(1).max(10_000).default(1),
});

/** Customer portal list: own released invoices only (OWN scope). */
export async function listCustomerInvoices(ctx: ServiceContext, input: unknown) {
  const actor = requireActor(ctx.actor);
  const scope = scopeFilterFor(actor, "invoice:read");
  const f = parseInput(customerListInput, input ?? {});
  if (scope.kind !== "RESTRICTED" || scope.customerIds.length === 0) {
    return { items: [], total: 0, page: f.page, pageSize: 25 };
  }
  return queryInvoices(
    ctx,
    [
      inArray(schema.invoice.customerId, [...scope.customerIds]),
      inArray(schema.invoice.status, [...CUSTOMER_VISIBLE_INVOICE_STATUSES]),
    ],
    f.page,
    25,
  );
}

/** Invoices of a booking (back office, e.g. on the booking page). */
export async function listInvoicesForBooking(
  ctx: ServiceContext,
  input: unknown,
): Promise<
  { id: string; invoiceNumber: string | null; kind: InvoiceKind; status: InvoiceStatus }[]
> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:read");
  const { bookingId } = parseInput(z.strictObject({ bookingId: z.uuid() }), input);
  return ctx.db
    .select({
      id: schema.invoice.id,
      invoiceNumber: schema.invoice.invoiceNumber,
      kind: schema.invoice.kind,
      status: schema.invoice.status,
    })
    .from(schema.invoice)
    .where(eq(schema.invoice.bookingId, bookingId))
    .orderBy(desc(schema.invoice.createdAt));
}
