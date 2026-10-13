import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTE_CONFIG,
  QUOTE_STATUSES,
  QUOTE_TRANSITIONS,
  addDays,
  assertQuoteTransition,
  businessDate,
  calculateLine,
  calculateTotals,
  contributionMargin,
  permissionForQuoteTransition,
  pricingInputSchema,
  quantityToMilli,
  quoteConfigSchema,
  type QuoteStatus,
  type QuoteTransitionContext,
} from "@isela/quotes";
import { ROLE_PERMISSIONS } from "@isela/auth";
import { expectDomainErrorSync } from "../support/assertions.ts";

const TODAY = "2026-09-27";

function ctx(overrides: Partial<QuoteTransitionContext> = {}): QuoteTransitionContext {
  return {
    itemCount: 1,
    grossCents: 11_900,
    validUntil: "2026-10-27",
    today: TODAY,
    reason: "Kunde hat telefonisch zugestimmt",
    performedBySystem: false,
    actorIsCreator: false,
    requireFourEyesApproval: false,
    ...overrides,
  };
}

describe("quote state machine", () => {
  const allowed = new Set(
    QUOTE_STATUSES.flatMap((from) => QUOTE_TRANSITIONS[from].map((to) => `${from}>${to}`)),
  );

  it.each(
    QUOTE_STATUSES.flatMap((from) =>
      QUOTE_STATUSES.filter((to) => to !== from && !allowed.has(`${from}>${to}`)).map(
        (to) => [from, to] as const,
      ),
    ),
  )("rejects %s → %s", (from, to) => {
    expectDomainErrorSync(() => {
      assertQuoteTransition(from, to, ctx({ validUntil: "2026-01-01" }));
    }, "INVALID_STATE_TRANSITION");
  });

  it("has no way out of terminal states", () => {
    for (const status of ["ACCEPTED", "DECLINED", "EXPIRED", "CANCELLED"] as QuoteStatus[]) {
      expect(QUOTE_TRANSITIONS[status]).toEqual([]);
    }
  });

  it("never allows DRAFT → SENT (review is mandatory)", () => {
    expect(QUOTE_TRANSITIONS.DRAFT).not.toContain("SENT");
  });

  it("requires items for review and sending", () => {
    expectDomainErrorSync(() => {
      assertQuoteTransition("DRAFT", "PENDING_REVIEW", ctx({ itemCount: 0 }));
    }, "POLICY_VIOLATION");
    expectDomainErrorSync(() => {
      assertQuoteTransition("PENDING_REVIEW", "SENT", ctx({ itemCount: 0 }));
    }, "POLICY_VIOLATION");
    expect(() => {
      assertQuoteTransition("DRAFT", "PENDING_REVIEW", ctx({ reason: null }));
    }).not.toThrow();
  });

  it("rejects sending with a past validity date and enforces four-eyes when configured", () => {
    expectDomainErrorSync(() => {
      assertQuoteTransition("PENDING_REVIEW", "SENT", ctx({ validUntil: "2026-09-26" }));
    }, "POLICY_VIOLATION");
    expect(() => {
      assertQuoteTransition("PENDING_REVIEW", "SENT", ctx({ validUntil: TODAY }));
    }).not.toThrow();
    expectDomainErrorSync(() => {
      assertQuoteTransition(
        "PENDING_REVIEW",
        "SENT",
        ctx({ actorIsCreator: true, requireFourEyesApproval: true }),
      );
    }, "POLICY_VIOLATION");
    expect(() => {
      assertQuoteTransition("PENDING_REVIEW", "SENT", ctx({ actorIsCreator: true }));
    }).not.toThrow();
  });

  it("does not accept an expired quote and only expires past-due quotes", () => {
    expectDomainErrorSync(() => {
      assertQuoteTransition("SENT", "ACCEPTED", ctx({ validUntil: "2026-09-26" }));
    }, "POLICY_VIOLATION");
    expectDomainErrorSync(() => {
      assertQuoteTransition("SENT", "EXPIRED", ctx({ validUntil: TODAY }));
    }, "POLICY_VIOLATION");
    expect(() => {
      assertQuoteTransition(
        "SENT",
        "EXPIRED",
        ctx({ validUntil: "2026-09-26", performedBySystem: true, reason: null }),
      );
    }).not.toThrow();
  });

  it("allows automated transitions only for expiry", () => {
    expectDomainErrorSync(() => {
      assertQuoteTransition("PENDING_REVIEW", "SENT", ctx({ performedBySystem: true }));
    }, "POLICY_VIOLATION");
    expectDomainErrorSync(() => {
      assertQuoteTransition("SENT", "ACCEPTED", ctx({ performedBySystem: true }));
    }, "POLICY_VIOLATION");
  });

  it.each(["ACCEPTED", "DECLINED", "CANCELLED"] as const)("requires a reason for → %s", (to) => {
    expectDomainErrorSync(() => {
      assertQuoteTransition("SENT", to, ctx({ reason: "  " }));
    }, "VALIDATION_FAILED");
  });

  it("requires approval rights to release a quote", () => {
    expect(permissionForQuoteTransition("SENT")).toBe("quote:approve");
    expect(permissionForQuoteTransition("PENDING_REVIEW")).toBe("quote:write");
    expect(permissionForQuoteTransition("CANCELLED")).toBe("quote:write");
  });
});

