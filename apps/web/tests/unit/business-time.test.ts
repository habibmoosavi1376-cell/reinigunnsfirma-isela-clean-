import { describe, expect, it } from "vitest";
import { businessDayStartIso } from "@/lib/admin/time";

// Regression (integration gate): a payment received "today" was rejected as a future date
// between local and UTC midnight, because the form date was read as UTC midnight.
describe("business-local payment receipt date", () => {
  it("is the start of the local day, not UTC midnight (summer time)", () => {
    expect(businessDayStartIso("2026-10-14", "Europe/Berlin")).toBe("2026-10-13T22:00:00.000Z");
  });

  it("follows the winter-time offset", () => {
    expect(businessDayStartIso("2026-12-01", "Europe/Berlin")).toBe("2026-11-30T23:00:00.000Z");
  });

  it("is never in the future for today's date shortly after local midnight", () => {
    const now = new Date("2026-10-13T22:05:00Z"); // 00:05 on 2026-10-14 in Berlin
    const start = businessDayStartIso("2026-10-14", "Europe/Berlin");
    expect(start).not.toBeNull();
    expect(new Date(start ?? "").getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it("rejects malformed dates", () => {
    expect(businessDayStartIso("14.10.2026", "Europe/Berlin")).toBeNull();
    expect(businessDayStartIso("2026-13-01", "Europe/Berlin")).toBeNull();
    expect(businessDayStartIso("", "Europe/Berlin")).toBeNull();
  });
});
