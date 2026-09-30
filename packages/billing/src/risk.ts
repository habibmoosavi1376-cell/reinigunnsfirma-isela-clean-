import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { and, desc, eq, schema, sql } from "@isela/database";
import {
  PAYMENT_TERMS_OUTCOMES,
  evaluateCustomerPaymentTerms,
  lockCustomerFinance,
  paymentPolicySchema,
  type PaymentTermsDecision,
  type PaymentTermsOutcome,
} from "@isela/payment-risk";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { reevaluateCustomer } from "./evaluation.ts";
import { requireGlobal, type FinanceOptions } from "./internal.ts";

/*
 * Payment-risk views for finance (payment_risk:read). Everything is computed by the central
 * engine on recorded data; nothing here decides on its own. No internal risk data is ever
 * exposed to customers, staff, partners or dispatchers.
 */

export interface CustomerRiskProfile {
  readonly customerId: string;
  readonly customerName: string;
  readonly customerKind: string;
  readonly decision: PaymentTermsDecision;
  readonly policyVersion: number | null;
  readonly facts: {
    readonly completedJobs: number;
    readonly completedPaidJobs: number;
    readonly failedPayments: number;
    readonly chargebacks: number;
    readonly latePayments: number;
    readonly openInvoices: number;
    readonly openAmountCents: number;
    readonly overdueInvoices: number;
    readonly overdueAmountCents: number;
    readonly exposureCents: number;
  };
  readonly lastEvaluation: {
    readonly outcome: PaymentTermsOutcome;
    readonly reasons: readonly string[];
    readonly trigger: string;
    readonly evaluatedAt: Date;
  } | null;
  readonly approvals: readonly {
    readonly id: string;
    readonly status: "REQUESTED" | "APPROVED" | "DENIED" | "REVOKED";
    readonly requestReason: string;
    readonly requestedByName: string | null;
    readonly requestedByUserId: string;
    readonly requestedAt: Date;
    readonly creditLimitCents: number | null;
    readonly trustScore: number | null;
    readonly validUntil: string | null;
    readonly decidedAt: Date | null;
    readonly decisionReason: string | null;
    readonly revokedAt: Date | null;
    readonly revokeReason: string | null;
  }[];
  readonly pendingReviewBookings: number;
}

const customerInput = z.strictObject({ customerId: z.uuid() });

export async function getCustomerRiskProfile(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<CustomerRiskProfile> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment_risk:read");
  const { customerId } = parseInput(customerInput, input);
  const [customer] = await ctx.db
    .select({ name: schema.customer.displayName, kind: schema.customer.kind })
    .from(schema.customer)
    .where(eq(schema.customer.id, customerId))
    .limit(1);
  if (customer === undefined) throw new DomainError("NOT_FOUND", "Customer not found");
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  const now = ctx.clock.now();
  const { decision, history, businessDate } = await evaluateCustomerPaymentTerms(
    ctx.db,
    customerId,
    { policy, now, timeZone: options.timeZone },
  );
  const stats = await ctx.db.execute(sql`
    SELECT
      (SELECT count(*) FROM "booking" b
        WHERE b."customer_id" = ${customerId} AND b."status" = 'COMPLETED')::int AS "completed_jobs",
      (SELECT count(*) FROM "invoice" i WHERE i."customer_id" = ${customerId}
        AND i."status" IN ('ISSUED', 'OPEN', 'PARTIALLY_PAID', 'OVERDUE'))::int AS "open_invoices",
      (SELECT COALESCE(SUM(i."gross_cents" - i."paid_cents"), 0) FROM "invoice" i
        WHERE i."customer_id" = ${customerId}
          AND i."status" IN ('ISSUED', 'OPEN', 'PARTIALLY_PAID', 'OVERDUE'))::bigint AS "open_amount",
      (SELECT COALESCE(SUM(i."gross_cents" - i."paid_cents"), 0) FROM "invoice" i
        WHERE i."customer_id" = ${customerId}
          AND (i."status" = 'OVERDUE' OR (i."status" IN ('OPEN', 'PARTIALLY_PAID')
            AND i."due_date" + ${policy.overdueGraceDays}::int < ${businessDate}::date)))::bigint
        AS "overdue_amount",
      (SELECT count(*) FROM "booking" b WHERE b."customer_id" = ${customerId}
        AND b."payment_review_required" = true AND b."status" <> 'CANCELLED')::int AS "pending_review"
  `);
  const row = stats.rows[0] ?? {};
  const e = schema.paymentRiskEvaluation;
  const [last] = await ctx.db
    .select({
      outcome: e.outcome,
      reasons: e.reasons,
      trigger: e.trigger,
      evaluatedAt: e.evaluatedAt,
    })
    .from(e)
    .where(eq(e.customerId, customerId))
    .orderBy(desc(e.evaluatedAt), desc(e.id))
    .limit(1);
  const c = schema.creditTermsApproval;
  const approvals = await ctx.db
    .select({
      id: c.id,
      status: c.status,
      requestReason: c.requestReason,
      requestedByName: schema.user.name,
      requestedByUserId: c.requestedByUserId,
      requestedAt: c.requestedAt,
      creditLimitCents: c.creditLimitCents,
      trustScore: c.trustScore,
      validUntil: c.validUntil,
      decidedAt: c.decidedAt,
      decisionReason: c.decisionReason,
      revokedAt: c.revokedAt,
      revokeReason: c.revokeReason,
    })
    .from(c)
    .leftJoin(schema.user, eq(schema.user.id, c.requestedByUserId))
    .where(eq(c.customerId, customerId))
    .orderBy(desc(c.createdAt), desc(c.id))
    .limit(50);
  return {
    customerId,
    customerName: customer.name,
    customerKind: customer.kind,
    decision,
    policyVersion: options.paymentPolicy.version,
    facts: {
      completedJobs: Number(row["completed_jobs"] ?? 0),
      completedPaidJobs: history.completedPaidOrders,
      failedPayments: history.failedPaymentsInLookback,
      chargebacks: history.chargebacksInLookback,
      latePayments: history.latePaymentsInLookback,
      openInvoices: Number(row["open_invoices"] ?? 0),
      openAmountCents: Number(row["open_amount"] ?? 0),
      overdueInvoices: history.openOverdueInvoices,
      overdueAmountCents: Number(row["overdue_amount"] ?? 0),
      exposureCents: history.openExposureCents,
    },
    lastEvaluation: last ?? null,
    approvals,
    pendingReviewBookings: Number(row["pending_review"] ?? 0),
  };
}

