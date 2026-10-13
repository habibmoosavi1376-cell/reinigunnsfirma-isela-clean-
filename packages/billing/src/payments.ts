import { recordAudit, type AuditActor } from "@isela/audit";
import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { and, count, desc, eq, inArray, schema, type SQL, type Transaction } from "@isela/database";
import {
  completePrepaymentRefund,
  confirmPrepaymentFromInvoice,
  protectCustomerBookings,
} from "@isela/operations";
import { businessDateOf, lockCustomerFinance, paymentPolicySchema } from "@isela/payment-risk";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { reevaluateCustomer } from "./evaluation.ts";
import {
  applyInvoiceChange,
  applyPaymentChange,
  lockBookingRow,
  lockInvoice,
  lockPayment,
  paymentRefs,
  pgConstraint,
  pgErrorCode,
  requireGlobal,
  type FinanceOptions,
  type InvoiceRow,
  type PaymentRow,
} from "./internal.ts";
import { MAX_AMOUNT_CENTS, allocatePayment, reverseAllocation } from "./money.ts";
import { normalizePaymentReference } from "./references.ts";
import {
  PAYABLE_INVOICE_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_RECORD_STATUSES,
  deriveInvoiceStatus,
  type PaymentMethod,
  type PaymentRecordStatus,
} from "./state-machines.ts";

/*
 * Payments are facts recorded against exactly one invoice. Nothing is ever confirmed
 * automatically: a MANUAL payment (bank transfer seen on the statement) is recorded with a
 * unique reference and confirmed by finance; provider payments are confirmed only by a
 * verified provider event (webhooks.ts). Idempotency:
 * - `idempotency_key` (unique): the same form submission/provider intent never creates a
 *   second payment;
 * - `payment_reference (provider, reference)` (unique): the same bank transaction is never
 *   booked twice;
 * - confirmation is a conditional status change PENDING/AUTHORIZED → CONFIRMED under row
 *   locks, so a payment is applied at most once and an invoice becomes PAID at most once per
 *   payment state.
 * Partial payments are recorded as facts (invoice PARTIALLY_PAID, never PAID); an overpayment
 * applies only the outstanding amount – the excess stays visible for clarification/refund.
 */

export const MANUAL_PROVIDER = "MANUAL";

interface Audit {
  readonly actor: AuditActor;
  readonly actorUserId: string | null;
  readonly now: Date;
  readonly correlationId: string | undefined;
}

function auditOf(ctx: ServiceContext): Audit {
  const actor = requireActor(ctx.actor);
  return {
    actor: auditActorOf(actor),
    actorUserId: actor.userId,
    now: ctx.clock.now(),
    correlationId: ctx.correlationId,
  };
}

const recordInput = z.strictObject({
  invoiceId: z.uuid(),
  amountCents: z.number().int().min(1).max(MAX_AMOUNT_CENTS),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().max(200),
  receivedAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9:._-]+$/),
});

/** Records a received payment (PENDING) with its reference – finance only. */
export async function recordPayment(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ paymentId: string; duplicate: boolean }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(recordInput, input);
  const reference = normalizePaymentReference(data.reference);
  const receivedAt = new Date(data.receivedAt);
  const audit = auditOf(ctx);
  if (receivedAt.getTime() > audit.now.getTime()) {
    throw new DomainError("VALIDATION_FAILED", "The payment date lies in the future");
  }

  const findExisting = async () => {
    const [existing] = await ctx.db
      .select()
      .from(schema.payment)
      .where(eq(schema.payment.idempotencyKey, data.idempotencyKey))
      .limit(1);
    if (existing === undefined) return null;
    if (
      existing.invoiceId !== data.invoiceId ||
      existing.amountCents !== data.amountCents ||
      existing.method !== data.method
    ) {
      throw new DomainError("CONFLICT", "The idempotency key was used for another payment");
    }
    return { paymentId: existing.id, duplicate: true };
  };

  const replay = await findExisting();
  if (replay !== null) return replay;
  try {
    return await ctx.db.transaction(async (tx) => {
      const invoice = await lockInvoice(tx, data.invoiceId);
      if (!PAYABLE_INVOICE_STATUSES.includes(invoice.status)) {
        throw new DomainError("POLICY_VIOLATION", "The invoice does not accept payments", {
          invoiceStatus: invoice.status,
        });
      }
      const [payment] = await tx
        .insert(schema.payment)
        .values({
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          status: "PENDING",
          method: data.method,
          provider: MANUAL_PROVIDER,
          amountCents: data.amountCents,
          currency: invoice.currency,
          idempotencyKey: data.idempotencyKey,
          receivedAt,
          recordedByUserId: actor.userId,
        })
        .returning({ id: schema.payment.id });
      if (payment === undefined) throw new DomainError("CONFLICT", "Payment not recorded");
      await tx.insert(schema.paymentReference).values({
        paymentId: payment.id,
        provider: MANUAL_PROVIDER,
        reference,
        amountCents: data.amountCents,
        currency: invoice.currency,
        receivedAt,
        recordedByUserId: actor.userId,
      });
      await tx.insert(schema.paymentTransition).values({
        paymentId: payment.id,
        fromStatus: null,
        toStatus: "PENDING",
        actorUserId: actor.userId,
        reason: null,
      });
      await recordAudit(tx, {
        actor: audit.actor,
        action: "payment.created",
        entityType: "payment",
        entityId: payment.id,
        // The reference itself stays in payment_reference; the audit only notes it exists.
        after: {
          invoiceId: invoice.id,
          method: data.method,
          amountCents: data.amountCents,
          hasReference: true,
        },
        correlationId: ctx.correlationId,
      });
      return { paymentId: payment.id, duplicate: false };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      const constraint = pgConstraint(error);
      if (constraint === "payment_idempotency_key_uq") {
        const again = await findExisting();
        if (again !== null) return again;
      }
      if (constraint === "payment_reference_provider_uq") {
        throw new DomainError("CONFLICT", "This payment reference has already been recorded", {
          field: "reference",
        });
      }
    }
    throw error;
  }
}

