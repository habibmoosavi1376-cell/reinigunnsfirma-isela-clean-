import { DomainError } from "@isela/shared";
import { z } from "@isela/validation";
import { MAX_CENTS, applyBasisPoints, roundHalfUpDiv, toSafeNumber, toScaled } from "./money.ts";
import {
  CONFIG_REQUIRED,
  FREQUENCIES,
  URGENCIES,
  priceRulesSchema,
  type PriceRules,
} from "./rules.ts";

/*
 * Pricing engine v1 – a pure, deterministic function (no I/O, no clock, no floating-point
 * money). The server builds the input from stored data (property, service, address) plus
 * whitelisted staff choices; the browser never supplies amounts, costs or margins.
 *
 *   subtotal = base + per unit + per m² + per room + per bathroom + per window + extras
 *   adjusted = subtotal × (10 000 + frequency + urgency + time surcharge − discounts) / 10 000
 *   net      = max(adjusted + distance charge, minimum net price if defined)
 *   tax      = net × VAT rate (half-up), gross = net + tax
 *   margin   = net − (labour cost or partner cost) − direct costs
 *
 * Any value the calculation needs that is marked CONFIG_REQUIRED (or missing input it needs)
 * yields status CONFIG_REQUIRED with the list of missing keys – never a guessed price, and
 * never a price of 0 EUR.
 */

export const PRICING_ENGINE_VERSION = "v1";

export const DURATION_MODELS = ["MANUAL", "FIXED", "PER_UNIT"] as const;

export const engineInputSchema = z.strictObject({
  serviceId: z.uuid(),
  serviceUnit: z.enum(["HOUR", "SQUARE_METER", "FLAT", "UNIT"]),
  /** Quantity in the service unit (3 decimals). */
  quantity: z.number().positive().max(1_000_000),
  areaSqm: z.number().positive().max(1_000_000).nullable(),
  rooms: z.number().int().min(0).max(10_000).nullable(),
  bathrooms: z.number().int().min(0).max(10_000).nullable(),
  windows: z.number().int().min(0).max(100_000).nullable(),
  frequency: z.enum(FREQUENCIES),
  urgency: z.enum(URGENCIES),
  extraIds: z.array(z.uuid()).max(20),
  discountKeys: z.array(z.string().max(64)).max(5),
  /** Road distance proxy in metres (server-derived); NULL = unknown. */
  distanceM: z.number().int().min(0).max(2_000_000).nullable(),
  /** Planned start in business-local time; NULL = no date yet (no time surcharge). */
  plannedStart: z
    .strictObject({
      weekday: z.number().int().min(1).max(7),
      minuteOfDay: z.number().int().min(0).max(1439),
    })
    .nullable(),
  duration: z.strictObject({
    model: z.enum(DURATION_MODELS),
    baseMinutes: z.number().int().min(0).max(10_080).nullable(),
    perUnitSeconds: z.number().int().min(1).max(86_400).nullable(),
  }),
  /** Labour estimate entered by authorised staff; overrides the duration model. */
  estimatedLaborMinutes: z.number().int().min(0).max(100_000).nullable(),
  directCostsCents: z.number().int().min(0).max(MAX_CENTS),
  /** Partner price for this job (authorised finance input); NULL = own staff. */
  partnerCostCents: z.number().int().min(0).max(MAX_CENTS).nullable(),
});

export type EngineInput = z.infer<typeof engineInputSchema>;

export interface EngineContext {
  readonly ruleSetVersion: number;
  readonly currency: string;
  /** VAT rate resolved on the server from the tax configuration (basis points). */
  readonly taxRateBasisPoints: number;
}

export interface PriceComponent {
  readonly key: string;
  readonly amountCents: number;
}

export interface CalculatedPrice {
  readonly status: "CALCULATED";
  readonly currency: string;
  readonly pricingVersion: string;
  readonly net: number;
  readonly taxRateBasisPoints: number;
  readonly tax: number;
  readonly gross: number;
  readonly estimatedLaborMinutes: number | null;
  readonly directCosts: number;
  /** Internal cost (labour or partner) + direct costs; NULL if the cost rate is not set. */
  readonly internalCost: number | null;
  readonly contributionMargin: number | null;
  readonly components: readonly PriceComponent[];
  /** Adjustments in basis points that were applied (explainability). */
  readonly adjustmentsBasisPoints: Readonly<Record<string, number>>;
  /** Notes on parts that could not be computed without affecting the price. */
  readonly notes: readonly string[];
  /** Always true: an engine price is a proposal that a person reviews before release. */
  readonly requiresReview: true;
}

export interface ConfigRequiredPrice {
  readonly status: "CONFIG_REQUIRED";
  readonly pricingVersion: string;
  readonly missing: readonly string[];
}

export type PriceResult = CalculatedPrice | ConfigRequiredPrice;

function isSet<T>(value: T | typeof CONFIG_REQUIRED | undefined): value is T {
  return value !== undefined && value !== CONFIG_REQUIRED;
}

export function pricingVersionOf(ruleSetVersion: number): string {
  return `${PRICING_ENGINE_VERSION}+r${String(ruleSetVersion)}`;
}

