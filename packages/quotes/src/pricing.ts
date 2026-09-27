import { DomainError } from "@isela/shared";
import { z } from "@isela/validation";

/*
 * Quote arithmetic in integer cents (BigInt internally – no floating-point money). Rounding
 * is commercial half-up. Line amounts are informational; the quote's tax is computed once per
 * VAT rate on the summed net amounts, as on the later invoice.
 */

export const MAX_QUANTITY = 1_000_000;
export const MAX_UNIT_PRICE_CENTS = 100_000_000;
const QUANTITY_SCALE = 1000n;

/** Quantity with at most three decimals (matches numeric(12,3)). */
export const quantitySchema = z
  .number()
  .positive()
  .max(MAX_QUANTITY)
  .refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, {
    message: "At most three decimal places",
  });

export const unitPriceCentsSchema = z.number().int().min(0).max(MAX_UNIT_PRICE_CENTS);

function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new DomainError("VALIDATION_FAILED", "Amounts must not be negative");
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError("VALIDATION_FAILED", "Amount too large");
  }
  return Number(value);
}

export function quantityToMilli(quantity: number): bigint {
  const parsed = quantitySchema.safeParse(quantity);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", "Invalid quantity");
  }
  return BigInt(Math.round(parsed.data * 1000));
}

export interface LineInput {
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly taxRateBasisPoints: number;
}

export interface Amounts {
  readonly netCents: number;
  readonly taxCents: number;
  readonly grossCents: number;
}

function taxOf(netCents: bigint, taxRateBasisPoints: number): bigint {
  if (
    !Number.isInteger(taxRateBasisPoints) ||
    taxRateBasisPoints < 0 ||
    taxRateBasisPoints > 10_000
  ) {
    throw new DomainError("VALIDATION_FAILED", "Invalid tax rate");
  }
  return roundHalfUpDiv(netCents * BigInt(taxRateBasisPoints), 10_000n);
}

export function calculateLine(line: LineInput): Amounts {
  const unitPrice = unitPriceCentsSchema.safeParse(line.unitPriceCents);
  if (!unitPrice.success) {
    throw new DomainError("VALIDATION_FAILED", "Invalid unit price");
  }
  const net = roundHalfUpDiv(
    quantityToMilli(line.quantity) * BigInt(unitPrice.data),
    QUANTITY_SCALE,
  );
  const tax = taxOf(net, line.taxRateBasisPoints);
  return {
    netCents: toSafeNumber(net),
    taxCents: toSafeNumber(tax),
    grossCents: toSafeNumber(net + tax),
  };
}

export interface QuoteTotals extends Amounts {
  readonly taxByRate: readonly {
    readonly taxRateBasisPoints: number;
    readonly netCents: number;
    readonly taxCents: number;
  }[];
}

export function calculateTotals(
  lines: readonly { readonly netCents: number; readonly taxRateBasisPoints: number }[],
): QuoteTotals {
  const byRate = new Map<number, bigint>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.netCents) || line.netCents < 0) {
      throw new DomainError("VALIDATION_FAILED", "Invalid line amount");
    }
    byRate.set(
      line.taxRateBasisPoints,
      (byRate.get(line.taxRateBasisPoints) ?? 0n) + BigInt(line.netCents),
    );
  }
  let net = 0n;
  let tax = 0n;
  const taxByRate = [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, rateNet]) => {
      const rateTax = taxOf(rateNet, rate);
      net += rateNet;
      tax += rateTax;
      return {
        taxRateBasisPoints: rate,
        netCents: toSafeNumber(rateNet),
        taxCents: toSafeNumber(rateTax),
      };
    });
  return {
    netCents: toSafeNumber(net),
    taxCents: toSafeNumber(tax),
    grossCents: toSafeNumber(net + tax),
    taxByRate,
  };
}

/*
 * Pricing engine contract (interface only). A pricing engine PROPOSES amounts from
 * configured, versioned rate data; a proposal is never a price commitment and always needs
 * a person's review before it becomes part of a quote. No engine is implemented yet because
 * no approved rate data exists – prices are entered manually by authorised staff.
 */

export const pricingInputSchema = z.strictObject({
  serviceKey: z.string().trim().min(1).max(64),
  propertyType: z.string().trim().min(1).max(64).nullable(),
  areaSqm: z.number().positive().max(1_000_000).nullable(),
  rooms: z.number().int().min(0).max(10_000).nullable(),
  bathrooms: z.number().int().min(0).max(10_000).nullable(),
  windows: z.number().int().min(0).max(100_000).nullable(),
  frequency: z.enum(["ONCE", "WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM"]),
  extras: z.array(z.string().trim().min(1).max(64)).max(20),
  urgency: z.enum(["STANDARD", "EXPRESS"]),
  distanceKm: z.number().min(0).max(1000).nullable(),
  /** Service area key – regional rates are data, never code branches. */
  regionKey: z.string().trim().min(1).max(64).nullable(),
  estimatedLaborMinutes: z.number().int().min(0).max(100_000).nullable(),
  directCostsCents: z.number().int().min(0).max(MAX_UNIT_PRICE_CENTS),
});

export type PricingInput = z.infer<typeof pricingInputSchema>;

export interface PricingProposal extends Amounts {
  readonly expectedLaborMinutes: number;
  readonly directCostsCents: number;
  readonly contributionMarginCents: number;
  /** Version of the rate data used (traceability). */
  readonly rateVersion: string;
  /** Always true: proposals are reviewed by a person before they reach a customer. */
  readonly requiresReview: true;
}

export interface PricingEngine {
  readonly key: string;
  propose(input: PricingInput): Promise<PricingProposal>;
}

/**
 * Contribution margin of a (proposed or manual) price. The labour cost rate is an input
 * (configured per company), never a constant in code.
 */
export function contributionMargin(input: {
  readonly netCents: number;
  readonly expectedLaborMinutes: number;
  readonly laborCostCentsPerHour: number;
  readonly directCostsCents: number;
}): { readonly laborCostCents: number; readonly contributionMarginCents: number } {
  for (const value of Object.values(input)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DomainError("VALIDATION_FAILED", "Invalid pricing input");
    }
  }
  const laborCost = roundHalfUpDiv(
    BigInt(input.expectedLaborMinutes) * BigInt(input.laborCostCentsPerHour),
    60n,
  );
  return {
    laborCostCents: toSafeNumber(laborCost),
    contributionMarginCents: input.netCents - toSafeNumber(laborCost) - input.directCostsCents,
  };
}
