import { businessDateTime } from "@isela/shared";
import { z } from "@isela/validation";

/*
 * Recurring cleaning (day 8). Pure, deterministic expansion of a recurrence rule into
 * concrete appointments. Holidays and pauses are INPUTS – this module contains no calendar
 * data. Appointments that fall on a holiday or into a pause are reported as skipped (never
 * silently moved), so a person decides about replacements.
 *
 * Supported rules (PRODUCT_SPEC §1.3): WEEKLY and BIWEEKLY on the weekday of the start date,
 * MONTHLY on the day of month of the start date (1–28, so every month has that day). CUSTOM
 * (RRULE) is not supported yet.
 */

export const RECURRENCE_FREQUENCIES = ["WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const OCCURRENCE_SKIP_REASONS = ["HOLIDAY", "PAUSED", "INVALID_LOCAL_TIME"] as const;
export type OccurrenceSkipReason = (typeof OCCURRENCE_SKIP_REASONS)[number];

/** Hard upper bound of appointments per expansion (protects against runaway windows). */
export const MAX_OCCURRENCES_PER_EXPANSION = 400;

const isoDate = z.iso.date();
const minute = z.number().int().min(0).max(1439);

export const recurrenceRuleSchema = z
  .strictObject({
    frequency: z.enum(RECURRENCE_FREQUENCIES),
    startDate: isoDate,
    /** Inclusive; null = open-ended. */
    endDate: isoDate.nullable(),
    /** Local time window of each appointment (minutes after local midnight). */
    windowStartMinute: minute,
    windowEndMinute: z.number().int().min(1).max(1440),
  })
  .refine((r) => r.windowEndMinute > r.windowStartMinute, {
    message: "The window must end after it starts",
    path: ["windowEndMinute"],
  })
  .refine((r) => r.endDate === null || r.endDate >= r.startDate, {
    message: "The end date must not be before the start date",
    path: ["endDate"],
  })
  .refine((r) => r.frequency !== "MONTHLY" || Number(r.startDate.slice(8, 10)) <= 28, {
    message: "Monthly rules must start on day 1–28",
    path: ["startDate"],
  });

export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;

export interface DateRange {
  /** Inclusive calendar days "YYYY-MM-DD". */
  readonly from: string;
  readonly to: string;
}

export interface ExpansionContext {
  readonly timeZone: string;
  /** Holiday calendar days of the relevant region (verified data, see public_holiday). */
  readonly holidays: ReadonlySet<string>;
  /** Paused periods (inclusive calendar days). */
  readonly pauses: readonly DateRange[];
}

export interface Occurrence {
  readonly date: string;
  /** null when the appointment is skipped because its local time does not exist. */
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
  readonly skipReason: OccurrenceSkipReason | null;
}

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;
}

function dayString(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Candidate dates of the rule within [from, to] (both inclusive), in ascending order. */
function ruleDates(rule: RecurrenceRule, from: string, to: string): string[] {
  const last = rule.endDate !== null && rule.endDate < to ? rule.endDate : to;
  const first = rule.startDate > from ? rule.startDate : from;
  if (last < first) return [];
  const dates: string[] = [];
  if (rule.frequency === "MONTHLY") {
    for (let i = 0; ; i += 1) {
      const date = addMonths(rule.startDate, i);
      if (date > last) break;
      if (date >= first) dates.push(date);
      if (dates.length > MAX_OCCURRENCES_PER_EXPANSION) break;
    }
    return dates;
  }
  const step = rule.frequency === "WEEKLY" ? 7 : 14;
  const start = dayNumber(rule.startDate);
  const lo = dayNumber(first);
  const offset = (((lo - start) % step) + step) % step;
  for (let n = offset === 0 ? lo : lo + (step - offset); n <= dayNumber(last); n += step) {
    dates.push(dayString(n));
    if (dates.length > MAX_OCCURRENCES_PER_EXPANSION) break;
  }
  return dates;
}

function inPause(date: string, pauses: readonly DateRange[]): boolean {
  return pauses.some((p) => p.from <= date && date <= p.to);
}

/**
 * Appointments of `rule` in `range`. Deterministic: the same input always yields the same
 * output. Throws when the input is invalid or the expansion would exceed
 * MAX_OCCURRENCES_PER_EXPANSION (the caller must use a smaller window).
 */
export function expandOccurrences(
  ruleInput: RecurrenceRule,
  range: DateRange,
  context: ExpansionContext,
): Occurrence[] {
  const rule = recurrenceRuleSchema.parse(ruleInput);
  const from = isoDate.parse(range.from);
  const to = isoDate.parse(range.to);
  if (to < from) throw new RangeError("The range must not end before it starts");
  for (const pause of context.pauses) {
    if (isoDate.parse(pause.to) < isoDate.parse(pause.from)) {
      throw new RangeError("A pause must not end before it starts");
    }
  }
  const dates = ruleDates(rule, from, to);
  if (dates.length > MAX_OCCURRENCES_PER_EXPANSION) {
    throw new RangeError("Too many appointments in the range; use a smaller window");
  }
  return dates.map((date): Occurrence => {
    const start = businessDateTime(date, rule.windowStartMinute, context.timeZone);
    const end =
      rule.windowEndMinute === 1440
        ? businessDateTime(dayString(dayNumber(date) + 1), 0, context.timeZone)
        : businessDateTime(date, rule.windowEndMinute, context.timeZone);
    let skipReason: OccurrenceSkipReason | null = null;
    if (context.holidays.has(date)) skipReason = "HOLIDAY";
    else if (inPause(date, context.pauses)) skipReason = "PAUSED";
    else if (start === null || end === null || end.getTime() <= start.getTime()) {
      skipReason = "INVALID_LOCAL_TIME";
    }
    return {
      date,
      windowStart: skipReason === "INVALID_LOCAL_TIME" ? null : start,
      windowEnd: skipReason === "INVALID_LOCAL_TIME" ? null : end,
      skipReason,
    };
  });
}

/** Calendar years touched by a range (holiday data must be verified for each of them). */
export function yearsOf(range: DateRange): number[] {
  const years: number[] = [];
  for (let y = Number(range.from.slice(0, 4)); y <= Number(range.to.slice(0, 4)); y += 1) {
    years.push(y);
  }
  return years;
}
