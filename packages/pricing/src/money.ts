import { DomainError } from "@isela/shared";

/*
 * Exact money arithmetic for the pricing engine: integer cents in BigInt, commercial
 * half-up rounding, rates in basis points (1 % = 100 bp). No floating point is ever used for
 * money; quantities are scaled integers (milli units, centi square metres).
 */

/** Upper bound for any single amount (100 million EUR) – rejects absurd inputs. */
export const MAX_CENTS = 10_000_000_000;

export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new DomainError("VALIDATION_FAILED", "Invalid denominator");
  }
  if (numerator < 0n) {
    return -roundHalfUpDiv(-numerator, denominator);
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** amount × basisPoints / 10 000, rounded half-up. */
export function applyBasisPoints(amountCents: bigint, basisPoints: bigint): bigint {
  return roundHalfUpDiv(amountCents * basisPoints, 10_000n);
}

export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DomainError("VALIDATION_FAILED", "Amount too large");
  }
  return Number(value);
}

/**
 * Converts a decimal quantity with at most `decimals` places into a scaled integer without
 * floating-point drift (e.g. 12.345 with 3 decimals → 12345n).
 */
export function toScaled(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainError("VALIDATION_FAILED", "Invalid quantity");
  }
  const factor = 10 ** decimals;
  const scaled = Math.round(value * factor);
  if (Math.abs(value * factor - scaled) > 1e-6) {
    throw new DomainError("VALIDATION_FAILED", `At most ${String(decimals)} decimal places`);
  }
  return BigInt(scaled);
}