export function calculatePrice(
  rulesInput: PriceRules,
  input: EngineInput,
  context: EngineContext,
): PriceResult {
  const rules = priceRulesSchema.parse(rulesInput);
  const data = engineInputSchema.parse(input);
  if (
    !Number.isInteger(context.taxRateBasisPoints) ||
    context.taxRateBasisPoints < 0 ||
    context.taxRateBasisPoints > 10_000 ||
    !Number.isInteger(context.ruleSetVersion) ||
    context.ruleSetVersion < 1
  ) {
    throw new DomainError("VALIDATION_FAILED", "Invalid pricing context");
  }
  const pricingVersion = pricingVersionOf(context.ruleSetVersion);
  const missing: string[] = [];
  const notes: string[] = [];
  const components: { key: string; amount: bigint }[] = [];

  const serviceRule = rules.services[data.serviceId];
  if (serviceRule === undefined) {
    return { status: "CONFIG_REQUIRED", pricingVersion, missing: [`services.${data.serviceId}`] };
  }
  const servicePath = `services.${data.serviceId}`;

  const add = (key: string, amount: bigint) => {
    components.push({ key, amount });
  };

  // Grundpreis
  if (isSet(serviceRule.basePriceCents)) {
    add("BASE_PRICE", BigInt(serviceRule.basePriceCents));
  } else {
    missing.push(`${servicePath}.basePriceCents`);
  }

  // Quantity-based components. A rate that is undefined is not part of this service's price;
  // a rate marked CONFIG_REQUIRED or a missing input the rate needs blocks the calculation.
  const quantityMilli = toScaled(data.quantity, 3);
  const perComponent = (
    key: string,
    rate: number | typeof CONFIG_REQUIRED | undefined,
    path: string,
    amount: (rateCents: bigint) => bigint | null,
    inputName: string,
  ) => {
    if (rate === undefined) return;
    if (rate === CONFIG_REQUIRED) {
      missing.push(`${servicePath}.${path}`);
      return;
    }
    const value = amount(BigInt(rate));
    if (value === null) {
      missing.push(`input.${inputName}`);
      return;
    }
    add(key, value);
  };
  perComponent(
    "PER_UNIT",
    serviceRule.perUnitCents,
    "perUnitCents",
    (r) => roundHalfUpDiv(r * quantityMilli, 1000n),
    "quantity",
  );
  perComponent(
    "PER_SQM",
    serviceRule.perSqmCents,
    "perSqmCents",
    (r) => (data.areaSqm === null ? null : roundHalfUpDiv(r * toScaled(data.areaSqm, 2), 100n)),
    "areaSqm",
  );
  perComponent(
    "PER_ROOM",
    serviceRule.perRoomCents,
    "perRoomCents",
    (r) => (data.rooms === null ? null : r * BigInt(data.rooms)),
    "rooms",
  );
  perComponent(
    "PER_BATHROOM",
    serviceRule.perBathroomCents,
    "perBathroomCents",
    (r) => (data.bathrooms === null ? null : r * BigInt(data.bathrooms)),
    "bathrooms",
  );
  perComponent(
    "PER_WINDOW",
    serviceRule.perWindowCents,
    "perWindowCents",
    (r) => (data.windows === null ? null : r * BigInt(data.windows)),
    "windows",
  );

  // Extras
  let extrasLaborMinutes = 0;
  for (const extraId of new Set(data.extraIds)) {
    const extra = rules.extras[extraId];
    if (extra === undefined) {
      missing.push(`extras.${extraId}`);
      continue;
    }
    extrasLaborMinutes += extra.laborMinutes;
    if (isSet(extra.priceCents)) {
      add(`EXTRA:${extraId}`, BigInt(extra.priceCents));
    } else {
      missing.push(`extras.${extraId}.priceCents`);
    }
  }

  // Relative adjustments (Häufigkeit, Dringlichkeit, Zuschläge, Rabatte)
  const adjustments: Record<string, number> = {};
  const frequencyBp = rules.frequencyAdjustmentBasisPoints[data.frequency];
  if (isSet(frequencyBp)) {
    if (frequencyBp !== 0) adjustments[`FREQUENCY:${data.frequency}`] = frequencyBp;
  } else {
    missing.push(`frequencyAdjustmentBasisPoints.${data.frequency}`);
  }
  const urgencyBp = rules.urgencySurchargeBasisPoints[data.urgency];
  if (isSet(urgencyBp)) {
    if (urgencyBp !== 0) adjustments[`URGENCY:${data.urgency}`] = urgencyBp;
  } else {
    missing.push(`urgencySurchargeBasisPoints.${data.urgency}`);
  }
  if (data.plannedStart !== null) {
    const { weekday, minuteOfDay } = data.plannedStart;
    for (const surcharge of rules.timeSurcharges) {
      if (
        surcharge.weekdays.includes(weekday) &&
        minuteOfDay >= surcharge.fromMinute &&
        minuteOfDay < surcharge.toMinute
      ) {
        adjustments[`TIME:${surcharge.key}`] = surcharge.basisPoints;
      }
    }
  } else if (rules.timeSurcharges.length > 0) {
    notes.push("TIME_SURCHARGE_NOT_EVALUATED_NO_DATE");
  }
  for (const key of new Set(data.discountKeys)) {
    const discount = rules.discounts.find((d) => d.key === key);
    if (discount === undefined) {
      throw new DomainError("VALIDATION_FAILED", "Unknown discount");
    }
    adjustments[`DISCOUNT:${key}`] = -discount.basisPoints;
  }

  // Entfernung
  let distanceCharge = 0n;
  if (rules.distance !== null) {
    const { includedKm, perKmCents } = rules.distance;
    if (!isSet(includedKm)) missing.push("distance.includedKm");
    if (!isSet(perKmCents)) missing.push("distance.perKmCents");
    if (data.distanceM === null) missing.push("input.distance");
    if (isSet(includedKm) && isSet(perKmCents) && data.distanceM !== null) {
      const chargeableM = BigInt(Math.max(0, data.distanceM - includedKm * 1000));
      distanceCharge = roundHalfUpDiv(BigInt(perKmCents) * chargeableM, 1000n);
    }
  }

  let minimumNet: bigint | null = null;
  if (serviceRule.minimumNetCents !== undefined) {
    if (isSet(serviceRule.minimumNetCents)) {
      minimumNet = BigInt(serviceRule.minimumNetCents);
    } else {
      missing.push(`${servicePath}.minimumNetCents`);
    }
  }

  if (missing.length > 0) {
    return { status: "CONFIG_REQUIRED", pricingVersion, missing: [...new Set(missing)].sort() };
  }

  const subtotal = components.reduce((sum, c) => sum + c.amount, 0n);
  const factorBp = 10_000 + Object.values(adjustments).reduce((sum, bp) => sum + bp, 0);
  if (factorBp < 1) {
    return { status: "CONFIG_REQUIRED", pricingVersion, missing: ["adjustments.totalNotPositive"] };
  }
  const adjusted = applyBasisPoints(subtotal, BigInt(factorBp));
  if (adjusted !== subtotal) {
    components.push({ key: "ADJUSTMENTS", amount: adjusted - subtotal });
  }
  if (distanceCharge > 0n) components.push({ key: "DISTANCE", amount: distanceCharge });
  let net = adjusted + distanceCharge;
  if (minimumNet !== null && net < minimumNet) {
    components.push({ key: "MINIMUM_PRICE", amount: minimumNet - net });
    net = minimumNet;
  }
  // A price of 0 EUR (or less) is never a valid offer: the rules must be completed first.
  if (net <= 0n) {
    return { status: "CONFIG_REQUIRED", pricingVersion, missing: ["result.nonPositivePrice"] };
  }
  const tax = applyBasisPoints(net, BigInt(context.taxRateBasisPoints));

  // Labour estimate and internal costs (do not influence the price).
  let laborMinutes: number | null = data.estimatedLaborMinutes;
  if (laborMinutes === null) {
    const d = data.duration;
    if (d.model === "FIXED" && d.baseMinutes !== null) {
      laborMinutes = d.baseMinutes + extrasLaborMinutes;
    } else if (d.model === "PER_UNIT" && d.perUnitSeconds !== null) {
      const seconds = roundHalfUpDiv(BigInt(d.perUnitSeconds) * quantityMilli, 1000n);
      laborMinutes =
        (d.baseMinutes ?? 0) + toSafeNumber(roundHalfUpDiv(seconds, 60n)) + extrasLaborMinutes;
    } else {
      notes.push("LABOR_ESTIMATE_REQUIRED");
    }
  }
  const directCosts = BigInt(data.directCostsCents);
  let internalCost: bigint | null = null;
  if (data.partnerCostCents !== null) {
    internalCost = BigInt(data.partnerCostCents) + directCosts;
  } else if (laborMinutes !== null && isSet(rules.costs.laborCostCentsPerHour)) {
    internalCost =
      roundHalfUpDiv(BigInt(laborMinutes) * BigInt(rules.costs.laborCostCentsPerHour), 60n) +
      directCosts;
  } else if (!isSet(rules.costs.laborCostCentsPerHour)) {
    notes.push("LABOR_COST_RATE_CONFIG_REQUIRED");
  }

  return {
    status: "CALCULATED",
    currency: context.currency,
    pricingVersion,
    net: toSafeNumber(net),
    taxRateBasisPoints: context.taxRateBasisPoints,
    tax: toSafeNumber(tax),
    gross: toSafeNumber(net + tax),
    estimatedLaborMinutes: laborMinutes,
    directCosts: toSafeNumber(directCosts),
    internalCost: internalCost === null ? null : toSafeNumber(internalCost),
    contributionMargin: internalCost === null ? null : toSafeNumber(net - internalCost),
    components: components.map((c) => ({ key: c.key, amountCents: toSafeNumber(c.amount) })),
    adjustmentsBasisPoints: adjustments,
    notes,
    requiresReview: true,
  };
}
