"use server";

import {
  approveCreditTerms,
  denyCreditTerms,
  reevaluateCustomerPaymentTerms,
  requestCreditTerms,
  revokeCreditTerms,
  runOverdueCheck,
} from "@isela/billing";
import { parseMoneyToCents } from "@/lib/admin/format";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
import { loadFinanceOptions } from "@/lib/server/finance";

/*
 * Payment-risk and credit-terms actions. Credit limit, trust assessment, validity and reason
 * come from the form; eligibility, four-eyes, policy bounds and the effect on bookings are
 * decided on the server (billing services).
 */

function pathOf(customerId: string): string {
  return `/admin/payment-risk/${customerId}`;
}

const REVALIDATE = ["/admin/payment-risk", "/admin/bookings", "/admin/invoices"];

export async function runOverdueCheckAction(): Promise<void> {
  await runAdminAction(
    "/admin/payment-risk",
    "overdue_run",
    async (ctx) => runOverdueCheck(ctx, await loadFinanceOptions(ctx.db, ctx.clock)),
    { revalidate: REVALIDATE },
  );
}

export async function reevaluateAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  await runAdminAction(
    pathOf(customerId),
    "risk_reevaluated",
    async (ctx) =>
      reevaluateCustomerPaymentTerms(
        ctx,
        { customerId },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}

export async function requestCreditAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  await runAdminAction(
    pathOf(customerId),
    "credit_requested",
    async (ctx) =>
      requestCreditTerms(
        ctx,
        { customerId, reason: formField(form, "reason") ?? "" },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}

export async function approveCreditAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  const approvalId = formId(form, "approvalId");
  const trust = formField(form, "trustScore") ?? "";
  const validUntil = formField(form, "validUntil");
  await runAdminAction(
    pathOf(customerId),
    "credit_approved",
    async (ctx) =>
      approveCreditTerms(
        ctx,
        {
          approvalId,
          creditLimitCents: parseMoneyToCents(formField(form, "creditLimit") ?? "") ?? -1,
          trustScore: /^\d{1,3}$/.test(trust) ? Number(trust) : -1,
          reason: formField(form, "reason") ?? "",
          ...(validUntil === undefined ? {} : { validUntil }),
        },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}

export async function denyCreditAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  const approvalId = formId(form, "approvalId");
  await runAdminAction(
    pathOf(customerId),
    "credit_denied",
    async (ctx) =>
      denyCreditTerms(
        ctx,
        { approvalId, reason: formField(form, "reason") ?? "" },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}

export async function revokeCreditAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  const approvalId = formId(form, "approvalId");
  await runAdminAction(
    pathOf(customerId),
    "credit_revoked",
    async (ctx) =>
      revokeCreditTerms(
        ctx,
        { approvalId, reason: formField(form, "reason") ?? "" },
        await loadFinanceOptions(ctx.db, ctx.clock),
      ),
    { revalidate: REVALIDATE },
  );
}
