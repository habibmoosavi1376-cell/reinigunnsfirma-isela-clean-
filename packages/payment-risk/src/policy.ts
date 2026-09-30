import { z } from "@isela/validation";

/**
 * Payment policy (setting key `payment.policy`). Values are configurable, but the schema
 * rejects every configuration that would weaken the binding business rules
 * (docs/DOMAIN_MODEL.md §11). Fields expressed as literals cannot be disabled.
 */
export const MIN_SUCCESSFUL_PAID_ORDERS_FLOOR = 3;
/** SEPA core direct debits can be returned without reason for 8 weeks. */
export const SEPA_DIRECT_DEBIT_MIN_SETTLEMENT_DAYS = 56;

export const paymentPolicySchema = z.strictObject({
  minSuccessfulPaidOrders: z.number().int().min(MIN_SUCCESSFUL_PAID_ORDERS_FLOOR).max(20),
  maxOpenOverdueInvoices: z.literal(0),
  overdueGraceDays: z.number().int().min(0).max(14),
  revertToPrepaymentOnOverdue: z.literal(true),
  lookbackDays: z.number().int().min(90).max(1095),
  maxLatePaymentsInLookback: z.number().int().min(0).max(3),
  latePaymentToleranceDays: z.number().int().min(0).max(14),
  maxChargebacksInLookback: z.literal(0),
  /** Failed payment attempts tolerated in the lookback window (stored policies: default 0). */
  maxFailedPaymentsInLookback: z.number().int().min(0).max(3).default(0),
  partialPaymentCountsAsPaid: z.literal(false),
  pendingDuplicateReviewForcesPrepayment: z.literal(true),
  minTrustScore: z.number().int().min(50).max(100),
  /** Upper bound for the credit limit an approver may grant to a single customer. */
  defaultCreditLimitCents: z.number().int().min(1).max(5_000_000),
  /**
   * Credit terms are never granted automatically (day 6): meeting the minimum history only
   * allows a request; a second person must approve it. Therefore this is the literal `true`.
   */
  requireManualApproval: z.literal(true),
  b2cInvoiceTermsAllowed: z.boolean(),
  settlementDays: z.strictObject({
    SEPA_DIRECT_DEBIT: z.number().int().min(SEPA_DIRECT_DEBIT_MIN_SETTLEMENT_DAYS).max(400),
    CARD: z.number().int().min(0).max(540),
    BANK_TRANSFER: z.number().int().min(0).max(30),
  }),
});

export type PaymentPolicy = z.infer<typeof paymentPolicySchema>;

/** Defaults from PRODUCT_SPEC §6.3 (to be confirmed by the business owner). */
export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = {
  minSuccessfulPaidOrders: 3,
  maxOpenOverdueInvoices: 0,
  overdueGraceDays: 0,
  revertToPrepaymentOnOverdue: true,
  lookbackDays: 365,
  maxLatePaymentsInLookback: 0,
  latePaymentToleranceDays: 7,
  maxChargebacksInLookback: 0,
  maxFailedPaymentsInLookback: 0,
  partialPaymentCountsAsPaid: false,
  pendingDuplicateReviewForcesPrepayment: true,
  minTrustScore: 70,
  defaultCreditLimitCents: 50_000,
  requireManualApproval: true,
  b2cInvoiceTermsAllowed: false,
  settlementDays: { SEPA_DIRECT_DEBIT: 56, CARD: 120, BANK_TRANSFER: 0 },
};

export type PaymentTerms = "PREPAYMENT" | "INVOICE";

export const PAYMENT_TERMS_REASON_CODES = [
  "NEW_CUSTOMER",
  "INSUFFICIENT_PAID_ORDERS",
  "OPEN_OVERDUE_INVOICE",
  "LATE_PAYMENT_HISTORY",
  "RECENT_CHARGEBACK",
  "TRUST_SCORE_TOO_LOW",
  "CREDIT_LIMIT_EXCEEDED",
  "PENDING_DUPLICATE_REVIEW",
  "B2C_INVOICE_TERMS_DISABLED",
  "MANUAL_OVERRIDE",
  "CUSTOMER_BLOCKED",
  // Day 6: real history and the credit-terms approval flow.
  "FAILED_PAYMENTS",
  "CREDIT_APPROVAL_REQUIRED",
  "CREDIT_TERMS_APPROVED",
] as const;

export type PaymentTermsReasonCode = (typeof PAYMENT_TERMS_REASON_CODES)[number];

/**
 * Explainable outcome of the central payment-terms engine:
 * - VORKASSE_REQUIRED: prepayment (default for new customers, jobs 1 and 2, any risk signal)
 * - CREDIT_TERMS_ALLOWED: invoice after service (only with an approved credit decision)
 * - BLOCKED: no new orders (customer blocked)
 * - REVIEW_REQUIRED: a person must review first (e.g. pending duplicate review); prepayment
 */
export const PAYMENT_TERMS_OUTCOMES = [
  "VORKASSE_REQUIRED",
  "CREDIT_TERMS_ALLOWED",
  "BLOCKED",
  "REVIEW_REQUIRED",
] as const;

export type PaymentTermsOutcome = (typeof PAYMENT_TERMS_OUTCOMES)[number];
