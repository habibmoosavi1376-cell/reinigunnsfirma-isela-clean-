import { describe, expect, it } from "vitest";
import {
  CONFIG_REQUIRED,
  applyBasisPoints,
  calculatePrice,
  emptyPriceRules,
  listConfigRequired,
  priceRulesSchema,
  pricingVersionOf,
  roundHalfUpDiv,
  toScaled,
  type CalculatedPrice,
  type EngineInput,
  type PriceRules,
} from "@isela/pricing";
import { expectDomainErrorSync } from "../support/assertions.ts";

/*
 * All amounts below are TEST VALUES for arithmetic checks – they are not business prices.
 * Expected results are computed by hand in integer cents.
 */

const SERVICE = "11111111-1111-4111-8111-111111111111";
const EXTRA = "22222222-2222-4222-8222-222222222222";
const CONTEXT = { ruleSetVersion: 3, currency: "EUR", taxRateBasisPoints: 1900 };

function rules(overrides: Partial<PriceRules> = {}): PriceRules {
  return {
    costs: { laborCostCentsPerHour: 3000 },
    services: {
      [SERVICE]: {
        basePriceCents: 2000,
        perSqmCents: 150,
        perRoomCents: 500,
        perBathroomCents: 800,
        perWindowCents: 300,
      },
    },
    extras: { [EXTRA]: { priceCents: 1500, laborMinutes: 20 } },
    frequencyAdjustmentBasisPoints: {
      ONCE: 0,
      WEEKLY: -1000,
      BIWEEKLY: -500,
      MONTHLY: -300,
      CUSTOM: 0,
    },
    urgencySurchargeBasisPoints: { STANDARD: 0, EXPRESS: 2000 },
    distance: null,
    timeSurcharges: [],
    discounts: [],
    ...overrides,
  };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    serviceId: SERVICE,
    serviceUnit: "SQUARE_METER",
    quantity: 62.5,
    areaSqm: 62.5,
    rooms: 3,
    bathrooms: 1,
    windows: 8,
    frequency: "ONCE",
    urgency: "STANDARD",
    extraIds: [EXTRA],
    discountKeys: [],
    distanceM: null,
    plannedStart: null,
    duration: { model: "FIXED", baseMinutes: 180, perUnitSeconds: null },
    estimatedLaborMinutes: null,
    directCostsCents: 0,
    partnerCostCents: null,
    ...overrides,
  };
}

