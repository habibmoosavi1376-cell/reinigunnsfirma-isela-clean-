import { z } from "@isela/validation";
import type {
  PaymentPolicy,
  PaymentTerms,
  PaymentTermsOutcome,
  PaymentTermsReasonCode,
} from "./policy.ts";

/*
 * Payment-terms decision (docs/DOMAIN_MODEL.md §11). Pure function over the customer's
 * RECORDED history – the history belongs to the customer record, never to an account, so a
 * new account or e-mail address cannot reset it (identity matching resolves to the existing
 * customer). The minimum history (≥ 3 completed AND paid jobs, no overdue invoice, no
 * chargeback, no payment problems) only makes a customer ELIGIBLE for a credit-terms review;
 * credit terms are granted solely by an approved, audited credit decision of a person.
 */

const count = z.number().int().min(0).max(1_000_000);

export const creditApprovalFactsSchema = z.strictObject({
  creditLimitCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** Internal trust assessment recorded by the approver (0–100). */
  trustScore: z.number().int().min(0).max(100),
});

export const paymentHistorySchema = z.strictObject({
  customerStatus: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]),
  duplicateReviewPending: z.boolean(),
  isBusiness: z.boolean(),
  /** Jobs that were completed AND fully paid beyond the settlement period (no partials). */
  completedPaidOrders: count,
  openOverdueInvoices: count,
  latePaymentsInLookback: count,
  chargebacksInLookback: count,
  failedPaymentsInLookback: count,
  /** Outstanding invoice amounts plus not yet invoiced credit-terms bookings. */
  openExposureCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Active approved credit decision, if any. */
  creditApproval: creditApprovalFactsSchema.nullable(),
});

export type PaymentHistory = z.infer<typeof paymentHistorySchema>;

export interface PaymentTermsContext {
  /** Gross amount of the order being evaluated (0 = general evaluation). */
  readonly requestedAmountCents?: number;
}

export interface PaymentTermsDecision {
  readonly outcome: PaymentTermsOutcome;
  readonly terms: PaymentTerms;
  /** The binding minimum conditions hold, so a credit-terms request MAY be reviewed. */
  readonly invoiceReviewEligible: boolean;
  readonly reasons: readonly PaymentTermsReasonCode[];
  readonly creditLimitCents: number | null;
  readonly availableCreditCents: number | null;
}

export function evaluatePaymentTerms(
  history: PaymentHistory,
  policy: PaymentPolicy,
  context: PaymentTermsContext = {},
): PaymentTermsDecision {
  const h = paymentHistorySchema.parse(history);
  const requested = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .parse(context.requestedAmountCents ?? 0);
  const reasons: PaymentTermsReasonCode[] = [];
  if (h.customerStatus === "BLOCKED") reasons.push("CUSTOMER_BLOCKED");
  // policy.pendingDuplicateReviewForcesPrepayment is the literal `true` (cannot be disabled).
  if (h.duplicateReviewPending) reasons.push("PENDING_DUPLICATE_REVIEW");
  if (h.completedPaidOrders === 0) {
    reasons.push("NEW_CUSTOMER");
  } else if (h.completedPaidOrders < policy.minSuccessfulPaidOrders) {
    // Jobs 1 and 2 (and every job below the configured minimum ≥ 3) stay on prepayment.
    reasons.push("INSUFFICIENT_PAID_ORDERS");
  }
  if (h.openOverdueInvoices > policy.maxOpenOverdueInvoices) reasons.push("OPEN_OVERDUE_INVOICE");
  if (h.latePaymentsInLookback > policy.maxLatePaymentsInLookback) {
    reasons.push("LATE_PAYMENT_HISTORY");
  }
  if (h.chargebacksInLookback > policy.maxChargebacksInLookback) reasons.push("RECENT_CHARGEBACK");
  if (h.failedPaymentsInLookback > policy.maxFailedPaymentsInLookback) {
    reasons.push("FAILED_PAYMENTS");
  }
  if (!h.isBusiness && !policy.b2cInvoiceTermsAllowed) reasons.push("B2C_INVOICE_TERMS_DISABLED");
  const eligible = reasons.length === 0;

  let creditLimitCents: number | null = null;
  let availableCreditCents: number | null = null;
  if (h.creditApproval !== null) {
    creditLimitCents = h.creditApproval.creditLimitCents;
    availableCreditCents = Math.max(0, creditLimitCents - h.openExposureCents);
  }
  if (eligible) {
    if (h.creditApproval === null) {
      // Meeting the minimum is a precondition, never an approval (no automatic credit).
      reasons.push("CREDIT_APPROVAL_REQUIRED");
    } else {
      if (h.creditApproval.trustScore < policy.minTrustScore) reasons.push("TRUST_SCORE_TOO_LOW");
      if (h.openExposureCents + requested > h.creditApproval.creditLimitCents) {
        reasons.push("CREDIT_LIMIT_EXCEEDED");
      }
    }
  }

  let outcome: PaymentTermsOutcome;
  if (reasons.includes("CUSTOMER_BLOCKED")) {
    outcome = "BLOCKED";
  } else if (reasons.includes("PENDING_DUPLICATE_REVIEW")) {
    outcome = "REVIEW_REQUIRED";
  } else if (reasons.length === 0) {
    outcome = "CREDIT_TERMS_ALLOWED";
    reasons.push("CREDIT_TERMS_APPROVED");
  } else {
    outcome = "VORKASSE_REQUIRED";
  }
  return {
    outcome,
    terms: outcome === "CREDIT_TERMS_ALLOWED" ? "INVOICE" : "PREPAYMENT",
    invoiceReviewEligible: eligible,
    reasons,
    creditLimitCents,
    availableCreditCents,
  };
}

/** History of a customer without any recorded jobs, invoices or payments. */
export function historyWithoutOrders(customer: {
  status: "ACTIVE" | "INACTIVE" | "BLOCKED";
  duplicateReviewStatus: "NONE" | "PENDING";
  kind: string;
}): PaymentHistory {
  return {
    customerStatus: customer.status,
    duplicateReviewPending: customer.duplicateReviewStatus === "PENDING",
    isBusiness: customer.kind !== "PRIVATE",
    completedPaidOrders: 0,
    openOverdueInvoices: 0,
    latePaymentsInLookback: 0,
    chargebacksInLookback: 0,
    failedPaymentsInLookback: 0,
    openExposureCents: 0,
    creditApproval: null,
  };
}
