import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENT_POLICY,
  evaluatePaymentTerms,
  historyWithoutOrders,
  type PaymentHistory,
} from "@isela/payment-risk";

/*
 * Day 6: credit terms (INVOICE) require the binding minimum history AND an approved credit
 * decision of a second person. The day-4 cases are kept; where they relied on an automatic
 * grant (`requireManualApproval: false`, no longer a valid policy), the approval is now part
 * of the recorded history.
 */

const approval = { creditLimitCents: 50_000, trustScore: 90 };

const trusted: PaymentHistory = {
  customerStatus: "ACTIVE",
  duplicateReviewPending: false,
  isBusiness: true,
  completedPaidOrders: 3,
  openOverdueInvoices: 0,
  latePaymentsInLookback: 0,
  chargebacksInLookback: 0,
  failedPaymentsInLookback: 0,
  openExposureCents: 0,
  creditApproval: approval,
};
const policy = DEFAULT_PAYMENT_POLICY;

describe("payment terms evaluation", () => {
  it("treats a new customer as prepayment", () => {
    const decision = evaluatePaymentTerms(
      historyWithoutOrders({ status: "ACTIVE", duplicateReviewStatus: "NONE", kind: "BUSINESS" }),
      policy,
    );
    expect(decision.terms).toBe("PREPAYMENT");
    expect(decision.outcome).toBe("VORKASSE_REQUIRED");
    expect(decision.reasons).toContain("NEW_CUSTOMER");
  });

  it.each([1, 2])("keeps order %i+1 on prepayment", (orders) => {
    const decision = evaluatePaymentTerms({ ...trusted, completedPaidOrders: orders }, policy);
    expect(decision.terms).toBe("PREPAYMENT");
    expect(decision.reasons).toContain("INSUFFICIENT_PAID_ORDERS");
  });

  it("allows invoice terms only after three completed and paid orders AND an approval", () => {
    expect(evaluatePaymentTerms(trusted, policy)).toEqual({
      outcome: "CREDIT_TERMS_ALLOWED",
      terms: "INVOICE",
      invoiceReviewEligible: true,
      reasons: ["CREDIT_TERMS_APPROVED"],
      creditLimitCents: 50_000,
      availableCreditCents: 50_000,
    });
  });

  it("never grants invoice terms automatically when manual approval is required", () => {
    const decision = evaluatePaymentTerms({ ...trusted, creditApproval: null }, policy);
    expect(decision).toMatchObject({
      outcome: "VORKASSE_REQUIRED",
      terms: "PREPAYMENT",
      invoiceReviewEligible: true,
      reasons: ["CREDIT_APPROVAL_REQUIRED"],
    });
  });

  it.each([
    [{ openOverdueInvoices: 1 }, "OPEN_OVERDUE_INVOICE"],
    [{ chargebacksInLookback: 1 }, "RECENT_CHARGEBACK"],
    [{ latePaymentsInLookback: 1 }, "LATE_PAYMENT_HISTORY"],
    [{ failedPaymentsInLookback: 1 }, "FAILED_PAYMENTS"],
    [{ customerStatus: "BLOCKED" }, "CUSTOMER_BLOCKED"],
    [{ duplicateReviewPending: true }, "PENDING_DUPLICATE_REVIEW"],
  ] as const)("falls back to prepayment for %o", (override, reason) => {
    const decision = evaluatePaymentTerms({ ...trusted, ...override }, policy);
    expect(decision.terms).toBe("PREPAYMENT");
    expect(decision.invoiceReviewEligible).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it("requires a sufficient trust assessment within the approval", () => {
    const decision = evaluatePaymentTerms(
      { ...trusted, creditApproval: { ...approval, trustScore: policy.minTrustScore - 1 } },
      policy,
    );
    expect(decision.terms).toBe("PREPAYMENT");
    expect(decision.reasons).toContain("TRUST_SCORE_TOO_LOW");
  });

  it("respects the approved credit limit including the requested order", () => {
    const within = evaluatePaymentTerms({ ...trusted, openExposureCents: 20_000 }, policy, {
      requestedAmountCents: 30_000,
    });
    expect(within.terms).toBe("INVOICE");
    expect(within.availableCreditCents).toBe(30_000);
    const above = evaluatePaymentTerms({ ...trusted, openExposureCents: 20_000 }, policy, {
      requestedAmountCents: 30_001,
    });
    expect(above.terms).toBe("PREPAYMENT");
    expect(above.reasons).toContain("CREDIT_LIMIT_EXCEEDED");
  });

  it("does not let many paid orders outweigh an overdue invoice or chargeback", () => {
    const decision = evaluatePaymentTerms(
      { ...trusted, completedPaidOrders: 500, openOverdueInvoices: 1, chargebacksInLookback: 1 },
      policy,
    );
    expect(decision.terms).toBe("PREPAYMENT");
  });

  it("maps blocked customers to BLOCKED and duplicate reviews to REVIEW_REQUIRED", () => {
    expect(evaluatePaymentTerms({ ...trusted, customerStatus: "BLOCKED" }, policy).outcome).toBe(
      "BLOCKED",
    );
    expect(evaluatePaymentTerms({ ...trusted, duplicateReviewPending: true }, policy).outcome).toBe(
      "REVIEW_REQUIRED",
    );
  });

  it("respects the B2C switch", () => {
    const b2c = { ...trusted, isBusiness: false };
    expect(evaluatePaymentTerms(b2c, policy).reasons).toEqual(
      policy.b2cInvoiceTermsAllowed ? ["CREDIT_TERMS_APPROVED"] : ["B2C_INVOICE_TERMS_DISABLED"],
    );
  });

  it("rejects malformed history instead of guessing", () => {
    expect(() => evaluatePaymentTerms({ ...trusted, completedPaidOrders: -1 }, policy)).toThrow();
    expect(() => evaluatePaymentTerms(trusted, policy, { requestedAmountCents: -1 })).toThrow();
    expect(() =>
      evaluatePaymentTerms(
        { ...trusted, creditApproval: { creditLimitCents: 0, trustScore: 90 } },
        policy,
      ),
    ).toThrow();
  });
});
