import { businessDayEnd, businessDayStart } from "@isela/shared";

/**
 * Report period from untrusted query parameters (framework-free, unit-tested).
 * Dates are calendar days in the business time zone (UTC when none is given); `to` is
 * inclusive for the user and exclusive internally (start of the following local day).
 */
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: unknown): string | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

/** Calendar arithmetic on "YYYY-MM-DD" (time-zone independent). */
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;
}

/** Calendar day of an instant in the given time zone. */
export function businessDateOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}

export interface ReportRange {
  /** inclusive */
  readonly from: Date;
  /** exclusive (start of the day after the last selected day) */
  readonly to: Date;
  /** First and last selected calendar day ("YYYY-MM-DD", both inclusive). */
  readonly fromDay: string;
  readonly lastDay: string;
  /** false = the parameters were missing or invalid and the default range is used. */
  readonly valid: boolean;
}

function rangeOf(fromDay: string, lastDay: string, timeZone: string, valid: boolean): ReportRange {
  const from = businessDayStart(fromDay, timeZone);
  const to = businessDayEnd(lastDay, timeZone);
  if (from === null || to === null) throw new Error("Invalid report range");
  return { from, to, fromDay, lastDay, valid };
}

export function parseReportRange(
  params: Record<string, string | string[] | undefined>,
  now: Date,
  defaultDays = 30,
  maxDays = 400,
  timeZone = "UTC",
): ReportRange {
  const today = businessDateOf(now, timeZone);
  const fallback = (valid: boolean) =>
    rangeOf(shiftDay(today, -(defaultDays - 1)), today, timeZone, valid);
  if (params["from"] === undefined && params["to"] === undefined) return fallback(true);
  const fromDay = parseDay(params["from"]);
  const lastDay = parseDay(params["to"]);
  if (fromDay === null || lastDay === null) return fallback(false);
  const days = dayNumber(lastDay) - dayNumber(fromDay) + 1;
  if (days < 1 || days > maxDays) return fallback(false);
  if (dayNumber(lastDay) > dayNumber(today)) return fallback(false);
  return rangeOf(fromDay, lastDay, timeZone, true);
}
