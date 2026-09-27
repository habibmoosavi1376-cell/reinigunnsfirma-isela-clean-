import { z } from "@isela/validation";
import type { PaymentPolicy, PaymentTerms, PaymentTermsReasonCode } from "./policy.ts";

/*
 * Payment-terms decision (docs/DOMAIN_MODEL.md §11). Pure function over the customer's
 * RECORDED history – the history belongs to the customer record, never to an account, so a
 * new account or e-mail address cannot reset it (identity matching resolves to the existing
 * customer). Invoice terms are never granted automatically while manual approval is required.
 */

const count = z.number().int().min(0).max(1_000_000);

export const paymentHistorySchema = z.strictObject({
  customerStatus: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]),
  duplicateReviewPending: z.boolean(),
  isBusiness: z.boolean(),
  /** Jobs that were completed AND fully paid (partial payments do not count). */
  completedPaidOrders: count,
  openOverdueInvoices: count,
  latePaymentsInLookback: count,
  chargebacksInLookback: count,
  trustScore: z.number().int().min(0).max(100).nullable(),
  openExposureCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type PaymentHistory = z.infer<typeof paymentHistorySchema>;

export interface PaymentTermsDecision {
  readonly terms: PaymentTerms;
  /** All binding conditions hold, so invoice terms MAY be reviewed (by a person if required). */
  readonly invoiceReviewEligible: boolean;
  readonly reasons: readonly PaymentTermsReasonCode[];
}

export function evaluatePaymentTerms(
  history: PaymentHistory,
  policy: PaymentPolicy,
): PaymentTermsDecision {
  const h = paymentHistorySchema.parse(history);
  const reasons: PaymentTermsReasonCode[] = [];
  if (h.customerStatus === "BLOCKED") reasons.push("CUSTOMER_BLOCKED");
  if (h.duplicateReviewPending && policy.pendingDuplicateReviewForcesPrepayment) {
    reasons.push("PENDING_DUPLICATE_REVIEW");
  }
  if (h.completedPaidOrders === 0) {
    reasons.push("NEW_CUSTOMER");
  } else if (h.completedPaidOrders < policy.minSuccessfulPaidOrders) {
    reasons.push("INSUFFICIENT_PAID_ORDERS");
  }
  if (h.openOverdueInvoices > policy.maxOpenOverdueInvoices) reasons.push("OPEN_OVERDUE_INVOICE");
  if (h.latePaymentsInLookback > policy.maxLatePaymentsInLookback) {
    reasons.push("LATE_PAYMENT_HISTORY");
  }
  if (h.chargebacksInLookback > policy.maxChargebacksInLookback) reasons.push("RECENT_CHARGEBACK");
  if (h.trustScore === null || h.trustScore < policy.minTrustScore) {
    reasons.push("TRUST_SCORE_TOO_LOW");
  }
  if (h.openExposureCents >= policy.defaultCreditLimitCents) reasons.push("CREDIT_LIMIT_EXCEEDED");
  if (!h.isBusiness && !policy.b2cInvoiceTermsAllowed) reasons.push("B2C_INVOICE_TERMS_DISABLED");

  const eligible = reasons.length === 0;
  return {
    terms: eligible && !policy.requireManualApproval ? "INVOICE" : "PREPAYMENT",
    invoiceReviewEligible: eligible,
    reasons,
  };
}

/** History of a customer for whom no jobs or invoices are recorded yet (day 4: always). */
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
    trustScore: null,
    openExposureCents: 0,
  };
}
