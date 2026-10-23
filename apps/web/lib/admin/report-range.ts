/**
 * Report period from untrusted query parameters (framework-free, unit-tested).
 * Dates are calendar days in UTC; `to` is inclusive for the user and exclusive internally.
 */
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: unknown): Date | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface ReportRange {
  /** inclusive */
  readonly from: Date;
  /** exclusive (start of the day after the last selected day) */
  readonly to: Date;
  /** false = the parameters were missing or invalid and the default range is used. */
  readonly valid: boolean;
}

export function parseReportRange(
  params: Record<string, string | string[] | undefined>,
  now: Date,
  defaultDays = 30,
  maxDays = 400,
): ReportRange {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fallback = {
    from: new Date(today.getTime() - (defaultDays - 1) * DAY_MS),
    to: new Date(today.getTime() + DAY_MS),
  };
  if (params["from"] === undefined && params["to"] === undefined) {
    return { ...fallback, valid: true };
  }
  const from = parseDay(params["from"]);
  const lastDay = parseDay(params["to"]);
  if (from === null || lastDay === null) return { ...fallback, valid: false };
  const to = new Date(lastDay.getTime() + DAY_MS);
  if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > maxDays * DAY_MS) {
    return { ...fallback, valid: false };
  }
  if (to.getTime() > today.getTime() + DAY_MS) return { ...fallback, valid: false };
  return { from, to, valid: true };
}
