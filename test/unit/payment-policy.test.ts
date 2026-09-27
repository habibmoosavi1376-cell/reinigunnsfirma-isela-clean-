import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENT_POLICY,
  paymentPolicySchema,
  type PaymentPolicy,
} from "@isela/payment-risk";

function withOverride(override: Record<string, unknown>): unknown {
  return { ...DEFAULT_PAYMENT_POLICY, ...override };
}

describe("payment policy invariants", () => {
  it("accepts the documented default policy", () => {
    expect(paymentPolicySchema.safeParse(DEFAULT_PAYMENT_POLICY).success).toBe(true);
  });

  it.each([0, 1, 2])(
    "rejects minSuccessfulPaidOrders = %i (orders 1 and 2 are always prepaid)",
    (value) => {
      expect(
        paymentPolicySchema.safeParse(withOverride({ minSuccessfulPaidOrders: value })).success,
      ).toBe(false);
    },
  );

  it.each([3, 4, 20])("accepts minSuccessfulPaidOrders = %i", (value) => {
    expect(
      paymentPolicySchema.safeParse(withOverride({ minSuccessfulPaidOrders: value })).success,
    ).toBe(true);
  });

  it("rejects non-integer order thresholds", () => {
    expect(
      paymentPolicySchema.safeParse(withOverride({ minSuccessfulPaidOrders: 3.5 })).success,
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ["maxOpenOverdueInvoices", 1],
    ["revertToPrepaymentOnOverdue", false],
    ["maxChargebacksInLookback", 1],
    ["partialPaymentCountsAsPaid", true],
    ["pendingDuplicateReviewForcesPrepayment", false],
  ])("does not allow weakening %s", (field, value) => {
    expect(paymentPolicySchema.safeParse(withOverride({ [field]: value })).success).toBe(false);
  });

  it("requires at least 8 weeks settlement for SEPA direct debits", () => {
    const policy = withOverride({
      settlementDays: { ...DEFAULT_PAYMENT_POLICY.settlementDays, SEPA_DIRECT_DEBIT: 30 },
    });
    expect(paymentPolicySchema.safeParse(policy).success).toBe(false);
  });

  it("bounds trust score, late payments and credit limit", () => {
    expect(paymentPolicySchema.safeParse(withOverride({ minTrustScore: 40 })).success).toBe(false);
    expect(
      paymentPolicySchema.safeParse(withOverride({ maxLatePaymentsInLookback: 4 })).success,
    ).toBe(false);
    expect(
      paymentPolicySchema.safeParse(withOverride({ defaultCreditLimitCents: 0 })).success,
    ).toBe(false);
    expect(
      paymentPolicySchema.safeParse(withOverride({ defaultCreditLimitCents: 5_000_001 })).success,
    ).toBe(false);
  });

  it("rejects unknown fields (no silent configuration)", () => {
    expect(
      paymentPolicySchema.safeParse(withOverride({ allowInvoiceForNewCustomers: true })).success,
    ).toBe(false);
  });

  it("rejects missing fields", () => {
    const incomplete: Partial<PaymentPolicy> = { ...DEFAULT_PAYMENT_POLICY };
    delete incomplete.minTrustScore;
    expect(paymentPolicySchema.safeParse(incomplete).success).toBe(false);
  });
});
