import { describe, expect, it } from "vitest";
import {
  MAX_OCCURRENCES_PER_EXPANSION,
  expandOccurrences,
  yearsOf,
  type RecurrenceRule,
} from "@isela/operations";

const TZ = "Europe/Berlin";
const none = { timeZone: TZ, holidays: new Set<string>(), pauses: [] };

function rule(overrides: Partial<RecurrenceRule> = {}): RecurrenceRule {
  return {
    frequency: "WEEKLY",
    startDate: "2026-10-05", // Monday
    endDate: null,
    windowStartMinute: 8 * 60,
    windowEndMinute: 12 * 60,
    ...overrides,
  };
}

describe("recurrence expansion", () => {
  it("expands weekly and biweekly rules on the weekday of the start date", () => {
    const weekly = expandOccurrences(rule(), { from: "2026-10-01", to: "2026-10-31" }, none);
    expect(weekly.map((o) => o.date)).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
    const biweekly = expandOccurrences(
      rule({ frequency: "BIWEEKLY" }),
      { from: "2026-10-13", to: "2026-11-30" },
      none,
    );
    expect(biweekly.map((o) => o.date)).toEqual([
      "2026-10-19",
      "2026-11-02",
      "2026-11-16",
      "2026-11-30",
    ]);
  });

  it("expands monthly rules on the start day and refuses days 29–31", () => {
    const monthly = expandOccurrences(
      rule({ frequency: "MONTHLY", startDate: "2026-11-28" }),
      { from: "2026-11-01", to: "2027-03-31" },
      none,
    );
    expect(monthly.map((o) => o.date)).toEqual([
      "2026-11-28",
      "2026-12-28",
      "2027-01-28",
      "2027-02-28",
      "2027-03-28",
    ]);
    expect(() =>
      expandOccurrences(
        rule({ frequency: "MONTHLY", startDate: "2026-10-31" }),
        { from: "2026-10-01", to: "2026-12-31" },
        none,
      ),
    ).toThrow();
  });

  it("respects start and end dates of the rule (inclusive)", () => {
    const bounded = expandOccurrences(
      rule({ endDate: "2026-10-19" }),
      { from: "2026-09-01", to: "2026-12-31" },
      none,
    );
    expect(bounded.map((o) => o.date)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(expandOccurrences(rule(), { from: "2026-09-01", to: "2026-10-04" }, none)).toEqual([]);
  });

  it("converts the local window with the correct offset across the DST change", () => {
    const [summer, winter] = expandOccurrences(
      rule({ startDate: "2026-10-19" }),
      { from: "2026-10-19", to: "2026-10-26" },
      none,
    );
    expect(summer?.windowStart?.toISOString()).toBe("2026-10-19T06:00:00.000Z");
    expect(winter?.windowStart?.toISOString()).toBe("2026-10-26T07:00:00.000Z");
    expect(winter?.windowEnd?.toISOString()).toBe("2026-10-26T11:00:00.000Z");
  });

  it("skips (never moves) holidays and paused days, and nonexistent local times", () => {
    const result = expandOccurrences(
      rule(),
      { from: "2026-10-05", to: "2026-10-26" },
      {
        timeZone: TZ,
        holidays: new Set(["2026-10-12"]),
        pauses: [{ from: "2026-10-19", to: "2026-10-20" }],
      },
    );
    expect(result.map((o) => [o.date, o.skipReason])).toEqual([
      ["2026-10-05", null],
      ["2026-10-12", "HOLIDAY"],
      ["2026-10-19", "PAUSED"],
      ["2026-10-26", null],
    ]);
    // 02:30 on 2026-03-29 does not exist in Berlin.
    const gap = expandOccurrences(
      rule({ startDate: "2026-03-29", windowStartMinute: 150, windowEndMinute: 300 }),
      { from: "2026-03-29", to: "2026-03-29" },
      none,
    );
    expect(gap).toEqual([
      { date: "2026-03-29", windowStart: null, windowEnd: null, skipReason: "INVALID_LOCAL_TIME" },
    ]);
  });

  it("is deterministic and yields unique dates", () => {
    const a = expandOccurrences(rule(), { from: "2026-01-01", to: "2026-12-31" }, none);
    const b = expandOccurrences(rule(), { from: "2026-01-01", to: "2026-12-31" }, none);
    expect(a).toEqual(b);
    expect(new Set(a.map((o) => o.date)).size).toBe(a.length);
  });

  it("rejects invalid input and runaway ranges", () => {
    for (const bad of [
      rule({ windowEndMinute: 8 * 60 }),
      rule({ endDate: "2026-10-01" }),
      rule({ startDate: "2026-02-30" }),
    ]) {
      expect(() =>
        expandOccurrences(bad, { from: "2026-10-01", to: "2026-10-31" }, none),
      ).toThrow();
    }
    expect(() =>
      expandOccurrences(rule(), { from: "2026-10-31", to: "2026-10-01" }, none),
    ).toThrow();
    expect(() =>
      expandOccurrences(
        rule(),
        { from: "2026-10-01", to: "2026-10-31" },
        { ...none, pauses: [{ from: "2026-10-10", to: "2026-10-01" }] },
      ),
    ).toThrow();
    const days = MAX_OCCURRENCES_PER_EXPANSION * 7 + 14;
    const to = new Date(Date.parse("2026-10-05T00:00:00Z") + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(() => expandOccurrences(rule(), { from: "2026-10-05", to }, none)).toThrow(/smaller/);
  });

  it("lists the calendar years of a range", () => {
    expect(yearsOf({ from: "2026-12-01", to: "2027-01-31" })).toEqual([2026, 2027]);
  });
});