/**
 * Applies a confirmed payment to its invoice (shared by the manual and the provider path).
 * The caller holds the customer-finance lock, the booking, invoice and payment row locks.
 */
export async function applyConfirmation(
  tx: Transaction,
  invoice: InvoiceRow,
  payment: PaymentRow,
  options: FinanceOptions,
  audit: Audit & { readonly providerEventId?: string | null; readonly reason: string | null },
): Promise<{ invoice: InvoiceRow; payment: PaymentRow; excessCents: number }> {
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  const payable = PAYABLE_INVOICE_STATUSES.includes(invoice.status);
  const allocation = payable
    ? allocatePayment({
        grossCents: invoice.grossCents,
        paidCents: invoice.paidCents,
        amountCents: payment.amountCents,
      })
    : { appliedCents: 0, excessCents: payment.amountCents, paidAfterCents: invoice.paidCents };
  const confirmed = await applyPaymentChange(
    tx,
    payment,
    "CONFIRMED",
    { appliedCents: allocation.appliedCents, confirmedAt: audit.now },
    audit,
  );
  let updated = invoice;
  if (allocation.appliedCents > 0) {
    const status = deriveInvoiceStatus({
      status: invoice.status,
      grossCents: invoice.grossCents,
      paidCents: allocation.paidAfterCents,
      dueDate: invoice.dueDate,
      today: businessDateOf(audit.now, options.timeZone),
      graceDays: policy.overdueGraceDays,
    });
    updated = await applyInvoiceChange(
      tx,
      invoice,
      {
        status,
        paidCents: allocation.paidAfterCents,
        paidAt: status === "PAID" ? audit.now : null,
      },
      { ...audit, reason: null },
    );
    if (updated.kind === "PREPAYMENT" && updated.status === "PAID") {
      await confirmPrepaymentFromInvoice(tx, updated.bookingId, updated.invoiceNumber ?? "", audit);
    }
  }
  if (allocation.excessCents > 0) {
    await recordAudit(tx, {
      actor: audit.actor,
      action: "payment.overpayment_detected",
      entityType: "payment",
      entityId: payment.id,
      after: { invoiceId: invoice.id, excessCents: allocation.excessCents },
      correlationId: audit.correlationId,
    });
  }
  return { invoice: updated, payment: confirmed, excessCents: allocation.excessCents };
}

/** Takes an applied amount back (refund completed, chargeback) and re-derives the status. */
async function reverseApplied(
  tx: Transaction,
  invoice: InvoiceRow,
  appliedCents: number,
  options: FinanceOptions,
  audit: Audit & { readonly reason: string | null },
): Promise<InvoiceRow> {
  if (appliedCents === 0) return invoice;
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  const paidAfter = reverseAllocation(invoice.paidCents, appliedCents);
  const status = deriveInvoiceStatus({
    status: invoice.status,
    grossCents: invoice.grossCents,
    paidCents: paidAfter,
    dueDate: invoice.dueDate,
    today: businessDateOf(audit.now, options.timeZone),
    graceDays: policy.overdueGraceDays,
  });
  return applyInvoiceChange(
    tx,
    invoice,
    { status, paidCents: paidAfter, paidAt: status === "PAID" ? invoice.paidAt : null },
    audit,
  );
}

async function lockAll(tx: Transaction, paymentId: string) {
  const refs = await paymentRefs(tx, paymentId);
  await lockCustomerFinance(tx, refs.customerId);
  const booking = await lockBookingRow(tx, refs.bookingId);
  const invoice = await lockInvoice(tx, refs.invoiceId);
  const payment = await lockPayment(tx, paymentId);
  return { booking, invoice, payment };
}

