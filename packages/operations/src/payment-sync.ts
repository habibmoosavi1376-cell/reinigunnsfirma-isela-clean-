import { recordAudit, type AuditActor } from "@isela/audit";
import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { and, asc, eq, inArray, schema, type Transaction } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import {
  applyBookingTransition,
  findJobOfBooking,
  lockBooking,
  requireGlobal,
  type BookingRow,
} from "./internal.ts";
import {
  JOB_CANCELLABLE,
  assertBookingTransition,
  assertPaymentTransition,
  isPaymentSatisfied,
  type PaymentStatus,
} from "./state-machines.ts";

/*
 * Booking side of the billing workflow (day 6). The billing services call these functions
 * inside their own transaction after they have checked permissions and changed invoices or
 * payments. They are the only code paths that
 * - move a prepayment booking to PAYMENT_CONFIRMED (the DB additionally requires a PAID
 *   prepayment invoice) or REFUNDED,
 * - take credit terms away from not yet started bookings (payment protection).
 */

export interface SyncOptions {
  readonly actor: AuditActor;
  readonly actorUserId: string | null;
  readonly now: Date;
  readonly correlationId: string | undefined;
}

async function setPaymentStatus(
  tx: Transaction,
  booking: BookingRow,
  to: PaymentStatus,
  reference: string,
  options: SyncOptions,
): Promise<BookingRow> {
  const from = booking.paymentStatus;
  if (from === null) throw new DomainError("POLICY_VIOLATION", "This booking has no prepayment");
  assertPaymentTransition(from, to, { bookingStatus: booking.status, reference });
  const [updated] = await tx
    .update(schema.booking)
    .set({ paymentStatus: to, version: booking.version + 1, updatedAt: options.now })
    .where(
      and(
        eq(schema.booking.id, booking.id),
        eq(schema.booking.paymentStatus, from),
        eq(schema.booking.version, booking.version),
      ),
    )
    .returning();
  if (updated === undefined) throw new DomainError("CONFLICT", "Booking was changed concurrently");
  await tx.insert(schema.paymentStatusTransition).values({
    bookingId: booking.id,
    fromStatus: from,
    toStatus: to,
    actorUserId: options.actorUserId,
    reference,
  });
  await recordAudit(tx, {
    actor: options.actor,
    action: "payment.status_changed",
    entityType: "booking",
    entityId: booking.id,
    before: { paymentStatus: from },
    after: { paymentStatus: to, source: "INVOICE" },
    correlationId: options.correlationId,
  });
  return updated;
}

/** Prepayment invoice released: the booking now expects the payment. */
export async function markPrepaymentExpected(
  tx: Transaction,
  bookingId: string,
  invoiceNumber: string,
  options: SyncOptions,
): Promise<void> {
  const booking = await lockBooking(tx, bookingId);
  if (booking.paymentRequirement !== "VORKASSE_REQUIRED" || booking.status === "CANCELLED") return;
  if (booking.paymentStatus === "PAYMENT_REQUIRED" || booking.paymentStatus === "PAYMENT_FAILED") {
    await setPaymentStatus(tx, booking, "PAYMENT_PENDING", invoiceNumber, options);
  }
}

/**
 * The prepayment invoice is fully paid: PAYMENT_CONFIRMED and release of the booking
 * (PENDING_PAYMENT → CONFIRMED, → SCHEDULED when the job is already assigned).
 */
export async function confirmPrepaymentFromInvoice(
  tx: Transaction,
  bookingId: string,
  invoiceNumber: string,
  options: SyncOptions,
): Promise<void> {
  let booking = await lockBooking(tx, bookingId);
  if (booking.paymentRequirement !== "VORKASSE_REQUIRED" || booking.status === "CANCELLED") return;
  if (booking.paymentStatus === "PAYMENT_CONFIRMED") return;
  if (booking.paymentStatus === "PAYMENT_REQUIRED" || booking.paymentStatus === "PAYMENT_FAILED") {
    booking = await setPaymentStatus(tx, booking, "PAYMENT_PENDING", invoiceNumber, options);
  }
  if (booking.paymentStatus !== "PAYMENT_PENDING") return;
  booking = await setPaymentStatus(tx, booking, "PAYMENT_CONFIRMED", invoiceNumber, options);
  if (booking.status === "PENDING_PAYMENT") {
    const job = await findJobOfBooking(tx, booking.id);
    const transition = { ...options, reason: null };
    booking = await applyBookingTransition(
      tx,
      booking,
      "CONFIRMED",
      job?.status ?? null,
      transition,
    );
    if (job?.status === "ASSIGNED") {
      await applyBookingTransition(tx, booking, "SCHEDULED", job.status, transition);
    }
  }
}

/** All payments of a cancelled/completed prepayment booking were refunded. */
export async function completePrepaymentRefund(
  tx: Transaction,
  bookingId: string,
  reference: string,
  options: SyncOptions,
): Promise<void> {
  let booking = await lockBooking(tx, bookingId);
  if (booking.paymentRequirement !== "VORKASSE_REQUIRED") return;
  if (booking.paymentStatus === "PAYMENT_CONFIRMED") {
    booking = await setPaymentStatus(tx, booking, "REFUND_PENDING", reference, options);
  }
  if (booking.paymentStatus === "REFUND_PENDING") {
    await setPaymentStatus(tx, booking, "REFUNDED", reference, options);
  }
}

export type ProtectionCause = "OVERDUE_INVOICE" | "CHARGEBACK" | "CREDIT_TERMS_REVOKED";

