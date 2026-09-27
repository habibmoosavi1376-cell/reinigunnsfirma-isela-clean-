/** Display formatting for the back office (German locale). No logic depends on it. */

export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

export function formatDateTime(date: Date | null | undefined): string {
  return date == null ? "–" : date.toLocaleString("de-DE");
}

export function formatDate(value: Date | string | null | undefined): string {
  if (value == null) return "–";
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
  return date.toLocaleDateString("de-DE", { timeZone: "UTC" });
}

export function formatTaxRate(basisPoints: number): string {
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(basisPoints / 100)} %`;
}

/** Converts a German money input ("1.234,56", "12,5", "12") into integer cents. */
export function parseMoneyToCents(input: string): number | null {
  const normalized = input.trim().replace(/\s|€/g, "").replace(/\./g, "").replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(normalized)) return null;
  const [euros = "0", fraction = ""] = normalized.split(".");
  return Number(euros) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Converts a German decimal input ("2,5") into a number with at most three decimals. */
export function parseDecimal(input: string): number | null {
  const normalized = input.trim().replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(normalized)) return null;
  return Number(normalized);
}