function requireManual(payment: PaymentRow): void {
  // Provider payments change only through verified provider events – no manual shortcut.
  if (payment.provider !== MANUAL_PROVIDER) {
    throw new DomainError("POLICY_VIOLATION", "Provider payments are updated by the provider only");
  }
}

const paymentIdInput = z.strictObject({ paymentId: z.uuid() });
const paymentReasonInput = z.strictObject({
  paymentId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
});

/** PENDING → CONFIRMED for a manual payment (finance, after checking the bank statement). */
export async function confirmPayment(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<{ invoiceStatus: string; excessCents: number }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const { paymentId } = parseInput(paymentIdInput, input);
  const audit = auditOf(ctx);
  const result = await ctx.db.transaction(async (tx) => {
    const { invoice, payment } = await lockAll(tx, paymentId);
    requireManual(payment);
    const applied = await applyConfirmation(tx, invoice, payment, options, {
      ...audit,
      reason: null,
    });
    await reevaluateCustomer(tx, invoice.customerId, "PAYMENT", options, audit);
    return { invoiceStatus: applied.invoice.status, excessCents: applied.excessCents };
  });
  ctx.logger?.info("payment.confirmed", {
    paymentId,
    invoiceStatus: result.invoiceStatus,
    correlationId: ctx.correlationId ?? null,
  });
  return result;
}

/** PENDING/AUTHORIZED → FAILED (e.g. returned transfer); counts as a payment problem. */
export async function failPayment(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(paymentReasonInput, input);
  const audit = auditOf(ctx);
  await ctx.db.transaction(async (tx) => {
    const { invoice, payment } = await lockAll(tx, data.paymentId);
    requireManual(payment);
    await applyPaymentChange(
      tx,
      payment,
      "FAILED",
      { failedAt: audit.now, statusReason: data.reason },
      { ...audit, reason: data.reason },
    );
    await reevaluateCustomer(tx, invoice.customerId, "PAYMENT", options, audit);
  });
}

/**
 * CONFIRMED → REFUND_PENDING. Refunds are only possible for payments of VOID invoices (the
 * booking was cancelled). Partial refunds and the handling of overpayments are owner
 * decisions (CONFIG_REQUIRED) and not offered.
 */
export async function requestRefund(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(paymentReasonInput, input);
  const audit = auditOf(ctx);
  await ctx.db.transaction(async (tx) => {
    const { invoice, payment } = await lockAll(tx, data.paymentId);
    requireManual(payment);
    if (invoice.status !== "VOID") {
      throw new DomainError("POLICY_VIOLATION", "Refunds require a voided invoice");
    }
    await applyPaymentChange(
      tx,
      payment,
      "REFUND_PENDING",
      { statusReason: data.reason },
      { ...audit, reason: data.reason },
    );
  });
}

const refundCompleteInput = z.strictObject({
  paymentId: z.uuid(),
  reference: z.string().max(200),
});

/** REFUND_PENDING → REFUNDED with the reference of the outgoing transfer. */
export async function completeRefund(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(refundCompleteInput, input);
  const reference = normalizePaymentReference(data.reference);
  const audit = auditOf(ctx);
  await ctx.db
    .transaction(async (tx) => {
      const { invoice, payment } = await lockAll(tx, data.paymentId);
      requireManual(payment);
      await tx.insert(schema.paymentReference).values({
        paymentId: payment.id,
        provider: `${MANUAL_PROVIDER}_REFUND`,
        reference,
        amountCents: payment.amountCents,
        currency: payment.currency,
        receivedAt: audit.now,
        recordedByUserId: actor.userId,
      });
      await applyRefundCompleted(tx, invoice, payment, reference, options, audit);
      await reevaluateCustomer(tx, invoice.customerId, "PAYMENT", options, audit);
    })
    .catch((error: unknown) => {
      if (pgErrorCode(error) === "23505") {
        throw new DomainError("CONFLICT", "This refund reference has already been recorded", {
          field: "reference",
        });
      }
      throw error;
    });
}

/**
 * Shared refund completion (manual and provider path): REFUNDED, the applied amount is taken
 * back and – once no payment of the booking is held any more – the prepayment booking is
 * marked REFUNDED.
 */
