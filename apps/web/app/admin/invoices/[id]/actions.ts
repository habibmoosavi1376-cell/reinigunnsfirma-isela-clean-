"use server";

import {
  abortRefund,
  cancelDraftInvoice,
  changeInvoiceDueDate,
  completeRefund,
  confirmPayment,
  failPayment,
  issueInvoice,
  recordChargeback,
  recordPayment,
  releaseInvoice,
  requestRefund,
  voidInvoice,
} from "@isela/billing";
import { parseMoneyToCents } from "@/lib/admin/format";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
import { loadFinanceOptions } from "@/lib/server/finance";

/*
 * Invoice and payment actions. The form supplies ids, an amount, a method, a reference, a
 * date, an idempotency key or a reason – invoice numbers, amounts due, statuses and the
 * allocation are always derived on the server. Every action authorises (RBAC + MFA) in the
 * billing services.
 */

function pathOf(invoiceId: string): string {
  return `/admin/invoices/${invoiceId}`;
}

const REVALIDATE = ["/admin/invoices", "/admin/payments", "/admin/bookings", "/admin/payment-risk"];

export async function issueInvoiceAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  await runAdminAction(
    pathOf(invoiceId),
    "invoice_issued",
    async (ctx) => issueInvoice(ctx, { invoiceId }, await loadFinanceOptions(ctx.db, ctx.clock)),
    { revalidate: REVALIDATE },
  );
}

export async function releaseInvoiceAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  await runAdminAction(
    pathOf(invoiceId),
    "invoice_released",
    async (ctx) => releaseInvoice(ctx, { invoiceId }, await loadFinanceOptions(ctx.db, ctx.clock)),
    { revalidate: REVALIDATE },
  );
}

export async function cancelDraftAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  await runAdminAction(
    pathOf(invoiceId),
    "invoice_cancelled",
    (ctx) => cancelDraftInvoice(ctx, { invoiceId, reason: formField(form, "reason") ?? "" }),
    { revalidate: REVALIDATE },
  );
}

export async function voidInvoiceAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  await runAdminAction(
    pathOf(invoiceId),
    "invoice_voided",
    (ctx) => voidInvoice(ctx, { invoiceId, reason: formField(form, "reason") ?? "" }),
    { revalidate: REVALIDATE },
  );
}

export async function changeDueDateAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  await runAdminAction(
    pathOf(invoiceId),
    "due_date_changed",
    async (ctx) =>
      changeInvoiceDueDate(
        ctx,
        {
          invoiceId,
          dueDate: formField(form, "dueDate") ?? "",
          reason: formField(form, "reason") ?? "",
        },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}

export async function recordPaymentAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  const amountCents = parseMoneyToCents(formField(form, "amount") ?? "");
  const receivedOn = formField(form, "receivedOn") ?? "";
  await runAdminAction(
    pathOf(invoiceId),
    (result) =>
      (result as { duplicate: boolean }).duplicate ? "payment_duplicate" : "payment_recorded",
    (ctx) =>
      recordPayment(ctx, {
        invoiceId,
        amountCents: amountCents ?? -1,
        method: formField(form, "method"),
        reference: formField(form, "reference") ?? "",
        // A calendar date from the form; the service rejects future dates.
        receivedAt: /^\d{4}-\d{2}-\d{2}$/.test(receivedOn) ? `${receivedOn}T00:00:00Z` : "",
        idempotencyKey: formField(form, "idempotencyKey") ?? "",
      }),
    { revalidate: REVALIDATE },
  );
}

export async function confirmPaymentAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  const paymentId = formId(form, "paymentId");
  await runAdminAction(
    pathOf(invoiceId),
    "payment_confirmed",
    async (ctx) => confirmPayment(ctx, { paymentId }, await loadFinanceOptions(ctx.db, ctx.clock)),
    { revalidate: REVALIDATE },
  );
}

export async function failPaymentAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  const paymentId = formId(form, "paymentId");
  await runAdminAction(
    pathOf(invoiceId),
    "payment_failed",
    async (ctx) =>
      failPayment(
        ctx,
        { paymentId, reason: formField(form, "reason") ?? "" },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}

export async function requestRefundAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  const paymentId = formId(form, "paymentId");
  await runAdminAction(
    pathOf(invoiceId),
    "refund_requested",
    (ctx) => requestRefund(ctx, { paymentId, reason: formField(form, "reason") ?? "" }),
    { revalidate: REVALIDATE },
  );
}

export async function completeRefundAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  const paymentId = formId(form, "paymentId");
  await runAdminAction(
    pathOf(invoiceId),
    "refund_completed",
    async (ctx) =>
      completeRefund(
        ctx,
        { paymentId, reference: formField(form, "reference") ?? "" },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}

export async function abortRefundAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  const paymentId = formId(form, "paymentId");
  await runAdminAction(
    pathOf(invoiceId),
    "refund_aborted",
    (ctx) => abortRefund(ctx, { paymentId, reason: formField(form, "reason") ?? "" }),
    { revalidate: REVALIDATE },
  );
}

export async function chargebackAction(form: FormData): Promise<void> {
  const invoiceId = formId(form, "invoiceId");
  const paymentId = formId(form, "paymentId");
  await runAdminAction(
    pathOf(invoiceId),
    "chargeback_recorded",
    async (ctx) =>
      recordChargeback(
        ctx,
        { paymentId, reason: formField(form, "reason") ?? "" },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}
