import { describe, expect, it } from "vitest";
import { crmErrorText, crmNoticeText } from "@/lib/admin/crm-actions";
import { formatMoney, parseDecimal, parseMoneyToCents } from "@/lib/admin/format";
import { listQueryString, parseListParams } from "@/lib/admin/list-params";
import { customerListQuerySchema } from "@isela/crm";

describe("money and decimal input", () => {
  it.each([
    ["32,90", 3290],
    ["1.234,56", 123456],
    ["12", 1200],
    ["0,5", 50],
    ["19,99 €", 1999],
  ])("parses %s as %i cents", (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents);
  });

  it.each(["", "-1", "1,234", "abc", "1e5", "12,3,4", "9999999999"])("rejects %s", (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });

  it("parses quantities with at most three decimals", () => {
    expect(parseDecimal("2,5")).toBe(2.5);
    expect(parseDecimal("0,125")).toBe(0.125);
    expect(parseDecimal("1,2345")).toBeNull();
    expect(parseDecimal("-3")).toBeNull();
  });

  it("formats cents as euros", () => {
    expect(formatMoney(123456)).toMatch(/1\.234,56\s€/);
  });
});

describe("customer list params", () => {
  it("validates filters through the domain schema and rebuilds pagination links", () => {
    const { query, raw } = parseListParams(
      { q: "Muster", kind: "BUSINESS", page: "2", ignored: "x" },
      ["q", "kind", "status"],
      customerListQuerySchema,
    );
    expect(query).toMatchObject({ q: "Muster", kind: "BUSINESS", page: 2 });
    expect(listQueryString(raw, 3)).toBe("q=Muster&kind=BUSINESS&page=3");
  });

  it("rejects invalid filters instead of passing them on", () => {
    expect(parseListParams({ kind: "ADMIN" }, ["kind"], customerListQuerySchema).query).toBeNull();
    expect(parseListParams({ pageSize: "500" }, ["q"], customerListQuerySchema).query).toBeNull();
  });
});

describe("CRM action result codes", () => {
  it("only renders whitelisted codes", () => {
    expect(crmNoticeText("property_created")).toMatch(/Objekt/);
    expect(crmNoticeText("__proto__")).toBeNull();
    expect(crmErrorText("NOT_FOUND")).toMatch(/nicht gefunden/);
    expect(crmErrorText("<img src=x>")).toBeNull();
  });
});
