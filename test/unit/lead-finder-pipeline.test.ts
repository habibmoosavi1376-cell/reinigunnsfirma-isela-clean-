import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAD_SCORING,
  NO_PROHIBITED_TECHNIQUES,
  checkCompliance,
  deduplicate,
  deduplicationKey,
  normalizeOpportunity,
  scoreOpportunity,
  toReviewItem,
  type LeadProviderContract,
  type RawOpportunity,
} from "@isela/lead-finder";

const now = new Date("2026-09-27T12:00:00Z");

const contract: LeadProviderContract<"BUSINESS_SEARCH"> = {
  providerId: "test-business-search",
  providerKind: "BUSINESS_SEARCH",
  legalBasis: "GDPR_ART6_1F_LEGITIMATE_INTEREST",
  termsReviewedAt: new Date("2026-09-01T00:00:00Z"),
  allowedUse: "B2B-Recherche nach öffentlich zugänglichen Firmendaten (Testdaten)",
  retentionDays: 90,
  rateLimitPerMinute: 30,
  enabled: true,
  sourceMetadata: {},
  source: "Test-Provider (nur Tests)",
  termsStatus: "REVIEWED_ALLOWED",
  prohibited: NO_PROHIBITED_TECHNIQUES,
};

const raw: RawOpportunity = {
  providerId: "test-business-search",
  providerKind: "BUSINESS_SEARCH",
  externalReference: "ext-1",
  collectedAt: new Date("2026-09-20T00:00:00Z"),
  companyName: "  Muster   Büro GmbH ",
  website: "https://www.Muster-Buero.example/kontakt",
  postalCode: "123 45",
  city: "Musterstadt",
  signals: ["New-Office", "new-office", " "],
};

describe("LeadFinder compliance gate", () => {
  it("allows a reviewed, enabled provider within retention", () => {
    expect(checkCompliance(contract, raw, now)).toEqual({ allowed: true, violations: [] });
  });

  it.each([
    ["disabled provider", { enabled: false }, "PROVIDER_DISABLED"],
    ["missing allowed use", { allowedUse: " " }, "NO_ALLOWED_USE"],
    ["terms not reviewed", { termsStatus: "NOT_REVIEWED" as const }, "TERMS_NOT_REVIEWED"],
    ["terms prohibit use", { termsStatus: "PROHIBITED" as const }, "TERMS_PROHIBIT_USE"],
    ["retention expired", { retentionDays: 1 }, "RETENTION_EXPIRED"],
    ["invalid retention", { retentionDays: 5000 }, "INVALID_RETENTION"],
    ["invalid rate limit", { rateLimitPerMinute: 0 }, "INVALID_RATE_LIMIT"],
  ])("blocks %s", (_label, overrides, violation) => {
    const result = checkCompliance({ ...contract, ...overrides }, raw, now);
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain(violation);
  });

  it("blocks forged prohibited techniques (CAPTCHA/login/ToS bypass, outreach, scraping)", () => {
    for (const technique of Object.keys(NO_PROHIBITED_TECHNIQUES)) {
      const forged = {
        ...contract,
        prohibited: { ...NO_PROHIBITED_TECHNIQUES, [technique]: true },
      } as unknown as LeadProviderContract;
      expect(checkCompliance(forged, raw, now).violations, technique).toContain(
        "PROHIBITED_TECHNIQUE",
      );
    }
  });

  it("rejects opportunities attributed to another provider", () => {
    expect(
      checkCompliance(contract, { ...raw, providerKind: "REFERRAL" }, now).violations,
    ).toContain("KIND_MISMATCH");
  });
});

describe("LeadFinder normalisation, deduplication, scoring, review", () => {
  it("normalises without enrichment", () => {
    expect(normalizeOpportunity(raw)).toMatchObject({
      companyName: "Muster Büro GmbH",
      websiteHost: "muster-buero.example",
      postalCode: "12345",
      signals: ["new-office"],
    });
    expect(normalizeOpportunity({ ...raw, website: "javascript:alert(1)" }).websiteHost).toBeNull();
  });

  it("deduplicates by website host, else by name and postal code", () => {
    const a = normalizeOpportunity(raw);
    const b = normalizeOpportunity({
      ...raw,
      externalReference: "ext-2",
      website: "http://muster-buero.example",
    });
    const c = normalizeOpportunity({
      ...raw,
      externalReference: "ext-3",
      website: undefined as unknown as string,
    });
    const d = normalizeOpportunity({
      ...raw,
      externalReference: "ext-4",
      website: undefined as unknown as string,
      companyName: "Muster Büro",
    });
    expect(deduplicationKey(a)).toBe(deduplicationKey(b));
    expect(deduplicationKey(c)).toBe(deduplicationKey(d));
    const result = deduplicate([a, b, c, d], new Set());
    expect(result.unique).toHaveLength(2);
    expect(result.duplicates).toHaveLength(2);
    expect(deduplicate([a], new Set([deduplicationKey(a)])).unique).toHaveLength(0);
  });

  it("scores explainably from the configured weights and clamps factors", () => {
    const scored = scoreOpportunity(
      {
        areaFit: 1,
        segmentFit: 1,
        demandSignal: 0.5,
        volumePotential: 0,
        recurrencePotential: 2,
        dataQuality: Number.NaN,
      },
      DEFAULT_LEAD_SCORING,
    );
    expect(scored.breakdown).toMatchObject({
      areaFit: 25,
      segmentFit: 15,
      demandSignal: 12.5,
      recurrencePotential: 10,
      dataQuality: 0,
    });
    expect(scored.score).toBe(63);
  });

  it("always ends in human review", () => {
    const item = toReviewItem(normalizeOpportunity(raw), { score: 10, breakdown: {} });
    expect(item.status).toBe("PENDING_HUMAN_REVIEW");
  });
});
