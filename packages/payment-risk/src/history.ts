import { schema, sql, eq, type DbExecutor } from "@isela/database";
import { DomainError } from "@isela/shared";
import {
  evaluatePaymentTerms,
  paymentHistorySchema,
  type PaymentHistory,
  type PaymentTermsDecision,
} from "./evaluate.ts";
import { paymentPolicySchema, type PaymentPolicy } from "./policy.ts";

/*
 * The ONE place where the payment history is derived from recorded data (bookings, invoices,
 * payments, credit decisions). Every consumer – booking creation, job start, customer file,
 * finance views, credit decisions, overdue runs – goes through `evaluateCustomerPaymentTerms`,
 * so there is no second, competing financial rule set. All facts are keyed by customer_id.
 */

export interface PaymentTermsEvaluationContext {
  readonly policy: PaymentPolicy;
  /** Evaluation time (the caller's clock). */
  readonly now: Date;
  /** Business time zone (due dates are calendar dates in this zone). */
  readonly timeZone: string;
  /** Gross amount of the order being evaluated (0 = general evaluation). */
  readonly requestedAmountCents?: number;
}

export interface PaymentTermsEvaluation {
  readonly decision: PaymentTermsDecision;
  readonly history: PaymentHistory;
  /** Calendar date in the business time zone used for due-date comparisons. */
  readonly businessDate: string;
}

/** YYYY-MM-DD of `instant` in `timeZone`. */
export function businessDateOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DomainError("CONFLICT", "Inconsistent payment history");
  }
  return n;
}

/**
 * Serialises financial decisions of one customer (booking creation, credit decisions,
 * payment confirmations, overdue protection) inside the current transaction.
 */
export async function lockCustomerFinance(db: DbExecutor, customerId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`isela:customer-finance:${customerId}`}, 0))`,
  );
}

export async function loadPaymentHistory(
  db: DbExecutor,
  customerId: string,
  context: Omit<PaymentTermsEvaluationContext, "requestedAmountCents">,
): Promise<{ history: PaymentHistory; businessDate: string }> {
  const policy = paymentPolicySchema.parse(context.policy);
  const businessDate = businessDateOf(context.now, context.timeZone);
  const lookbackStart = new Date(context.now.getTime() - policy.lookbackDays * 86_400_000);
  const [customer] = await db
    .select({
      status: schema.customer.status,
      duplicateReviewStatus: schema.customer.duplicateReviewStatus,
      kind: schema.customer.kind,
    })
    .from(schema.customer)
    .where(eq(schema.customer.id, customerId))
    .limit(1);
  if (customer === undefined) throw new DomainError("NOT_FOUND", "Customer not found");

  const settlement = policy.settlementDays;
  const now = context.now.toISOString();
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM "booking" b
        WHERE b."customer_id" = ${customerId} AND b."status" = 'COMPLETED'
          AND EXISTS (SELECT 1 FROM "invoice" i
            WHERE i."booking_id" = b."id" AND i."status" = 'PAID')
          AND NOT EXISTS (SELECT 1 FROM "invoice" i JOIN "payment" p ON p."invoice_id" = i."id"
            WHERE i."booking_id" = b."id"
              AND p."status" IN ('REFUND_PENDING', 'REFUNDED', 'CHARGED_BACK'))
          AND NOT EXISTS (SELECT 1 FROM "invoice" i JOIN "payment" p ON p."invoice_id" = i."id"
            WHERE i."booking_id" = b."id" AND p."status" = 'CONFIRMED'
              AND p."confirmed_at" + make_interval(days => CASE p."method"
                WHEN 'SEPA_DIRECT_DEBIT' THEN ${settlement.SEPA_DIRECT_DEBIT}::int
                WHEN 'CARD' THEN ${settlement.CARD}::int
                ELSE ${settlement.BANK_TRANSFER}::int END) > ${now}::timestamptz)
      ) AS "completed_paid_orders",
      (SELECT count(*) FROM "invoice" i
        WHERE i."customer_id" = ${customerId}
          AND (i."status" = 'OVERDUE' OR (i."status" IN ('OPEN', 'PARTIALLY_PAID')
            AND i."due_date" + ${policy.overdueGraceDays}::int < ${businessDate}::date))
      ) AS "open_overdue_invoices",
      (SELECT count(*) FROM "invoice" i
        WHERE i."customer_id" = ${customerId} AND i."paid_at" >= ${lookbackStart.toISOString()}::timestamptz
          AND (i."paid_at" AT TIME ZONE ${context.timeZone})::date
            > i."due_date" + ${policy.latePaymentToleranceDays}::int
      ) AS "late_payments",
      (SELECT count(*) FROM "payment" p
        WHERE p."customer_id" = ${customerId} AND p."status" = 'CHARGED_BACK'
          AND p."charged_back_at" >= ${lookbackStart.toISOString()}::timestamptz
      ) AS "chargebacks",
      (SELECT count(*) FROM "payment" p
        WHERE p."customer_id" = ${customerId} AND p."status" = 'FAILED'
          AND p."failed_at" >= ${lookbackStart.toISOString()}::timestamptz
      ) AS "failed_payments",
      (SELECT COALESCE(SUM(i."gross_cents" - i."paid_cents"), 0) FROM "invoice" i
        WHERE i."customer_id" = ${customerId}
          AND i."status" IN ('ISSUED', 'OPEN', 'PARTIALLY_PAID', 'OVERDUE')
      ) + (SELECT COALESCE(SUM(b."gross_cents"), 0) FROM "booking" b
        WHERE b."customer_id" = ${customerId}
          AND b."payment_requirement" = 'CREDIT_TERMS_APPROVED' AND b."status" <> 'CANCELLED'
          AND NOT EXISTS (SELECT 1 FROM "invoice" i
            WHERE i."booking_id" = b."id" AND i."status" NOT IN ('DRAFT', 'CANCELLED', 'VOID'))
      ) AS "open_exposure"
  `);
  const row = result.rows[0] ?? {};
  const [approval] = await db
    .select({
      creditLimitCents: schema.creditTermsApproval.creditLimitCents,
      trustScore: schema.creditTermsApproval.trustScore,
      validUntil: schema.creditTermsApproval.validUntil,
    })
    .from(schema.creditTermsApproval)
    .where(
      sql`${schema.creditTermsApproval.customerId} = ${customerId} AND ${schema.creditTermsApproval.status} = 'APPROVED'`,
    )
    .limit(1);
  const approvalActive =
    approval !== undefined &&
    approval.creditLimitCents !== null &&
    approval.trustScore !== null &&
    (approval.validUntil === null || approval.validUntil >= businessDate);
  const history = paymentHistorySchema.parse({
    customerStatus: customer.status,
    duplicateReviewPending: customer.duplicateReviewStatus === "PENDING",
    isBusiness: customer.kind !== "PRIVATE",
    completedPaidOrders: toCount(row["completed_paid_orders"]),
    openOverdueInvoices: toCount(row["open_overdue_invoices"]),
    latePaymentsInLookback: toCount(row["late_payments"]),
    chargebacksInLookback: toCount(row["chargebacks"]),
    failedPaymentsInLookback: toCount(row["failed_payments"]),
    openExposureCents: toCount(row["open_exposure"]),
    creditApproval: approvalActive
      ? { creditLimitCents: approval.creditLimitCents, trustScore: approval.trustScore }
      : null,
  });
  return { history, businessDate };
}

