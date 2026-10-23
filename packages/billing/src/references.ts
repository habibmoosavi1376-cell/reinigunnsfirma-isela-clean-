import { DomainError } from "@isela/shared";

/*
 * Payment references must identify a transaction (bank statement entry, provider transaction
 * id) – never contain card numbers, CVV, PINs or secrets. A digit run of 13–19 digits that
 * passes the Luhn check is treated as a possible card number and rejected.
 */

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function containsPossibleCardNumber(text: string): boolean {
  // Card numbers are written as one run, optionally grouped by spaces or dashes.
  for (const match of text.matchAll(/(?<!\d)\d(?:[\s-]?\d){12,18}(?![\s-]?\d)/g)) {
    const digits = match[0].replace(/[\s-]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

const SENSITIVE_WORDS = /\b(cvv|cvc|pin|passwort|password|secret|token)\b/i;

/** Normalises and validates a payment reference; throws for sensitive content. */
export function normalizePaymentReference(reference: string): string {
  const value = reference.trim().replace(/\s+/g, " ");
  if (value.length < 3 || value.length > 200) {
    throw new DomainError("VALIDATION_FAILED", "Invalid payment reference");
  }
  if (containsPossibleCardNumber(value) || SENSITIVE_WORDS.test(value)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The reference must not contain card or secret data",
      {
        field: "reference",
      },
    );
  }
  return value;
}
