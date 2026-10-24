/**
 * Business-local calendar days ("YYYY-MM-DD") as instants. Filters such as "created from/to"
 * must use the start of the day in the business time zone; reading the date as UTC midnight
 * shifts the boundary by the UTC offset (Europe/Berlin: 1–2 hours). Pure Intl arithmetic,
 * daylight-saving safe.
 */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function localParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** Start of the business-local day; null for malformed or impossible dates. */
export function businessDayStart(date: string, timeZone: string): Date | null {
  const match = DATE.exec(date);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const wallClock = Date.UTC(year, month - 1, day);
  if (new Date(wallClock).toISOString().slice(0, 10) !== date) return null;
  let guess = wallClock;
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(guess, timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
    guess = wallClock - offset;
  }
  // Midnight can be skipped by a DST change in a few zones: fall back to the first local
  // minute of that day.
  while (localParts(guess, timeZone).day !== day) guess += 60_000;
  return new Date(guess);
}

/** Start of the business-local day AFTER `date` (exclusive upper bound for "to" filters). */
export function businessDayEnd(date: string, timeZone: string): Date | null {
  const start = businessDayStart(date, timeZone);
  if (start === null) return null;
  const next = new Date(Date.UTC(...ymd(date)) + 86_400_000).toISOString().slice(0, 10);
  return businessDayStart(next, timeZone);
}

function ymd(date: string): [number, number, number] {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return [y, m - 1, d];
}

/**
 * Instant of a business-local wall-clock time (`minuteOfDay` 0–1439 on `date`). Returns null
 * for malformed input and for local times that do not exist (spring-forward gap). For
 * ambiguous times (fall-back hour) the earlier instant is returned.
 */
export function businessDateTime(date: string, minuteOfDay: number, timeZone: string): Date | null {
  const match = DATE.exec(date);
  if (match === null || !Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1439) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wallClock).toISOString().slice(0, 10) !== date) return null;
  // Try both offsets that occur around the instant; prefer the earlier valid one.
  const candidates = new Set<number>();
  for (const probe of [wallClock - 86_400_000, wallClock, wallClock + 86_400_000]) {
    const p = localParts(probe, timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - probe;
    candidates.add(wallClock - offset);
  }
  const valid = [...candidates]
    .filter((ms) => {
      const p = localParts(ms, timeZone);
      return (
        p.year === year &&
        p.month === month &&
        p.day === day &&
        p.hour === hour &&
        p.minute === minute
      );
    })
    .sort((a, b) => a - b);
  const first = valid[0];
  return first === undefined ? null : new Date(first);
}