describe("quote RBAC matrix", () => {
  it("grants quote:approve only to ADMIN and SUPER_ADMIN", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, grants]) => grants["quote:approve"] !== undefined)
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(["ADMIN", "SUPER_ADMIN"]);
  });

  it("gives FINANCE read-only quote access and no master-data changes", () => {
    expect(ROLE_PERMISSIONS.FINANCE["quote:read"]).toBe("GLOBAL");
    expect(ROLE_PERMISSIONS.FINANCE["quote:write"]).toBeUndefined();
    expect(ROLE_PERMISSIONS.FINANCE["customer:update"]).toBeUndefined();
    expect(ROLE_PERMISSIONS.FINANCE["property:write"]).toBeUndefined();
  });

  it("gives STAFF and PARTNER no quote access and CUSTOMER only OWN read", () => {
    for (const role of ["STAFF", "PARTNER"] as const) {
      expect(ROLE_PERMISSIONS[role]["quote:read"]).toBeUndefined();
      expect(ROLE_PERMISSIONS[role]["quote:write"]).toBeUndefined();
    }
    expect(ROLE_PERMISSIONS.CUSTOMER["quote:read"]).toBe("OWN");
    expect(ROLE_PERMISSIONS.CUSTOMER["quote:write"]).toBeUndefined();
    expect(ROLE_PERMISSIONS.CUSTOMER["quote:approve"]).toBeUndefined();
  });
});

