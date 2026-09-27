import { describe, expect, it } from "vitest";
import type { Actor, Role } from "@isela/auth";
import type { LeadDetail } from "@isela/crm";
import { leadQueryFromSearchParams, leadQueryString } from "@/lib/admin/lead-filters";
import { errorText, noticeText } from "@/lib/admin/lead-actions";
import { visibleModules } from "@/lib/admin/navigation";
import { nextActions } from "@/lib/admin/next-action";

function actor(role: Role): Actor {
  return {
    userId: `u-${role}`,
    mfaEnabled: true,
    roles: [{ role, customerId: null, partnerId: null, isScopeAdmin: false }],
  };
}

describe("lead filters from URL parameters", () => {
  it("maps valid parameters to a validated query", () => {
    const { query, invalid } = leadQueryFromSearchParams({
      status: ["DISCOVERED", "LOST"],
      customerType: "BUSINESS",
      q: "  Muster ",
      page: "2",
      pageSize: "50",
      ignored: "x",
    });
    expect(invalid).toBe(false);
    expect(query).toMatchObject({
      status: ["DISCOVERED", "LOST"],
      customerType: "BUSINESS",
      q: "Muster",
      page: 2,
      pageSize: 50,
    });
    expect(query).not.toHaveProperty("ignored");
  });

  it.each([
    [{ pageSize: "1000" }],
    [{ page: "-1" }],
    [{ page: "1e9" }],
    [{ page: "abc" }],
    [{ status: "DROP TABLE" }],
    [{ serviceAreaId: "../../etc" }],
  ])("falls back to the first page for abusive input %j", (params) => {
    expect(leadQueryFromSearchParams(params)).toEqual({
      query: { page: 1, pageSize: 25 },
      invalid: true,
    });
  });

  it("builds pagination links from validated values only", () => {
    const { query } = leadQueryFromSearchParams({ q: "a&b=c", status: "LOST" });
    const params = new URLSearchParams(leadQueryString(query, 3));
    expect(params.get("q")).toBe("a&b=c");
    expect(params.getAll("status")).toEqual(["LOST"]);
    expect(params.get("page")).toBe("3");
  });
});

describe("admin navigation", () => {
  const labels = (role: Role) => visibleModules(actor(role)).map((m) => m.key);

  it("activates only implemented modules", () => {
    const modules = visibleModules(actor("SUPER_ADMIN"));
    expect(modules.filter((m) => m.active).map((m) => m.key)).toEqual([
      "dashboard",
      "leads",
      "customers",
      "properties",
      "quotes",
    ]);
    expect(modules.find((m) => m.key === "invoices")?.active).toBe(false);
    expect(modules.find((m) => m.key === "jobs")?.active).toBe(false);
  });

  it("shows customers, properties and quotes according to the permission matrix", () => {
    expect(labels("DISPATCHER")).toEqual(
      expect.arrayContaining(["customers", "properties", "quotes"]),
    );
    expect(labels("FINANCE")).toEqual(expect.arrayContaining(["customers", "quotes"]));
    expect(labels("FINANCE")).not.toContain("properties");
    for (const role of ["STAFF", "PARTNER"] as const) {
      expect(labels(role)).not.toContain("customers");
      expect(labels(role)).not.toContain("quotes");
    }
  });

  it("shows leads only to roles with lead:read", () => {
    expect(labels("DISPATCHER")).toContain("leads");
    expect(labels("ADMIN")).toContain("leads");
    expect(labels("FINANCE")).not.toContain("leads");
    expect(labels("STAFF")).not.toContain("leads");
    expect(labels("PARTNER")).not.toContain("leads");
  });
});

describe("action result codes", () => {
  it("only renders whitelisted codes", () => {
    expect(noticeText("status_changed")).toMatch(/Status/);
    expect(noticeText("<script>alert(1)</script>")).toBeNull();
    expect(errorText("FORBIDDEN")).toMatch(/Berechtigung/);
    expect(errorText("constructor")).toBeNull();
    expect(errorText(["FORBIDDEN"])).toBeNull();
  });
});

describe("next action suggestions", () => {
  const detail = (overrides: Partial<NonNullable<LeadDetail["request"]>>, status = "DISCOVERED") =>
    ({
      lead: { status },
      request: {
        geocodingStatus: "SUCCEEDED",
        serviceAreaStatus: "AVAILABLE",
        customerId: null,
        ...overrides,
      },
    }) as unknown as LeadDetail;

  it("asks for human review of uncertain geocoding", () => {
    expect(nextActions(detail({ geocodingStatus: "NEEDS_REVIEW" }), true)[0]).toMatch(/prüfen/);
  });

  it("is honest when no geocoding provider is configured", () => {
    expect(
      nextActions(detail({ geocodingStatus: "PENDING", serviceAreaStatus: "UNKNOWN" }), false)[0],
    ).toMatch(/kein Geocoding-Anbieter/);
  });

  it("never suggests automatic pricing", () => {
    expect(nextActions(detail({}, "QUOTE_REQUEST"), true).join(" ")).toMatch(
      /keine automatische Preiszusage/,
    );
  });
});
