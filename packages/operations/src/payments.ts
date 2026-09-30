import { recordAudit } from "@isela/audit";
import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { and, eq, schema } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { lockBooking, requireGlobal } from "./internal.ts";
import { PAYMENT_STATUSES, assertPaymentTransition, type PaymentStatus } from "./state-machines.ts";

/*
 * Manual payment-status steps of prepayment bookings. Since day 6 a prepayment is CONFIRMED
 * (and refunded) only through the billing workflow: a recorded, confirmed payment that fully
 * pays the booking's prepayment invoice (enforced here and by the database trigger
 * `booking_credit_guard`). The manual path keeps only the non-binding steps "payment expected"
 * and "payment failed"; a reference text alone can no longer confirm a payment.
 */

/** Payment statuses that only the billing workflow may set. */
const BILLING_ONLY_TARGETS: readonly PaymentStatus[] = [
  "PAYMENT_CONFIRMED",
  "REFUND_PENDING",
  "REFUNDED",
];

const transitionInput = z.strictObject({
  bookingId: z.uuid(),
  to: z.enum(PAYMENT_STATUSES),
  reference: z.string().trim().max(200).optional(),
});

export async function transitionPaymentStatus(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ paymentStatus: PaymentStatus; bookingStatus: string }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(transitionInput, input);
  if (BILLING_ONLY_TARGETS.includes(data.to)) {
    throw new DomainError(
      "POLICY_VIOLATION",
      "Payments are confirmed and refunded only through the invoice payment workflow",
      { guard: "PAYMENT_HISTORY" },
    );
  }
  const reference = data.reference === undefined || data.reference === "" ? null : data.reference;
  const now = ctx.clock.now();
  const result = await ctx.db.transaction(async (tx) => {
    let booking = await lockBooking(tx, data.bookingId);
    if (booking.paymentRequirement !== "VORKASSE_REQUIRED" || booking.paymentStatus === null) {
      throw new DomainError("POLICY_VIOLATION", "This booking has no prepayment");
    }
    const from = booking.paymentStatus;
    assertPaymentTransition(from, data.to, { bookingStatus: booking.status, reference });
    const [updated] = await tx
      .update(schema.booking)
      .set({ paymentStatus: data.to, version: booking.version + 1, updatedAt: now })
      .where(
        and(
          eq(schema.booking.id, booking.id),
          eq(schema.booking.paymentStatus, from),
          eq(schema.booking.version, booking.version),
        ),
      )
      .returning();
    if (updated === undefined) {
      throw new DomainError("CONFLICT", "Booking was changed concurrently");
    }
    booking = updated;
    await tx.insert(schema.paymentStatusTransition).values({
      bookingId: booking.id,
      fromStatus: from,
      toStatus: data.to,
      actorUserId: actor.userId,
      reference,
    });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "payment.status_changed",
      entityType: "booking",
      entityId: booking.id,
      before: { paymentStatus: from },
      // The reference is kept in the payment history; the audit only notes that one exists.
      after: { paymentStatus: data.to, hasReference: reference !== null },
      correlationId: ctx.correlationId,
    });
    return { paymentStatus: data.to, bookingStatus: booking.status };
  });
  ctx.logger?.info("payment.status_changed", {
    bookingId: data.bookingId,
    paymentStatus: result.paymentStatus,
    bookingStatus: result.bookingStatus,
    correlationId: ctx.correlationId ?? null,
  });
  return result;
}