function calculated(result: ReturnType<typeof calculatePrice>): CalculatedPrice {
  if (result.status !== "CALCULATED") {
    throw new Error(`expected CALCULATED, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("money arithmetic (integer cents, no floating point)", () => {
  it("rounds commercially half-up", () => {
    expect(roundHalfUpDiv(5n, 2n)).toBe(3n);
    expect(roundHalfUpDiv(4n, 2n)).toBe(2n);
    expect(roundHalfUpDiv(333_925n, 100n)).toBe(3339n);
    expect(roundHalfUpDiv(333_950n, 100n)).toBe(3340n);
    expect(roundHalfUpDiv(-5n, 2n)).toBe(-3n);
  });

  it("applies basis points exactly", () => {
    expect(applyBasisPoints(17_575n, 1900n)).toBe(3339n);
    expect(applyBasisPoints(17_575n, 9000n)).toBe(15_818n);
    expect(applyBasisPoints(1n, 5000n)).toBe(1n);
  });

  it("scales decimals without floating-point drift", () => {
    expect(toScaled(12.345, 3)).toBe(12_345n);
    expect(toScaled(0.1 + 0.2, 1)).toBe(3n);
    expect(toScaled(62.5, 2)).toBe(6250n);
    expectDomainErrorSync(() => toScaled(1.2345, 3), "VALIDATION_FAILED");
    expectDomainErrorSync(() => toScaled(-1, 3), "VALIDATION_FAILED");
  });
});

describe("price rule document", () => {
  it("starts with every business value marked CONFIG_REQUIRED (no invented prices)", () => {
    const empty = emptyPriceRules();
    expect(priceRulesSchema.safeParse(empty).success).toBe(true);
    expect(listConfigRequired(empty)).toEqual([
      "costs.laborCostCentsPerHour",
      "frequencyAdjustmentBasisPoints.ONCE",
      "frequencyAdjustmentBasisPoints.WEEKLY",
      "frequencyAdjustmentBasisPoints.BIWEEKLY",
      "frequencyAdjustmentBasisPoints.MONTHLY",
      "frequencyAdjustmentBasisPoints.CUSTOM",
      "urgencySurchargeBasisPoints.STANDARD",
      "urgencySurchargeBasisPoints.EXPRESS",
    ]);
  });

  it("rejects unknown fields, floats and negative prices", () => {
    expect(priceRulesSchema.safeParse({ ...rules(), margin: 10 }).success).toBe(false);
    const withFloat = rules();
    const service = withFloat.services[SERVICE];
    expect(
      priceRulesSchema.safeParse({
        ...withFloat,
        services: { [SERVICE]: { ...service, basePriceCents: 19.99 } },
      }).success,
    ).toBe(false);
    expect(
      priceRulesSchema.safeParse({
        ...withFloat,
        services: { [SERVICE]: { ...service, basePriceCents: -1 } },
      }).success,
    ).toBe(false);
  });
});

describe("pricing engine v1", () => {
  it("computes net, tax, gross, labour, costs and margin in cents", () => {
    const result = calculated(calculatePrice(rules(), input(), CONTEXT));
    // 2000 + 62.5 × 150 + 3 × 500 + 1 × 800 + 8 × 300 + 1500 = 17 575
    expect(result).toMatchObject({
      net: 17_575,
      taxRateBasisPoints: 1900,
      tax: 3339,
      gross: 20_914,
      currency: "EUR",
      pricingVersion: "v1+r3",
      // FIXED 180 min + extra 20 min; 200 min × 30.00 €/h = 100.00 €
      estimatedLaborMinutes: 200,
      directCosts: 0,
      internalCost: 10_000,
      contributionMargin: 7575,
      requiresReview: true,
    });
    expect(result.components.reduce((sum, c) => sum + c.amountCents, 0)).toBe(result.net);
  });

  it("keeps tax separate and uses the tax rate supplied by the server", () => {
    const reduced = calculated(
      calculatePrice(rules(), input(), { ...CONTEXT, taxRateBasisPoints: 700 }),
    );
    expect(reduced).toMatchObject({ net: 17_575, tax: 1230, gross: 18_805 });
    const zero = calculated(
      calculatePrice(rules(), input(), { ...CONTEXT, taxRateBasisPoints: 0 }),
    );
    expect(zero).toMatchObject({ net: 17_575, tax: 0, gross: 17_575 });
  });

  it("applies frequency, urgency and discounts as explainable adjustments", () => {
    const weekly = calculated(calculatePrice(rules(), input({ frequency: "WEEKLY" }), CONTEXT));
    expect(weekly.net).toBe(15_818); // 17 575 × 0.90 = 15 817.5 → half-up
    const express = calculated(
      calculatePrice(rules(), input({ frequency: "WEEKLY", urgency: "EXPRESS" }), CONTEXT),
    );
    expect(express.net).toBe(19_333); // × 1.10 = 19 332.5 → half-up
    expect(express.adjustmentsBasisPoints).toEqual({
      "FREQUENCY:WEEKLY": -1000,
      "URGENCY:EXPRESS": 2000,
    });
    const discounted = calculated(
      calculatePrice(
        rules({ discounts: [{ key: "stammkunde", label: "Test", basisPoints: 500 }] }),
        input({ discountKeys: ["stammkunde"] }),
        CONTEXT,
      ),
    );
    expect(discounted.net).toBe(16_696); // 17 575 × 0.95 = 16 696.25
    expectDomainErrorSync(
      () => calculatePrice(rules(), input({ discountKeys: ["erfunden"] }), CONTEXT),
      "VALIDATION_FAILED",
    );
  });

  it("applies weekday/time surcharges only with a planned date", () => {
    const withSurcharge = rules({
      timeSurcharges: [
        { key: "wochenende", weekdays: [6, 7], fromMinute: 0, toMinute: 1440, basisPoints: 2500 },
      ],
    });
    const saturday = calculated(
      calculatePrice(
        withSurcharge,
        input({ plannedStart: { weekday: 6, minuteOfDay: 600 } }),
        CONTEXT,
      ),
    );
    expect(saturday.net).toBe(21_969); // 17 575 × 1.25 = 21 968.75
    const monday = calculated(
      calculatePrice(
        withSurcharge,
        input({ plannedStart: { weekday: 1, minuteOfDay: 600 } }),
        CONTEXT,
      ),
    );
    expect(monday.net).toBe(17_575);
    const undated = calculated(calculatePrice(withSurcharge, input(), CONTEXT));
    expect(undated.notes).toContain("TIME_SURCHARGE_NOT_EVALUATED_NO_DATE");
  });

  it("charges distance beyond the included kilometres", () => {
    const withDistance = rules({ distance: { includedKm: 10, perKmCents: 50 } });
    const near = calculated(calculatePrice(withDistance, input({ distanceM: 8000 }), CONTEXT));
    expect(near.net).toBe(17_575);
    const far = calculated(calculatePrice(withDistance, input({ distanceM: 14_500 }), CONTEXT));
    expect(far.net).toBe(17_575 + 225); // 4.5 km × 0.50 €
    const unknown = calculatePrice(withDistance, input({ distanceM: null }), CONTEXT);
    expect(unknown).toMatchObject({ status: "CONFIG_REQUIRED", missing: ["input.distance"] });
  });

  it("raises to a minimum price only when the owner defined one", () => {
    const small = input({ areaSqm: 10, quantity: 10, rooms: 1, windows: 0, extraIds: [] });
    const withoutMinimum = calculated(calculatePrice(rules(), small, CONTEXT));
    expect(withoutMinimum.net).toBe(2000 + 1500 + 500 + 800);
    const base = rules();
    const withMinimum = calculated(
      calculatePrice(
        rules({
          services: {
            [SERVICE]: { ...base.services[SERVICE], basePriceCents: 2000, minimumNetCents: 9000 },
          },
        }),
        small,
        CONTEXT,
      ),
    );
    expect(withMinimum.net).toBe(9000);
    expect(withMinimum.components.at(-1)).toEqual({ key: "MINIMUM_PRICE", amountCents: 4200 });
  });

  it("returns CONFIG_REQUIRED instead of guessing missing business values", () => {
    expect(calculatePrice(emptyPriceRules(), input(), CONTEXT)).toEqual({
      status: "CONFIG_REQUIRED",
      pricingVersion: "v1+r3",
      missing: [`services.${SERVICE}`],
    });
    const base = rules();
    const pending = calculatePrice(
      rules({
        services: { [SERVICE]: { ...base.services[SERVICE], basePriceCents: CONFIG_REQUIRED } },
        frequencyAdjustmentBasisPoints: {
          ...base.frequencyAdjustmentBasisPoints,
          ONCE: CONFIG_REQUIRED,
        },
      }),
      input(),
      CONTEXT,
    );
    expect(pending).toMatchObject({
      status: "CONFIG_REQUIRED",
      missing: [`frequencyAdjustmentBasisPoints.ONCE`, `services.${SERVICE}.basePriceCents`],
    });
    expect(calculatePrice(rules(), input({ rooms: null }), CONTEXT)).toMatchObject({
      status: "CONFIG_REQUIRED",
      missing: ["input.rooms"],
    });
    expect(calculatePrice(rules({ extras: {} }), input(), CONTEXT)).toMatchObject({
      status: "CONFIG_REQUIRED",
      missing: [`extras.${EXTRA}`],
    });
  });

  it("never produces a price of 0 EUR", () => {
    const zeroRules = rules({
      services: { [SERVICE]: { basePriceCents: 0 } },
      extras: {},
    });
    const result = calculatePrice(zeroRules, input({ extraIds: [] }), CONTEXT);
    expect(result).toMatchObject({
      status: "CONFIG_REQUIRED",
      missing: ["result.nonPositivePrice"],
    });
    // Adjustments that would cancel the whole price out are a configuration error.
    const base = rules();
    const cancelledOut = calculatePrice(
      rules({
        frequencyAdjustmentBasisPoints: { ...base.frequencyAdjustmentBasisPoints, WEEKLY: -5000 },
        discounts: [{ key: "alles", label: "Test", basisPoints: 5000 }],
      }),
      input({ frequency: "WEEKLY", discountKeys: ["alles"] }),
      CONTEXT,
    );
    expect(cancelledOut).toMatchObject({
      status: "CONFIG_REQUIRED",
      missing: ["adjustments.totalNotPositive"],
    });
  });

  it("uses the partner cost instead of labour cost when given (internal only)", () => {
    const result = calculated(
      calculatePrice(rules(), input({ partnerCostCents: 12_000, directCostsCents: 500 }), CONTEXT),
    );
    expect(result).toMatchObject({ internalCost: 12_500, contributionMargin: 5075 });
    expect(result.net).toBe(17_575); // costs never change the price
  });

  it("reports a missing labour estimate or cost rate without blocking the price", () => {
    const manual = calculated(
      calculatePrice(
        rules(),
        input({ duration: { model: "MANUAL", baseMinutes: null, perUnitSeconds: null } }),
        CONTEXT,
      ),
    );
    expect(manual).toMatchObject({
      estimatedLaborMinutes: null,
      internalCost: null,
      contributionMargin: null,
    });
    expect(manual.notes).toContain("LABOR_ESTIMATE_REQUIRED");
    const noRate = calculated(
      calculatePrice(
        rules({ costs: { laborCostCentsPerHour: CONFIG_REQUIRED } }),
        input(),
        CONTEXT,
      ),
    );
    expect(noRate.internalCost).toBeNull();
    expect(noRate.notes).toContain("LABOR_COST_RATE_CONFIG_REQUIRED");
    const perUnit = calculated(
      calculatePrice(
        rules(),
        input({ duration: { model: "PER_UNIT", baseMinutes: 15, perUnitSeconds: 90 } }),
        CONTEXT,
      ),
    );
    // 15 + 62.5 m² × 90 s = 15 + 93.75 min (→ 94) + extra 20 = 129
    expect(perUnit.estimatedLaborMinutes).toBe(129);
  });

  it("versions every result and stays deterministic for old rule versions", () => {
    expect(pricingVersionOf(1)).toBe("v1+r1");
    const v1 = calculatePrice(rules(), input(), { ...CONTEXT, ruleSetVersion: 1 });
    const base = rules();
    const v2 = calculatePrice(
      rules({ services: { [SERVICE]: { ...base.services[SERVICE], basePriceCents: 2500 } } }),
      input(),
      { ...CONTEXT, ruleSetVersion: 2 },
    );
    expect(calculated(v1).net).toBe(17_575);
    expect(calculated(v2).net).toBe(18_075);
    // Re-running the old version gives the identical result (no retroactive change).
    expect(calculatePrice(rules(), input(), { ...CONTEXT, ruleSetVersion: 1 })).toEqual(v1);
  });

  it("rejects an invalid context or input", () => {
    expectDomainErrorSync(
      () => calculatePrice(rules(), input(), { ...CONTEXT, taxRateBasisPoints: 19.5 }),
      "VALIDATION_FAILED",
    );
    expect(() =>
      calculatePrice(rules(), { ...input(), netCents: 1 } as EngineInput, CONTEXT),
    ).toThrow();
    expect(() => calculatePrice(rules(), input({ quantity: -1 }), CONTEXT)).toThrow();
  });
});
