import { z } from "@isela/validation";

/**
 * Quote configuration (setting key `quote.defaults`). Tax rates and validity are data, not
 * code; the defaults below are the current German VAT rates and must be confirmed by the
 * business owner / tax adviser before production use.
 */
export const quoteConfigSchema = z
  .strictObject({
    /** Allowed VAT rates in basis points (1900 = 19 %). */
    vatRatesBasisPoints: z.array(z.number().int().min(0).max(10_000)).min(1).max(5),
    defaultVatRateBasisPoints: z.number().int().min(0).max(10_000),
    /** Validity applied when a quote is released without an explicit date. */
    validityDays: z.number().int().min(1).max(365),
    maxItemsPerQuote: z.number().int().min(1).max(200),
    /** Approver must differ from the quote's creator. */
    requireFourEyesApproval: z.boolean(),
    /** IANA time zone that defines "today" for validity dates. */
    timeZone: z.string().refine(isTimeZone, { message: "Unknown time zone" }),
  })
  .refine((c) => new Set(c.vatRatesBasisPoints).size === c.vatRatesBasisPoints.length, {
    message: "VAT rates must be unique",
    path: ["vatRatesBasisPoints"],
  })
  .refine((c) => c.vatRatesBasisPoints.includes(c.defaultVatRateBasisPoints), {
    message: "Default VAT rate must be one of the allowed rates",
    path: ["defaultVatRateBasisPoints"],
  });

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date (YYYY-MM-DD) of `at` in the configured time zone. */
export function businessDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Adds calendar days to an ISO date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type QuoteConfig = z.infer<typeof quoteConfigSchema>;

export const DEFAULT_QUOTE_CONFIG: QuoteConfig = {
  vatRatesBasisPoints: [1900, 700, 0],
  defaultVatRateBasisPoints: 1900,
  validityDays: 30,
  maxItemsPerQuote: 50,
  requireFourEyesApproval: false,
  timeZone: "Europe/Berlin",
};
