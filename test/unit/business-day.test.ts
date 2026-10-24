import { describe, expect, it } from "vitest";
import { businessDateTime, businessDayEnd, businessDayStart } from "@isela/shared";

// Regression (integration gate F7): date filters read "YYYY-MM-DD" as UTC midnight, which
// shifted the boundaries by the business time zone offset.
describe("business-local day boundaries", () => {
  const TZ = "Europe/Berlin";

  it("starts the day at local midnight in summer and winter time", () => {
    expect(businessDayStart("2026-10-14", TZ)?.toISOString()).toBe("2026-10-13T22:00:00.000Z");
    expect(businessDayStart("2026-12-01", TZ)?.toISOString()).toBe("2026-11-30T23:00:00.000Z");
  });

  it("ends the day at the next local midnight, also across the DST change", () => {
    expect(businessDayEnd("2026-10-24", TZ)?.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    // 2026-10-25 has 25 hours in Berlin (CEST -> CET).
    expect(businessDayEnd("2026-10-25", TZ)?.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    // 2026-03-29 has 23 hours (CET -> CEST).
    expect(businessDayEnd("2026-03-29", TZ)?.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(businessDayEnd("2026-12-31", TZ)?.toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });

  it("is UTC midnight for the UTC zone (unchanged behaviour without a business zone)", () => {
    expect(businessDayStart("2026-10-14", "UTC")?.toISOString()).toBe("2026-10-14T00:00:00.000Z");
  });

  it("rejects malformed and impossible dates", () => {
    for (const bad of ["", "14.10.2026", "2026-13-01", "2026-02-30", "2026-1-1"]) {
      expect(businessDayStart(bad, TZ), bad).toBeNull();
      expect(businessDayEnd(bad, TZ), bad).toBeNull();
    }
  });

  it("converts local wall-clock times and rejects times in the spring-forward gap", () => {
    expect(businessDateTime("2026-10-14", 9 * 60, TZ)?.toISOString()).toBe(
      "2026-10-14T07:00:00.000Z",
    );
    expect(businessDateTime("2026-12-01", 9 * 60, TZ)?.toISOString()).toBe(
      "2026-12-01T08:00:00.000Z",
    );
    // 2026-03-29 02:30 does not exist in Berlin.
    expect(businessDateTime("2026-03-29", 150, TZ)).toBeNull();
    expect(businessDateTime("2026-03-29", 180, TZ)?.toISOString()).toBe("2026-03-29T01:00:00.000Z");
    // 2026-10-25 02:30 exists twice: the earlier instant (CEST) is used.
    expect(businessDateTime("2026-10-25", 150, TZ)?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(businessDateTime("2026-10-14", 1440, TZ)).toBeNull();
    expect(businessDateTime("2026-02-30", 600, TZ)).toBeNull();
  });
});
