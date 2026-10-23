import { DomainError } from "@isela/shared";

/*
 * Invoice and payment arithmetic in integer cents (BigInt internally, no floating point).
 * Tax is computed by the quote module (`calculateTotals`, per VAT rate on the summed net
 * amounts, commercial half-up) – billing never re-implements tax rounding.
 */

/** Upper bound for a single payment or invoice amount (100 million EUR). */
export const MAX_AMOUNT_CENTS = 10_000_000_000;

function cents(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("VALIDATION_FAILED", `Invalid ${label}`);
  }
  return BigInt(value);
}

/** Outstanding amount of an invoice (never negative). */
export function outstandingCents(grossCents: number, paidCents: number): number {
  const gross = cents(grossCents, "gross amount");
  const paid = cents(paidCents, "paid amount");
  if (paid > gross) throw new DomainError("CONFLICT", "Paid amount exceeds the invoice");
  return Number(gross - paid);
}

export interface Allocation {
  /** Part of the payment applied to the invoice. */
  readonly appliedCents: number;
  /** Overpayment that is NOT applied (to be clarified/refunded; never silently kept). */
  readonly excessCents: number;
  /** Invoice paid amount after the allocation. */
  readonly paidAfterCents: number;
}

/** Applies a payment to an invoice: at most the outstanding amount, the rest is excess. */
export function allocatePayment(input: {
  readonly grossCents: number;
  readonly paidCents: number;
  readonly amountCents: number;
}): Allocation {
  const outstanding = BigInt(outstandingCents(input.grossCents, input.paidCents));
  const amount = cents(input.amountCents, "payment amount");
  if (amount === 0n || amount > BigInt(MAX_AMOUNT_CENTS)) {
    throw new DomainError("VALIDATION_FAILED", "Invalid payment amount");
  }
  const applied = amount < outstanding ? amount : outstanding;
  return {
    appliedCents: Number(applied),
    excessCents: Number(amount - applied),
    paidAfterCents: Number(BigInt(input.paidCents) + applied),
  };
}

/** Removes a previously applied amount (refund, chargeback). */
export function reverseAllocation(paidCents: number, appliedCents: number): number {
  const paid = cents(paidCents, "paid amount");
  const applied = cents(appliedCents, "applied amount");
  if (applied > paid) throw new DomainError("CONFLICT", "Applied amount exceeds the paid amount");
  return Number(paid - applied);
}
