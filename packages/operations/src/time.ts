/*
 * Business-local time helpers (Intl only, no floating-point, no library). Working windows and
 * business dates are interpreted in the configured IANA time zone.
 */

const WEEKDAYS: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export interface LocalTime {
  /** YYYY-MM-DD */
  readonly date: string;
  /** ISO weekday, 1 = Monday. */
  readonly weekday: number;
  /** Minutes since local midnight (0–1439). */
  readonly minuteOfDay: number;
}

export function localTime(at: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAYS[get("weekday")];
  if (weekday === undefined) {
    throw new Error("Unexpected weekday format");
  }
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday,
    minuteOfDay: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Local start/end of an interval. The end minute is reported as 1440 when the interval ends
 * exactly at local midnight of the start day. Returns null when the interval spans several
 * local days (not supported by weekly working windows).
 */
export function localInterval(
  start: Date,
  end: Date,
  timeZone: string,
): { date: string; weekday: number; startMinute: number; endMinute: number } | null {
  const s = localTime(start, timeZone);
  const e = localTime(end, timeZone);
  if (e.date === s.date) {
    return {
      date: s.date,
      weekday: s.weekday,
      startMinute: s.minuteOfDay,
      endMinute: e.minuteOfDay,
    };
  }
  // Ends exactly at the following local midnight.
  const lastMinute = localTime(new Date(end.getTime() - 60_000), timeZone);
  if (lastMinute.date === s.date && e.minuteOfDay === 0) {
    return { date: s.date, weekday: s.weekday, startMinute: s.minuteOfDay, endMinute: 1440 };
  }
  return null;
}