describe("quote arithmetic", () => {
  it("computes line amounts in cents with half-up rounding", () => {
    expect(
      calculateLine({ quantity: 2.5, unitPriceCents: 3990, taxRateBasisPoints: 1900 }),
    ).toEqual({ netCents: 9975, taxCents: 1895, grossCents: 11870 });
    // 0.333 × 1.50 € = 49.95 ct → 50 ct; 7 % of 50 = 3.5 → 4
    expect(
      calculateLine({ quantity: 0.333, unitPriceCents: 150, taxRateBasisPoints: 700 }),
    ).toEqual({ netCents: 50, taxCents: 4, grossCents: 54 });
  });

  it("avoids floating-point errors", () => {
    // 0.1 + 0.2 style inputs: 3 × 0.1 h at 10 € would be 2.9999… with floats
    expect(calculateLine({ quantity: 0.3, unitPriceCents: 1000, taxRateBasisPoints: 0 })).toEqual({
      netCents: 300,
      taxCents: 0,
      grossCents: 300,
    });
    expect(quantityToMilli(1.005)).toBe(1005n);
  });

  it("computes tax once per rate on the summed net amounts", () => {
    const totals = calculateTotals([
      { netCents: 1, taxRateBasisPoints: 1900 },
      { netCents: 1, taxRateBasisPoints: 1900 },
      { netCents: 1, taxRateBasisPoints: 1900 },
      { netCents: 1000, taxRateBasisPoints: 700 },
    ]);
    expect(totals.taxByRate).toEqual([
      { taxRateBasisPoints: 1900, netCents: 3, taxCents: 1 },
      { taxRateBasisPoints: 700, netCents: 1000, taxCents: 70 },
    ]);
    expect(totals).toMatchObject({ netCents: 1003, taxCents: 71, grossCents: 1074 });
    expect(calculateTotals([])).toMatchObject({ netCents: 0, taxCents: 0, grossCents: 0 });
  });

  it.each([
    { quantity: 0, unitPriceCents: 100, taxRateBasisPoints: 1900 },
    { quantity: -1, unitPriceCents: 100, taxRateBasisPoints: 1900 },
    { quantity: 1.0001, unitPriceCents: 100, taxRateBasisPoints: 1900 },
    { quantity: 1_000_001, unitPriceCents: 100, taxRateBasisPoints: 1900 },
    { quantity: 1, unitPriceCents: -1, taxRateBasisPoints: 1900 },
    { quantity: 1, unitPriceCents: 1.5, taxRateBasisPoints: 1900 },
    { quantity: 1, unitPriceCents: 100_000_001, taxRateBasisPoints: 1900 },
    { quantity: 1, unitPriceCents: 100, taxRateBasisPoints: 10_001 },
    { quantity: Number.NaN, unitPriceCents: 100, taxRateBasisPoints: 1900 },
  ])("rejects out-of-range input %o", (line) => {
    expectDomainErrorSync(() => calculateLine(line), "VALIDATION_FAILED");
  });

  it("stays exact at the upper bounds", () => {
    expect(
      calculateLine({ quantity: 1_000_000, unitPriceCents: 100_000_000, taxRateBasisPoints: 1900 }),
    ).toEqual({
      netCents: 100_000_000_000_000,
      taxCents: 19_000_000_000_000,
      grossCents: 119_000_000_000_000,
    });
  });

  it("computes the contribution margin from configured labour cost", () => {
    expect(
      contributionMargin({
        netCents: 10_000,
        expectedLaborMinutes: 90,
        laborCostCentsPerHour: 3_000,
        directCostsCents: 500,
      }),
    ).toEqual({ laborCostCents: 4_500, contributionMarginCents: 5_000 });
    expectDomainErrorSync(
      () =>
        contributionMargin({
          netCents: 1,
          expectedLaborMinutes: -1,
          laborCostCentsPerHour: 1,
          directCostsCents: 0,
        }),
      "VALIDATION_FAILED",
    );
  });

  it("validates pricing engine input strictly", () => {
    const valid = {
      serviceKey: "unterhaltsreinigung",
      propertyType: "OFFICE",
      areaSqm: 120,
      rooms: 5,
      bathrooms: 2,
      windows: 12,
      frequency: "WEEKLY",
      extras: [],
      urgency: "STANDARD",
      distanceKm: 4.2,
      regionKey: "area-1",
      estimatedLaborMinutes: 180,
      directCostsCents: 1200,
    };
    expect(pricingInputSchema.safeParse(valid).success).toBe(true);
    expect(pricingInputSchema.safeParse({ ...valid, priceCents: 1 }).success).toBe(false);
    expect(pricingInputSchema.safeParse({ ...valid, areaSqm: -5 }).success).toBe(false);
  });
});

describe("quote configuration", () => {
  it("accepts the defaults and rejects inconsistent values", () => {
    expect(quoteConfigSchema.safeParse(DEFAULT_QUOTE_CONFIG).success).toBe(true);
    expect(
      quoteConfigSchema.safeParse({ ...DEFAULT_QUOTE_CONFIG, defaultVatRateBasisPoints: 1600 })
        .success,
    ).toBe(false);
    expect(
      quoteConfigSchema.safeParse({ ...DEFAULT_QUOTE_CONFIG, vatRatesBasisPoints: [1900, 1900] })
        .success,
    ).toBe(false);
    expect(
      quoteConfigSchema.safeParse({ ...DEFAULT_QUOTE_CONFIG, timeZone: "Mars/Olympus" }).success,
    ).toBe(false);
    expect(quoteConfigSchema.safeParse({ ...DEFAULT_QUOTE_CONFIG, extra: 1 }).success).toBe(false);
  });

  it("derives business dates in the configured time zone", () => {
    // 23:30 UTC on 30 Sep is already 1 Oct in Central European Summer Time.
    expect(businessDate(new Date("2026-09-30T23:30:00Z"), "Europe/Berlin")).toBe("2026-10-01");
    expect(businessDate(new Date("2026-09-30T23:30:00Z"), "UTC")).toBe("2026-09-30");
    expect(addDays("2026-12-20", 30)).toBe("2027-01-19");
  });
});
