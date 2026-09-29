import { recordAudit } from "@isela/audit";
import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { and, eq, schema } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import {
  applyBookingTransition,
  findJobOfBooking,
  lockBooking,
  requireGlobal,
} from "./internal.ts";
import { PAYMENT_STATUSES, assertPaymentTransition, type PaymentStatus } from "./state-machines.ts";

/*
 * Payment state of prepayment bookings. There is no payment provider yet: a status is changed
 * only by an authorised finance user (payment:manage, MFA) with a payment reference – e.g.
 * after a bank transfer was seen on the account statement. Nothing is ever confirmed
 * automatically, and there is no simulated success in the production path.
 */

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
    // Confirmed prepayment releases the booking: PENDING_PAYMENT → CONFIRMED (→ SCHEDULED).
    if (data.to === "PAYMENT_CONFIRMED" && booking.status === "PENDING_PAYMENT") {
      const job = await findJobOfBooking(tx, booking.id);
      const options = {
        actor: auditActorOf(actor),
        actorUserId: actor.userId,
        reason: null,
        now,
        correlationId: ctx.correlationId,
      };
      booking = await applyBookingTransition(
        tx,
        booking,
        "CONFIRMED",
        job?.status ?? null,
        options,
      );
      if (job?.status === "ASSIGNED") {
        booking = await applyBookingTransition(tx, booking, "SCHEDULED", job.status, options);
      }
    }
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
