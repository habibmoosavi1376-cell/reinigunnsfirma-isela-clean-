import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENT_POLICY,
  evaluatePaymentTerms,
  historyWithoutOrders,
  type PaymentHistory,
} from "@isela/payment-risk";

const trusted: PaymentHistory = {
  customerStatus: "ACTIVE",
  duplicateReviewPending: false,
  isBusiness: true,
  completedPaidOrders: 3,
  openOverdueInvoices: 0,
  latePaymentsInLookback: 0,
  chargebacksInLookback: 0,
  trustScore: 90,
  openExposureCents: 0,
};
const autoPolicy = { ...DEFAULT_PAYMENT_POLICY, requireManualApproval: false };

describe("payment terms evaluation", () => {
  it("treats a new customer as prepayment", () => {
    const decision = evaluatePaymentTerms(
      historyWithoutOrders({ status: "ACTIVE", duplicateReviewStatus: "NONE", kind: "BUSINESS" }),
      autoPolicy,
    );
    expect(decision.terms).toBe("PREPAYMENT");
    expect(decision.reasons).toContain("NEW_CUSTOMER");
  });

  it.each([1, 2])("keeps order %i+1 on prepayment", (orders) => {
    const decision = evaluatePaymentTerms({ ...trusted, completedPaidOrders: orders }, autoPolicy);
    expect(decision.terms).toBe("PREPAYMENT");
    expect(decision.reasons).toContain("INSUFFICIENT_PAID_ORDERS");
  });

  it("allows invoice review only after three completed and paid orders", () => {
    expect(evaluatePaymentTerms(trusted, autoPolicy)).toEqual({
      terms: "INVOICE",
      invoiceReviewEligible: true,
      reasons: [],
    });
  });

  it("never grants invoice terms automatically when manual approval is required", () => {
    const decision = evaluatePaymentTerms(trusted, {
      ...DEFAULT_PAYMENT_POLICY,
      requireManualApproval: true,
    });
    expect(decision).toMatchObject({ terms: "PREPAYMENT", invoiceReviewEligible: true });
  });

  it.each([
    [{ openOverdueInvoices: 1 }, "OPEN_OVERDUE_INVOICE"],
    [{ chargebacksInLookback: 1 }, "RECENT_CHARGEBACK"],
    [{ customerStatus: "BLOCKED" }, "CUSTOMER_BLOCKED"],
    [{ duplicateReviewPending: true }, "PENDING_DUPLICATE_REVIEW"],
    [{ trustScore: null }, "TRUST_SCORE_TOO_LOW"],
    [
      { openExposureCents: DEFAULT_PAYMENT_POLICY.defaultCreditLimitCents },
      "CREDIT_LIMIT_EXCEEDED",
    ],
  ] as const)("falls back to prepayment for %o", (override, reason) => {
    const decision = evaluatePaymentTerms({ ...trusted, ...override }, autoPolicy);
    expect(decision.terms).toBe("PREPAYMENT");
    expect(decision.invoiceReviewEligible).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it("does not let many paid orders outweigh an overdue invoice or chargeback", () => {
    const decision = evaluatePaymentTerms(
      { ...trusted, completedPaidOrders: 500, openOverdueInvoices: 1, chargebacksInLookback: 1 },
      autoPolicy,
    );
    expect(decision.terms).toBe("PREPAYMENT");
  });

  it("respects the B2C switch", () => {
    const b2c = { ...trusted, isBusiness: false };
    expect(evaluatePaymentTerms(b2c, autoPolicy).reasons).toEqual(
      DEFAULT_PAYMENT_POLICY.b2cInvoiceTermsAllowed ? [] : ["B2C_INVOICE_TERMS_DISABLED"],
    );
  });

  it("rejects malformed history instead of guessing", () => {
    expect(() =>
      evaluatePaymentTerms({ ...trusted, completedPaidOrders: -1 }, autoPolicy),
    ).toThrow();
  });
});
