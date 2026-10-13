import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { asc, schema, sql } from "@isela/database";
import { protectCustomerBookings } from "@isela/operations";
import { businessDateOf, lockCustomerFinance, paymentPolicySchema } from "@isela/payment-risk";
import { reevaluateCustomer } from "./evaluation.ts";
import { applyInvoiceChange, lockInvoice, requireGlobal, type FinanceOptions } from "./internal.ts";
import { deriveInvoiceStatus } from "./state-machines.ts";

/*
 * Overdue run. Marks released invoices whose due date (+ grace days of the payment policy)
 * has passed as OVERDUE, re-evaluates the customer's payment terms and applies the payment
 * protection to the customer's not yet started credit-terms bookings (switch to prepayment +
 * review; nothing is deleted or cancelled). History is only appended.
 *
 * The rule "overdue ⇒ new orders only on prepayment" does NOT depend on this run: the central
 * engine counts invoices past their due date directly, so booking creation and job start are
 * protected immediately. The run materialises the status, the audit trail and the protection
 * of future bookings; a scheduler (worker) for it is an open infrastructure item – until then
 * finance triggers it from /admin/payment-risk.
 */

export interface OverdueRunResult {
  readonly invoicesMarkedOverdue: number;
  readonly customersAffected: number;
  readonly bookingsSwitchedToPrepayment: number;
}

export async function runOverdueCheck(
  ctx: ServiceContext,
  options: FinanceOptions,
): Promise<OverdueRunResult> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "credit_terms:request");
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  const now = ctx.clock.now();
  const today = businessDateOf(now, options.timeZone);
  const i = schema.invoice;
  const candidates = await ctx.db
    .select({ id: i.id, customerId: i.customerId })
    .from(i)
    .where(
      sql`${i.status} IN ('OPEN', 'PARTIALLY_PAID') AND ${i.dueDate} + ${policy.overdueGraceDays}::int < ${today}::date`,
    )
    .orderBy(asc(i.customerId), asc(i.id));
  const byCustomer = new Map<string, string[]>();
  for (const row of candidates) {
    byCustomer.set(row.customerId, [...(byCustomer.get(row.customerId) ?? []), row.id]);
  }
  const audit = {
    actor: auditActorOf(actor),
    actorUserId: actor.userId,
    now,
    correlationId: ctx.correlationId,
  };
  let marked = 0;
  let switched = 0;
  // One transaction per customer: a failure for one customer never blocks the others.
  for (const [customerId, invoiceIds] of byCustomer) {
    const result = await ctx.db.transaction(async (tx) => {
      await lockCustomerFinance(tx, customerId);
      let count = 0;
      for (const invoiceId of invoiceIds) {
        const invoice = await lockInvoice(tx, invoiceId);
        const status = deriveInvoiceStatus({
          status: invoice.status,
          grossCents: invoice.grossCents,
          paidCents: invoice.paidCents,
          dueDate: invoice.dueDate,
          today,
          graceDays: policy.overdueGraceDays,
        });
        if (status === "OVERDUE" && invoice.status !== "OVERDUE") {
          await applyInvoiceChange(
            tx,
            invoice,
            { status },
            { ...audit, reason: "DUE_DATE_PASSED" },
          );
          count += 1;
        }
      }
      if (count === 0) return { count, reverted: 0 };
      const { reverted } = await protectCustomerBookings(tx, customerId, "OVERDUE_INVOICE", audit);
      await reevaluateCustomer(tx, customerId, "OVERDUE", options, audit);
      return { count, reverted: reverted.length };
    });
    marked += result.count;
    switched += result.reverted;
  }
  ctx.logger?.info("billing.overdue_run", {
    invoicesMarkedOverdue: marked,
    customersAffected: byCustomer.size,
    bookingsSwitchedToPrepayment: switched,
    correlationId: ctx.correlationId ?? null,
  });
  return {
    invoicesMarkedOverdue: marked,
    customersAffected: byCustomer.size,
    bookingsSwitchedToPrepayment: switched,
  };
}
