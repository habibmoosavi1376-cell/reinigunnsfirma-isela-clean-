import { describe, expect, it } from "vitest";
import {
  assertProviderUsable,
  assertSafePublicUrl,
  isPublicIpAddress,
  type LeadProviderDescriptor,
} from "@isela/lead-finder";
import { expectDomainError, expectDomainErrorSync } from "../support/assertions.ts";

const external: LeadProviderDescriptor = {
  providerId: "business-search-x",
  providerKind: "BUSINESS_SEARCH",
  legalBasis: "GDPR_ART6_1F_LEGITIMATE_INTEREST",
  termsReviewedAt: new Date("2026-09-01T00:00:00Z"),
  allowedUse: "documented allowed use",
  retentionDays: 180,
  rateLimitPerMinute: 10,
  enabled: true,
  sourceMetadata: {},
};

describe("lead provider gating", () => {
  it("accepts an enabled, reviewed provider", () => {
    expect(() => {
      assertProviderUsable(external);
    }).not.toThrow();
  });

  it("rejects disabled providers", () => {
    expectDomainErrorSync(() => {
      assertProviderUsable({ ...external, enabled: false });
    }, "POLICY_VIOLATION");
  });

  it("rejects external providers without terms review", () => {
    expectDomainErrorSync(() => {
      assertProviderUsable({ ...external, termsReviewedAt: null });
    }, "POLICY_VIOLATION");
  });

  it("rejects providers without documented allowed use", () => {
    expectDomainErrorSync(() => {
      assertProviderUsable({ ...external, allowedUse: " " });
    }, "POLICY_VIOLATION");
  });

  it("does not require a terms review for internal inbound sources", () => {
    expect(() => {
      assertProviderUsable({
        ...external,
        providerKind: "INTERNAL_INBOUND",
        termsReviewedAt: null,
      });
    }).not.toThrow();
  });
});

describe("SSRF protection", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("treats %s as non-public", (ip) => {
    expect(isPublicIpAddress(ip)).toBe(false);
  });

  it.each(["93.184.215.14", "8.8.8.8", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"])(
    "treats %s as public",
    (ip) => {
      expect(isPublicIpAddress(ip)).toBe(true);
    },
  );

  const resolver = (map: Record<string, string[]>) => (host: string) =>
    Promise.resolve(map[host] ?? []);

  it("accepts a public https URL and returns the verified addresses", async () => {
    const result = await assertSafePublicUrl(
      "https://company.example/about",
      resolver({ "company.example": ["93.184.215.14"] }),
    );
    expect(result.addresses).toEqual(["93.184.215.14"]);
  });

  it.each([
    ["file:///etc/passwd", {}],
    ["ftp://company.example/", {}],
    ["https://user:pass@company.example/", { "company.example": ["93.184.215.14"] }],
    ["https://company.example:8080/", { "company.example": ["93.184.215.14"] }],
    ["http://localhost/", {}],
    ["http://intranet.local/", {}],
    ["http://127.0.0.1/", {}],
    ["http://[::1]/", {}],
    ["http://169.254.169.254/latest/meta-data", {}],
    ["https://internal.example/", { "internal.example": ["10.0.0.5"] }],
    ["https://mixed.example/", { "mixed.example": ["93.184.215.14", "192.168.0.10"] }],
    ["https://unresolvable.example/", {}],
    ["not a url", {}],
  ])("rejects %s", async (url, map) => {
    await expectDomainError(assertSafePublicUrl(url, resolver(map)), "POLICY_VIOLATION");
  });
});
