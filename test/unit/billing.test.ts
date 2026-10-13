import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BILLING_CONFIG,
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  PAYMENT_RECORD_STATUSES,
  PAYMENT_RECORD_TRANSITIONS,
  allocatePayment,
  assertInvoiceTransition,
  assertPaymentRecordTransition,
  billingConfigSchema,
  containsPossibleCardNumber,
  deriveInvoiceStatus,
  formatInvoiceNumber,
  missingBillingConfig,
  normalizePaymentReference,
  outstandingCents,
  providerEventSchema,
  reverseAllocation,
  verifyWebhookSignature,
  type InvoiceStatus,
} from "@isela/billing";
import { calculateTotals } from "@isela/quotes";
import { expectDomainErrorSync } from "../support/assertions.ts";

function forbiddenPairs<S extends string>(
  statuses: readonly S[],
  transitions: Readonly<Record<S, readonly S[]>>,
): [S, S][] {
  return statuses.flatMap((from) =>
    statuses.filter((to) => to !== from && !transitions[from].includes(to)).map((to) => [from, to]),
  ) as [S, S][];
}

describe("billing: cent arithmetic (no floats)", () => {
  it.each([
    [1, 0, 1, 1, 0, 1],
    [2, 1, 1, 1, 0, 2],
    [9_999, 0, 9_999, 9_999, 0, 9_999],
    [10_000_000_000, 0, 10_000_000_000, 10_000_000_000, 0, 10_000_000_000],
  ])(
    "gross %i, paid %i, payment %i → applied %i, excess %i, paid after %i",
    (gross, paid, amount, applied, excess, after) => {
      expect(allocatePayment({ grossCents: gross, paidCents: paid, amountCents: amount })).toEqual({
        appliedCents: applied,
        excessCents: excess,
        paidAfterCents: after,
      });
    },
  );

  it("handles partial payments and the remaining amount exactly", () => {
    const first = allocatePayment({ grossCents: 10_710, paidCents: 0, amountCents: 5_000 });
    expect(first).toEqual({ appliedCents: 5_000, excessCents: 0, paidAfterCents: 5_000 });
    expect(outstandingCents(10_710, first.paidAfterCents)).toBe(5_710);
    const second = allocatePayment({ grossCents: 10_710, paidCents: 5_000, amountCents: 5_710 });
    expect(second.paidAfterCents).toBe(10_710);
    expect(outstandingCents(10_710, second.paidAfterCents)).toBe(0);
  });

  it("never applies more than the outstanding amount (overpayment stays visible)", () => {
    expect(allocatePayment({ grossCents: 9_999, paidCents: 9_000, amountCents: 1_500 })).toEqual({
      appliedCents: 999,
      excessCents: 501,
      paidAfterCents: 9_999,
    });
    // A payment on an already paid invoice is entirely excess.
    expect(allocatePayment({ grossCents: 100, paidCents: 100, amountCents: 1 })).toEqual({
      appliedCents: 0,
      excessCents: 1,
      paidAfterCents: 100,
    });
  });

  it("reverses applied amounts for refunds and chargebacks", () => {
    expect(reverseAllocation(10_710, 5_000)).toBe(5_710);
    expectDomainErrorSync(() => reverseAllocation(100, 101), "CONFLICT");
  });

  it("rejects invalid, fractional, zero and oversized amounts", () => {
    for (const amountCents of [0, -1, 0.5, Number.NaN, 10_000_000_001]) {
      expect(() => allocatePayment({ grossCents: 100, paidCents: 0, amountCents })).toThrow();
    }
    expectDomainErrorSync(() => outstandingCents(100, 101), "CONFLICT");
    expectDomainErrorSync(() => outstandingCents(1.5, 0), "VALIDATION_FAILED");
  });

  it("computes tax per VAT rate on summed net amounts (same arithmetic as the quote)", () => {
    // 3 × 0,01 € at 19 %: per-line tax would be 3 × 0 = 0, per rate it is round(0,57) = 1 cent.
    const lines = [1, 1, 1].map((net) => ({ netCents: net, taxRateBasisPoints: 1900 }));
    expect(calculateTotals(lines)).toMatchObject({ netCents: 3, taxCents: 1, grossCents: 4 });
    // 0,02 € and 99,99 €, mixed rates.
    expect(
      calculateTotals([
        { netCents: 2, taxRateBasisPoints: 1900 },
        { netCents: 9_999, taxRateBasisPoints: 700 },
      ]),
    ).toMatchObject({ netCents: 10_001, taxCents: 700, grossCents: 10_701 });
    // Large amount without floating-point drift.
    expect(calculateTotals([{ netCents: 4_999_999_999, taxRateBasisPoints: 1900 }])).toMatchObject({
      taxCents: 950_000_000,
      grossCents: 5_949_999_999,
    });
  });
});