/** Central payment-terms engine: `evaluatePaymentTerms(customerId, context)` on recorded data. */
export async function evaluateCustomerPaymentTerms(
  db: DbExecutor,
  customerId: string,
  context: PaymentTermsEvaluationContext,
): Promise<PaymentTermsEvaluation> {
  const { history, businessDate } = await loadPaymentHistory(db, customerId, context);
  const decision = evaluatePaymentTerms(history, paymentPolicySchema.parse(context.policy), {
    requestedAmountCents: context.requestedAmountCents ?? 0,
  });
  return { decision, history, businessDate };
}

export type RiskEvaluationTrigger =
  "BOOKING" | "PAYMENT" | "OVERDUE" | "CREDIT_DECISION" | "MANUAL";

/**
 * Appends the evaluation to the customer's append-only risk log (counted facts only, no
 * personal data) and reports whether the outcome changed compared with the last entry.
 */
export async function recordPaymentRiskEvaluation(
  db: DbExecutor,
  input: {
    readonly customerId: string;
    readonly evaluation: PaymentTermsEvaluation;
    readonly policyVersion: number | null;
    readonly trigger: RiskEvaluationTrigger;
    readonly actorUserId: string | null;
    readonly now: Date;
  },
): Promise<{ changed: boolean; previousOutcome: string | null }> {
  const e = schema.paymentRiskEvaluation;
  const [previous] = await db
    .select({ outcome: e.outcome })
    .from(e)
    .where(eq(e.customerId, input.customerId))
    .orderBy(sql`${e.evaluatedAt} DESC, ${e.id} DESC`)
    .limit(1);
  const { decision, history } = input.evaluation;
  await db.insert(e).values({
    customerId: input.customerId,
    outcome: decision.outcome,
    reasons: [...decision.reasons],
    facts: {
      completedPaidOrders: history.completedPaidOrders,
      openOverdueInvoices: history.openOverdueInvoices,
      latePaymentsInLookback: history.latePaymentsInLookback,
      chargebacksInLookback: history.chargebacksInLookback,
      failedPaymentsInLookback: history.failedPaymentsInLookback,
      openExposureCents: history.openExposureCents,
      creditLimitCents: decision.creditLimitCents,
      invoiceReviewEligible: decision.invoiceReviewEligible,
    },
    policyVersion: input.policyVersion,
    trigger: input.trigger,
    actorUserId: input.actorUserId,
    evaluatedAt: input.now,
  });
  const previousOutcome = previous?.outcome ?? null;
  return { changed: previousOutcome !== decision.outcome, previousOutcome };
}
