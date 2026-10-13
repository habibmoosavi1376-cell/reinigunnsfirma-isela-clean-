import { describe, expect, it } from "vitest";
import { hashIdentity, normalizeAddress } from "@isela/crm";
import { redactSensitive } from "@isela/shared";
import {
  isValidPostalCode,
  normalizeEmail,
  normalizePhone,
  parseInput,
  z,
} from "@isela/validation";
import { expectDomainErrorSync } from "../support/assertions.ts";
import { TEST_CRM_CONFIG } from "../support/fixtures.ts";

describe("normalisation", () => {
  it.each([
    ["0209 123456", "+49209123456"],
    ["+49 (209) 12 34 56", "+49209123456"],
    ["0049-209-123456", "+49209123456"],
  ])("normalises phone %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(["12345", "abc", "+0123", ""])("rejects phone %s", (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });

  it("normalises e-mail addresses", () => {
    expect(normalizeEmail("  Max.Muster@Example.DE ")).toBe("max.muster@example.de");
  });

  it("validates postal codes per country", () => {
    expect(isValidPostalCode("45879", "DE")).toBe(true);
    expect(isValidPostalCode("4587", "DE")).toBe(false);
    expect(isValidPostalCode("1010", "AT")).toBe(true);
  });

  it("produces identical address hashes for formatting variants", () => {
    const a = normalizeAddress({
      street: "Musterstraße",
      houseNumber: "12 a",
      postalCode: "45879",
      country: "de",
    });
    const b = normalizeAddress({
      street: "Muster-Str.",
      houseNumber: "12a",
      postalCode: "45879",
      country: "DE",
    });
    expect(hashIdentity(TEST_CRM_CONFIG, "ADDRESS", a)).toBe(
      hashIdentity(TEST_CRM_CONFIG, "ADDRESS", b),
    );
  });

  it("rejects a pepper that is too short", () => {
    expectDomainErrorSync(
      () => hashIdentity({ identityPepper: "short" }, "EMAIL", "x"),
      "CONFIGURATION_ERROR",
    );
  });
});

describe("parseInput", () => {
  it("reports failing paths without echoing submitted values", () => {
    let details: unknown;
    try {
      parseInput(z.strictObject({ email: z.email() }), { email: "secret-value", extra: 1 });
    } catch (error) {
      details = (error as { details?: unknown }).details;
    }
    expect(JSON.stringify(details)).not.toContain("secret-value");
    expect(JSON.stringify(details)).toContain("email");
  });
});

describe("redaction", () => {
  it("redacts secrets and payment data recursively", () => {
    const redacted = redactSensitive({
      password: "p",
      nested: { accessToken: "t", iban: "DE00", name: "ok" },
      list: [{ apiKey: "k" }],
    });
    expect(redacted).toEqual({
      password: "[REDACTED]",
      nested: { accessToken: "[REDACTED]", iban: "[REDACTED]", name: "ok" },
      list: [{ apiKey: "[REDACTED]" }],
    });
  });
});