describe("billing: invoice status", () => {
  it.each(forbiddenPairs(INVOICE_STATUSES, INVOICE_TRANSITIONS))("rejects %s → %s", (from, to) => {
    expectDomainErrorSync(() => {
      assertInvoiceTransition(from, to, { reason: "Grund" });
    }, "INVALID_STATE_TRANSITION");
  });

  it("keeps CANCELLED and VOID final and requires a reason for them", () => {
    expect(INVOICE_TRANSITIONS.CANCELLED).toEqual([]);
    expect(INVOICE_TRANSITIONS.VOID).toEqual([]);
    expectDomainErrorSync(() => {
      assertInvoiceTransition("OPEN", "VOID", { reason: " " });
    }, "VALIDATION_FAILED");
    expectDomainErrorSync(() => {
      assertInvoiceTransition("DRAFT", "CANCELLED", { reason: null });
    }, "VALIDATION_FAILED");
  });

  const base = { grossCents: 10_000, dueDate: "2026-10-10", graceDays: 0 };
  it.each<[InvoiceStatus, number, string, InvoiceStatus]>([
    ["OPEN", 0, "2026-10-10", "OPEN"],
    ["OPEN", 0, "2026-10-11", "OVERDUE"],
    ["OPEN", 1, "2026-10-01", "PARTIALLY_PAID"],
    ["OPEN", 9_999, "2026-10-11", "OVERDUE"],
    ["OPEN", 10_000, "2026-12-31", "PAID"],
    ["OVERDUE", 10_000, "2026-12-31", "PAID"],
    ["PAID", 5_000, "2026-10-01", "PARTIALLY_PAID"],
    ["PAID", 0, "2026-10-11", "OVERDUE"],
    ["DRAFT", 0, "2026-12-31", "DRAFT"],
    ["ISSUED", 0, "2026-12-31", "ISSUED"],
    ["VOID", 10_000, "2026-12-31", "VOID"],
  ])("derives %s with paid %i on %s as %s", (status, paid, today, expected) => {
    expect(deriveInvoiceStatus({ ...base, status, paidCents: paid, today })).toBe(expected);
  });

  it("applies the configured grace days before an invoice is overdue", () => {
    const input = { ...base, status: "OPEN" as const, paidCents: 0, graceDays: 3 };
    expect(deriveInvoiceStatus({ ...input, today: "2026-10-13" })).toBe("OPEN");
    expect(deriveInvoiceStatus({ ...input, today: "2026-10-14" })).toBe("OVERDUE");
  });

  it("never treats a partial payment as paid", () => {
    expect(
      deriveInvoiceStatus({ ...base, status: "OPEN", paidCents: 9_999, today: "2026-10-01" }),
    ).toBe("PARTIALLY_PAID");
  });
});

describe("billing: payment state machine", () => {
  it.each(forbiddenPairs(PAYMENT_RECORD_STATUSES, PAYMENT_RECORD_TRANSITIONS))(
    "rejects %s → %s",
    (from, to) => {
      expectDomainErrorSync(() => {
        assertPaymentRecordTransition(from, to, { reason: "Grund" });
      }, "INVALID_STATE_TRANSITION");
    },
  );

  it("keeps FAILED, REFUNDED and CHARGED_BACK final", () => {
    for (const status of ["FAILED", "REFUNDED", "CHARGED_BACK"] as const) {
      expect(PAYMENT_RECORD_TRANSITIONS[status]).toEqual([]);
    }
  });

  it.each(["FAILED", "REFUND_PENDING", "CHARGED_BACK"] as const)(
    "requires a reason for %s",
    (to) => {
      const from = to === "FAILED" ? "PENDING" : "CONFIRMED";
      expectDomainErrorSync(() => {
        assertPaymentRecordTransition(from, to, { reason: null });
      }, "VALIDATION_FAILED");
    },
  );
});