export const riskListQuerySchema = z.strictObject({
  outcome: z.enum(PAYMENT_TERMS_OUTCOMES).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
});

export interface RiskListItem {
  readonly customerId: string;
  readonly customerName: string;
  readonly outcome: PaymentTermsOutcome;
  readonly reasons: readonly string[];
  readonly evaluatedAt: Date;
  readonly creditStatus: string | null;
}

/** Customers with a recorded evaluation – latest evaluation per customer. */
export async function listRiskOverview(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ items: RiskListItem[]; page: number; pageSize: number; total: number }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment_risk:read");
  const f = parseInput(riskListQuerySchema, input ?? {});
  const pageSize = 25;
  const outcomeFilter = f.outcome === undefined ? sql`TRUE` : sql`l."outcome" = ${f.outcome}`;
  const latest = sql`
    SELECT DISTINCT ON (e."customer_id") e."customer_id", e."outcome", e."reasons", e."evaluated_at"
    FROM "payment_risk_evaluation" e
    ORDER BY e."customer_id", e."evaluated_at" DESC, e."id" DESC`;
  const [rows, totals] = await Promise.all([
    ctx.db.execute(sql`
      SELECT l."customer_id", c."display_name", l."outcome", l."reasons", l."evaluated_at",
        (SELECT a."status" FROM "credit_terms_approval" a WHERE a."customer_id" = l."customer_id"
          ORDER BY a."created_at" DESC LIMIT 1) AS "credit_status"
      FROM (${latest}) l
      JOIN "customer" c ON c."id" = l."customer_id"
      WHERE ${outcomeFilter}
      ORDER BY l."evaluated_at" DESC, l."customer_id"
      LIMIT ${pageSize} OFFSET ${(f.page - 1) * pageSize}`),
    ctx.db.execute(sql`SELECT count(*)::int AS "n" FROM (${latest}) l WHERE ${outcomeFilter}`),
  ]);
  const items = rows.rows.map((r) => ({
    customerId: String(r["customer_id"]),
    customerName: String(r["display_name"]),
    outcome: r["outcome"] as PaymentTermsOutcome,
    reasons: (r["reasons"] as string[] | null) ?? [],
    evaluatedAt: new Date(String(r["evaluated_at"])),
    creditStatus: (r["credit_status"] as string | null) ?? null,
  }));
  const total = Number((totals.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
  return { items, page: f.page, pageSize, total };
}

/** Manual re-evaluation (appended to the risk log, outcome changes audited). */
export async function reevaluateCustomerPaymentTerms(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<PaymentTermsDecision> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "credit_terms:request");
  const { customerId } = parseInput(customerInput, input);
  return ctx.db.transaction(async (tx) => {
    const [exists] = await tx
      .select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, customerId)))
      .limit(1);
    if (exists === undefined) throw new DomainError("NOT_FOUND", "Customer not found");
    await lockCustomerFinance(tx, customerId);
    const evaluation = await reevaluateCustomer(tx, customerId, "MANUAL", options, {
      actor: auditActorOf(actor),
      actorUserId: actor.userId,
      now: ctx.clock.now(),
      correlationId: ctx.correlationId,
    });
    return evaluation.decision;
  });
}
