"use server";

import { createInvoiceForBooking } from "@isela/billing";
import { cancelBooking, clearPaymentReview, createJobForBooking } from "@isela/operations";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";

/*
 * Booking actions. Only ids, the invoice kind or a reason come from the form; everything else
 * is derived on the server. Payments are confirmed only through the invoice workflow.
 */

function pathOf(bookingId: string): string {
  return `/admin/bookings/${bookingId}`;
}

/**
 * Generates the invoice of the booking on the server (kind from the form, validated against
 * the booking's payment terms; items and amounts are copied from the booking).
 */
export async function createInvoiceAction(form: FormData): Promise<void> {
  const bookingId = formId(form, "bookingId");
  await runAdminAction(
    pathOf(bookingId),
    "invoice_created",
    (ctx) => createInvoiceForBooking(ctx, { bookingId, kind: formField(form, "kind") }),
    {
      revalidate: ["/admin/invoices"],
      redirectTo: (result) => `/admin/invoices/${(result as { invoiceId: string }).invoiceId}`,
    },
  );
}

export async function clearPaymentReviewAction(form: FormData): Promise<void> {
  const bookingId = formId(form, "bookingId");
  await runAdminAction(
    pathOf(bookingId),
    "review_cleared",
    (ctx) => clearPaymentReview(ctx, { bookingId, reason: formField(form, "reason") ?? "" }),
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