describe("billing: invoice numbers and configuration", () => {
  it("formats sequential numbers per prefix and year", () => {
    expect(formatInvoiceNumber("RE", 2026, 1)).toBe("RE-2026-000001");
    expect(formatInvoiceNumber("RE", 2027, 1)).toBe("RE-2027-000001");
    expect(formatInvoiceNumber("ABC9", 2026, 1_234_567)).toBe("ABC9-2026-1234567");
  });

  it.each([
    ["re", 2026, 1],
    ["RE-", 2026, 1],
    ["RE", 1999, 1],
    ["RE", 2026, 0],
    ["RE", 2026, 1.5],
  ] as const)("rejects prefix %s / year %i / sequence %s", (prefix, year, sequence) => {
    expectDomainErrorSync(() => formatInvoiceNumber(prefix, year, sequence), "VALIDATION_FAILED");
  });

  it("requires owner configuration before issuing (CONFIG_REQUIRED by default)", () => {
    expect(billingConfigSchema.parse(DEFAULT_BILLING_CONFIG)).toEqual(DEFAULT_BILLING_CONFIG);
    expect(missingBillingConfig(DEFAULT_BILLING_CONFIG, "FINAL")).toEqual([
      "invoiceNumberPrefix",
      "paymentTermDays",
    ]);
    expect(missingBillingConfig(DEFAULT_BILLING_CONFIG, "PREPAYMENT")).toEqual([
      "invoiceNumberPrefix",
      "prepaymentDueDays",
    ]);
    const configured = { invoiceNumberPrefix: "RE", paymentTermDays: 14, prepaymentDueDays: 7 };
    expect(missingBillingConfig(configured, "FINAL")).toEqual([]);
    expect(billingConfigSchema.safeParse({ ...configured, paymentTermDays: -1 }).success).toBe(
      false,
    );
    expect(billingConfigSchema.safeParse({ ...configured, extra: 1 }).success).toBe(false);
  });
});

describe("billing: payment references", () => {
  it.each([
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "Karte 5555555555554444",
    "CVV 123",
    "PIN 1234",
  ])("rejects card or secret data: %s", (reference) => {
    expectDomainErrorSync(() => normalizePaymentReference(reference), "VALIDATION_FAILED");
  });

  it.each([
    "Kontoauszug 2026-10 Pos. 4",
    "EREF 20261001123456789012345",
    "RE-2026-000001",
    "Überweisung 4111 1111 1111 1112",
  ])("accepts transaction references: %s", (reference) => {
    expect(normalizePaymentReference(`  ${reference}  `)).toBe(reference);
  });

  it("detects Luhn-valid card numbers only as whole digit runs", () => {
    expect(containsPossibleCardNumber("4111111111111111")).toBe(true);
    expect(containsPossibleCardNumber("1234567890123456789012345")).toBe(false);
  });

  it("rejects too short and too long references", () => {
    expectDomainErrorSync(() => normalizePaymentReference("ab"), "VALIDATION_FAILED");
    expectDomainErrorSync(() => normalizePaymentReference("x".repeat(201)), "VALIDATION_FAILED");
  });
});

describe("billing: webhook signature verification", () => {
  const secret = "test-signing-secret-only-for-tests";
  const now = new Date("2026-10-01T12:00:00Z");
  const body = JSON.stringify({ id: "evt_1" });
  const t = Math.floor(now.getTime() / 1000);
  const sign = (timestamp: number, payload: string, key = secret) =>
    createHmac("sha256", key)
      .update(`${String(timestamp)}.${payload}`)
      .digest("hex");

  it("accepts a valid signature within the tolerance", () => {
    expect(
      verifyWebhookSignature({
        secret,
        rawBody: body,
        signatureHeader: `t=${String(t)},v1=${sign(t, body)}`,
        now,
      }),
    ).toEqual({ timestamp: t });
  });

  it.each([
    ["a tampered body", `t=${String(t)},v1=${sign(t, body)}`, `${body} `],
    ["a wrong secret", `t=${String(t)},v1=${sign(t, body, "another-secret-value-123")}`, body],
    ["a replayed old delivery", `t=${String(t - 301)},v1=${sign(t - 301, body)}`, body],
    ["a future timestamp", `t=${String(t + 301)},v1=${sign(t + 301, body)}`, body],
    ["a missing signature", `t=${String(t)}`, body],
    ["garbage", "v1=zz", body],
  ])("rejects %s", (_name, header, rawBody) => {
    expectDomainErrorSync(
      () => verifyWebhookSignature({ secret, rawBody, signatureHeader: header, now }),
      "UNAUTHENTICATED",
    );
  });

  it("refuses to verify without a configured secret", () => {
    expectDomainErrorSync(
      () => verifyWebhookSignature({ secret: "", rawBody: body, signatureHeader: null, now }),
      "CONFIG_REQUIRED",
    );
  });

  it("validates the payload strictly (no trust in unknown fields)", () => {
    const event = {
      id: "evt_1",
      type: "payment.succeeded",
      occurredAt: "2026-10-01T12:00:00Z",
      data: { providerPaymentId: "pay_1", amountCents: 100, currency: "EUR" },
    };
    expect(providerEventSchema.safeParse(event).success).toBe(true);
    expect(providerEventSchema.safeParse({ ...event, paid: true }).success).toBe(false);
    expect(
      providerEventSchema.safeParse({ ...event, data: { ...event.data, amountCents: 0 } }).success,
    ).toBe(false);
    expect(providerEventSchema.safeParse({ ...event, type: "invoice.paid" }).success).toBe(false);
  });
});