/**
 * Payment protection for the customer's future, not yet started bookings:
 * - credit-terms bookings are switched to prepayment (VORKASSE_REQUIRED, PAYMENT_REQUIRED,
 *   booking PENDING_PAYMENT) and marked for review – nothing is deleted or cancelled;
 * - on a chargeback, the affected prepayment booking itself is marked for review.
 * Jobs keep their assignment; the job payment guard (domain + DB) blocks the start until the
 * prepayment is paid and the review is cleared.
 */
export async function protectCustomerBookings(
  tx: Transaction,
  customerId: string,
  cause: ProtectionCause,
  options: SyncOptions & { readonly flagBookingId?: string },
): Promise<{ reverted: string[]; flagged: string[] }> {
  const candidates = await tx
    .select({ id: schema.booking.id })
    .from(schema.booking)
    .where(
      and(
        eq(schema.booking.customerId, customerId),
        inArray(schema.booking.status, ["REQUESTED", "CONFIRMED", "SCHEDULED", "PENDING_PAYMENT"]),
      ),
    )
    .orderBy(asc(schema.booking.id));
  const reverted: string[] = [];
  const flagged: string[] = [];
  for (const { id } of candidates) {
    const booking = await lockBooking(tx, id);
    const job = await findJobOfBooking(tx, booking.id);
    if (job !== null && !JOB_CANCELLABLE.includes(job.status)) continue;
    if (booking.status === "CANCELLED" || booking.status === "COMPLETED") continue;
    if (booking.paymentRequirement === "CREDIT_TERMS_APPROVED") {
      const target = "PENDING_PAYMENT" as const;
      assertBookingTransition(booking.status, target, {
        paymentRequirement: "VORKASSE_REQUIRED",
        paymentStatus: "PAYMENT_REQUIRED",
        jobStatus: job?.status ?? null,
        reason: cause,
      });
      const [updated] = await tx
        .update(schema.booking)
        .set({
          status: target,
          paymentRequirement: "VORKASSE_REQUIRED",
          paymentStatus: "PAYMENT_REQUIRED",
          paymentReviewRequired: true,
          paymentDecision: {
            ...booking.paymentDecision,
            protection: { cause, appliedAt: options.now.toISOString() },
          },
          version: booking.version + 1,
          updatedAt: options.now,
        })
        .where(and(eq(schema.booking.id, booking.id), eq(schema.booking.version, booking.version)))
        .returning({ id: schema.booking.id });
      if (updated === undefined) {
        throw new DomainError("CONFLICT", "Booking was changed concurrently");
      }
      await tx.insert(schema.bookingStatusTransition).values({
        bookingId: booking.id,
        fromStatus: booking.status,
        toStatus: target,
        actorUserId: options.actorUserId,
        reason: cause,
      });
      await tx.insert(schema.paymentStatusTransition).values({
        bookingId: booking.id,
        fromStatus: null,
        toStatus: "PAYMENT_REQUIRED",
        actorUserId: options.actorUserId,
        reference: cause,
      });
      await recordAudit(tx, {
        actor: options.actor,
        action: "booking.payment_protection_applied",
        entityType: "booking",
        entityId: booking.id,
        before: { status: booking.status, paymentRequirement: booking.paymentRequirement },
        after: {
          status: target,
          paymentRequirement: "VORKASSE_REQUIRED",
          paymentStatus: "PAYMENT_REQUIRED",
          reviewRequired: true,
          cause,
        },
        correlationId: options.correlationId,
      });
      reverted.push(booking.id);
    } else if (options.flagBookingId === booking.id && !booking.paymentReviewRequired) {
      await tx
        .update(schema.booking)
        .set({ paymentReviewRequired: true, version: booking.version + 1, updatedAt: options.now })
        .where(and(eq(schema.booking.id, booking.id), eq(schema.booking.version, booking.version)));
      await recordAudit(tx, {
        actor: options.actor,
        action: "booking.payment_review_flagged",
        entityType: "booking",
        entityId: booking.id,
        after: { reviewRequired: true, cause },
        correlationId: options.correlationId,
      });
      flagged.push(booking.id);
    }
  }
  return { reverted, flagged };
}

const clearReviewInput = z.strictObject({
  bookingId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
});

/**
 * Finance clears the payment review of a booking once its payment situation is settled
 * (prepayment confirmed). Server-side, audited, payment:manage only.
 */
export async function clearPaymentReview(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(clearReviewInput, input);
  const now = ctx.clock.now();
  await ctx.db.transaction(async (tx) => {
    const booking = await lockBooking(tx, data.bookingId);
    if (!booking.paymentReviewRequired) {
      throw new DomainError("INVALID_STATE_TRANSITION", "No payment review pending");
    }
    if (!isPaymentSatisfied(booking.paymentRequirement, booking.paymentStatus)) {
      throw new DomainError("POLICY_VIOLATION", "The prepayment has not been confirmed");
    }
    const [updated] = await tx
      .update(schema.booking)
      .set({ paymentReviewRequired: false, version: booking.version + 1, updatedAt: now })
      .where(and(eq(schema.booking.id, booking.id), eq(schema.booking.version, booking.version)))
      .returning({ id: schema.booking.id });
    if (updated === undefined)
      throw new DomainError("CONFLICT", "Booking was changed concurrently");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "booking.payment_review_cleared",
      entityType: "booking",
      entityId: booking.id,
      after: { reviewRequired: false, reason: data.reason },
      correlationId: ctx.correlationId,
    });
  });
}
