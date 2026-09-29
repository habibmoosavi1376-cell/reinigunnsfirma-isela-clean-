"use server";

import { cancelBooking, createJobForBooking, transitionPaymentStatus } from "@isela/operations";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";

/*
 * Booking actions. Only ids, the target status (validated against the state machine), a
 * payment reference or a reason come from the form; everything else is derived on the server.
 */

function pathOf(bookingId: string): string {
  return `/admin/bookings/${bookingId}`;
}

export async function transitionPaymentAction(form: FormData): Promise<void> {
  const bookingId = formId(form, "bookingId");
  const reference = formField(form, "reference");
  await runAdminAction(
    pathOf(bookingId),
    "payment_changed",
    (ctx) =>
      transitionPaymentStatus(ctx, {
        bookingId,
        to: formField(form, "to"),
        ...(reference === undefined ? {} : { reference }),
      }),
    { revalidate: ["/admin/bookings"] },
  );
}

export async function cancelBookingAction(form: FormData): Promise<void> {
  const bookingId = formId(form, "bookingId");
  await runAdminAction(
    pathOf(bookingId),
    "booking_cancelled",
    (ctx) => cancelBooking(ctx, { bookingId, reason: formField(form, "reason") ?? "" }),
    { revalidate: ["/admin/bookings", "/admin/jobs"] },
  );
}

export async function createJobAction(form: FormData): Promise<void> {
  const bookingId = formId(form, "bookingId");
  await runAdminAction(
    pathOf(bookingId),
    "job_created",
    (ctx) =>
      createJobForBooking(ctx, {
        bookingId,
        operationalNotes: formField(form, "operationalNotes") ?? "",
      }),
    {
      revalidate: ["/admin/jobs"],
      redirectTo: (result) => `/admin/jobs/${(result as { jobId: string }).jobId}`,
    },
  );
}