export async function applyRefundCompleted(
  tx: Transaction,
  invoice: InvoiceRow,
  payment: PaymentRow,
  reference: string,
  options: FinanceOptions,
  audit: Audit & { readonly providerEventId?: string | null },
): Promise<void> {
  await applyPaymentChange(
    tx,
    payment,
    "REFUNDED",
    { appliedCents: 0, refundedAt: audit.now },
    { ...audit, reason: "REFUND_COMPLETED" },
  );
  await reverseApplied(tx, invoice, payment.appliedCents, options, {
    ...audit,
    reason: "REFUND_COMPLETED",
  });
  const [held] = await tx
    .select({ n: count() })
    .from(schema.payment)
    .innerJoin(schema.invoice, eq(schema.invoice.id, schema.payment.invoiceId))
    .where(
      and(
        eq(schema.invoice.bookingId, invoice.bookingId),
        inArray(schema.payment.status, ["CONFIRMED", "REFUND_PENDING"]),
      ),
    );
  if ((held?.n ?? 0) === 0) {
    await completePrepaymentRefund(tx, invoice.bookingId, reference, audit);
  }
}

/** REFUND_PENDING → CONFIRMED (refund aborted). */
export async function abortRefund(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(paymentReasonInput, input);
  const audit = auditOf(ctx);
  await ctx.db.transaction(async (tx) => {
    const { payment } = await lockAll(tx, data.paymentId);
    requireManual(payment);
    await applyPaymentChange(tx, payment, "CONFIRMED", {}, { ...audit, reason: data.reason });
  });
}

/**
 * Shared chargeback effect (manual and provider path): the applied amount is taken back, the
 * invoice is open again, the customer's future credit bookings are switched to prepayment and
 * the affected prepayment booking is marked for review; the risk engine then sees the
 * chargeback (RECENT_CHARGEBACK) for the whole lookback period.
 */
export async function applyChargeback(
  tx: Transaction,
  invoice: InvoiceRow,
  payment: PaymentRow,
  reason: string,
  options: FinanceOptions,
  audit: Audit & { readonly providerEventId?: string | null },
): Promise<void> {
  await applyPaymentChange(
    tx,
    payment,
    "CHARGED_BACK",
    { appliedCents: 0, chargedBackAt: audit.now, statusReason: reason },
    { ...audit, reason },
  );
  if (invoice.status !== "VOID") {
    await reverseApplied(tx, invoice, payment.appliedCents, options, { ...audit, reason });
  }
  await protectCustomerBookings(tx, invoice.customerId, "CHARGEBACK", {
    ...audit,
    flagBookingId: invoice.bookingId,
  });
  await reevaluateCustomer(tx, invoice.customerId, "PAYMENT", options, audit);
}

/** CONFIRMED → CHARGED_BACK (reported by the bank for a manual payment). */
export async function recordChargeback(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(paymentReasonInput, input);
  const audit = auditOf(ctx);
  await ctx.db.transaction(async (tx) => {
    const { invoice, payment } = await lockAll(tx, data.paymentId);
    requireManual(payment);
    await applyChargeback(tx, invoice, payment, data.reason, options, audit);
  });
}

export const paymentListQuerySchema = z.strictObject({
  status: z.enum(PAYMENT_RECORD_STATUSES).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  customerId: z.uuid().optional(),
  invoiceId: z.uuid().optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export interface PaymentListItem {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly status: PaymentRecordStatus;
  readonly method: PaymentMethod;
  readonly provider: string;
  readonly amountCents: number;
  readonly appliedCents: number;
  readonly currency: string;
  readonly receivedAt: Date;
}

/** Back-office payment list (GLOBAL invoice:read). */
export async function listPayments(ctx: ServiceContext, input: unknown) {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "invoice:read");
  const f = parseInput(paymentListQuerySchema, input ?? {});
  const p = schema.payment;
  const conditions: SQL[] = [];
  if (f.status !== undefined) conditions.push(eq(p.status, f.status));
  if (f.method !== undefined) conditions.push(eq(p.method, f.method));
  if (f.customerId !== undefined) conditions.push(eq(p.customerId, f.customerId));
  if (f.invoiceId !== undefined) conditions.push(eq(p.invoiceId, f.invoiceId));
  const where = and(...conditions);
  const [totalRow] = await ctx.db.select({ total: count() }).from(p).where(where);
  const items: PaymentListItem[] = await ctx.db
    .select({
      id: p.id,
      invoiceId: p.invoiceId,
      invoiceNumber: schema.invoice.invoiceNumber,
      customerId: p.customerId,
      customerName: schema.customer.displayName,
      status: p.status,
      method: p.method,
      provider: p.provider,
      amountCents: p.amountCents,
      appliedCents: p.appliedCents,
      currency: p.currency,
      receivedAt: p.receivedAt,
    })
    .from(p)
    .innerJoin(schema.invoice, eq(schema.invoice.id, p.invoiceId))
    .innerJoin(schema.customer, eq(schema.customer.id, p.customerId))
    .where(where)
    .orderBy(desc(p.receivedAt), desc(p.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items, total: totalRow?.total ?? 0, page: f.page, pageSize: f.pageSize };
}
