import { z } from "zod";
import { DomainError } from "@isela/shared";

/**
 * Parses untrusted input with a schema. On failure a VALIDATION_FAILED error is thrown
 * that lists only the failing paths and issue codes – never the submitted values,
 * which may contain personal data.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError("VALIDATION_FAILED", "Input validation failed", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        code: issue.code,
      })),
    });
  }
  return result.data;
}

export const uuidSchema = z.uuid();

export function trimmedText(maxLength: number) {
  return z.string().trim().min(1).max(maxLength);
}

/** ISO 3166-1 alpha-2 country code, normalised to upper case. */
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Expected ISO 3166-1 alpha-2 country code");

export const emailSchema = z.email().max(254);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normalises a phone number to an E.164-like form (`+` followed by digits).
 * National numbers (leading `0`) are interpreted for the given country.
 * Returns `null` when the input cannot be a phone number.
 */
export function normalizePhone(raw: string, defaultCountry = "DE"): string | null {
  const compact = raw.replace(/[\s()./-]/g, "");
  let digits: string;
  if (compact.startsWith("+")) {
    digits = compact.slice(1);
  } else if (compact.startsWith("00")) {
    digits = compact.slice(2);
  } else if (compact.startsWith("0")) {
    const prefix = COUNTRY_CALLING_CODES[defaultCountry];
    if (prefix === undefined) {
      return null;
    }
    digits = prefix + compact.slice(1);
  } else {
    return null;
  }
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

const COUNTRY_CALLING_CODES: Readonly<Record<string, string>> = {
  DE: "49",
  AT: "43",
  CH: "41",
  NL: "31",
  BE: "32",
  LU: "352",
  FR: "33",
  PL: "48",
  DK: "45",
  CZ: "420",
};

export const phoneSchema = z
  .string()
  .trim()
  .max(40)
  .refine((value) => normalizePhone(value) !== null, "Invalid phone number");

const POSTAL_CODE_PATTERNS: Readonly<Record<string, RegExp>> = {
  DE: /^\d{5}$/,
  AT: /^\d{4}$/,
  CH: /^\d{4}$/,
  NL: /^\d{4}\s?[A-Z]{2}$/,
};

/** Validates a postal code for a country; unknown countries use a permissive pattern. */
export function isValidPostalCode(code: string, country: string): boolean {
  const pattern = POSTAL_CODE_PATTERNS[country.toUpperCase()] ?? /^[A-Z0-9][A-Z0-9 -]{1,9}$/i;
  return pattern.test(code.trim());
}

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export { z };
