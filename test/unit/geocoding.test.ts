import { describe, expect, it } from "vitest";
import {
  GEOAPIFY_ORIGIN,
  assessGeocodeResult,
  comparisonKey,
  createGeoapifyProvider,
  normalizeAddressQuery,
  normalizeHouseNumber,
  normalizeStreet,
  type AddressQuery,
  type GeocodeCandidate,
  type GeocodeResult,
} from "@isela/geocoding";

const query: AddressQuery = {
  street: "Musterstraße",
  houseNumber: "12a",
  postalCode: "12345",
  city: "Musterstadt",
  country: "DE",
};

function candidate(overrides: Partial<GeocodeCandidate> = {}): GeocodeCandidate {
  return {
    street: "Musterstraße",
    houseNumber: "12a",
    postalCode: "12345",
    city: "Musterstadt",
    region: "Testland",
    country: "DE",
    latitude: 51.5,
    longitude: 7.1,
    precision: "BUILDING",
    confidence: 0.95,
    ...overrides,
  };
}

function matched(overrides: Partial<GeocodeCandidate> = {}): GeocodeResult {
  return { status: "MATCHED", provider: "test", candidate: candidate(overrides) };
}

describe("address normalisation", () => {
  it("expands street abbreviations and collapses whitespace", () => {
    expect(normalizeStreet("  Musterstr. ")).toBe("Musterstraße");
    expect(normalizeStreet("Str. des 17. Juni")).toBe("Straße des 17. Juni");
    expect(normalizeStreet("Am   Markt")).toBe("Am Markt");
  });

  it("normalises house numbers and postal codes", () => {
    expect(normalizeHouseNumber("12 A")).toBe("12a");
    expect(normalizeHouseNumber("12-14")).toBe("12-14");
    expect(
      normalizeAddressQuery({ ...query, postalCode: " 123 45 ", country: "de", city: " X  Y " }),
    ).toMatchObject({ postalCode: "12345", country: "DE", city: "X Y" });
  });

  it("compares spelling variants equally", () => {
    expect(comparisonKey("Musterstr.")).toBe(comparisonKey("Musterstraße"));
    expect(comparisonKey("Musterstrasse")).toBe(comparisonKey("MUSTERSTRASSE"));
    expect(comparisonKey("Müllerweg")).toBe(comparisonKey("Muellerweg"));
    expect(comparisonKey("Hauptstraße")).not.toBe(comparisonKey("Nebenstraße"));
  });
});

describe("geocode assessment (no silent fantasy coordinates)", () => {
  it("accepts only unambiguous building-level matches", () => {
    expect(assessGeocodeResult(query, matched()).outcome).toBe("ACCEPTED");
    expect(assessGeocodeResult(query, matched({ street: "Musterstr." })).outcome).toBe("ACCEPTED");
  });

  it.each([
    ["street-level precision", { precision: "STREET" as const }, "PRECISION_TOO_LOW"],
    ["postal-code centroid", { precision: "POSTCODE" as const }, "PRECISION_TOO_LOW"],
    ["low confidence", { confidence: 0.5 }, "LOW_CONFIDENCE"],
    ["NaN confidence", { confidence: Number.NaN }, "LOW_CONFIDENCE"],
    ["different postal code", { postalCode: "54321" }, "POSTAL_CODE_MISMATCH"],
    ["missing postal code", { postalCode: null }, "POSTAL_CODE_MISMATCH"],
    ["different street", { street: "Andere Straße" }, "STREET_MISMATCH"],
    ["different house number", { houseNumber: "14" }, "HOUSE_NUMBER_MISMATCH"],
  ])("requires human review for %s", (_label, overrides, reason) => {
    const assessment = assessGeocodeResult(query, matched(overrides));
    expect(assessment.outcome).toBe("NEEDS_REVIEW");
    expect(assessment.outcome === "NEEDS_REVIEW" ? assessment.reasons : []).toContain(reason);
  });

  it("never uses matches from another country, not even for review", () => {
    expect(assessGeocodeResult(query, matched({ country: "NL" }))).toEqual({
      outcome: "NO_MATCH",
      reasons: ["COUNTRY_MISMATCH"],
    });
  });

  it("passes through no-match and unavailable results without coordinates", () => {
    expect(assessGeocodeResult(query, { status: "NO_MATCH", provider: "t" }).outcome).toBe(
      "NO_MATCH",
    );
    expect(
      assessGeocodeResult(query, { status: "UNAVAILABLE", provider: "t", reason: "TIMEOUT" }),
    ).toEqual({ outcome: "UNAVAILABLE", reason: "TIMEOUT" });
  });
});

type FetchCall = { url: URL; init: RequestInit | undefined };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(input instanceof Request ? input.url : input), init });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const building = {
  lat: 51.5,
  lon: 7.1,
  housenumber: "12a",
  street: "Musterstraße",
  postcode: "12345",
  city: "Musterstadt",
  state: "Testland",
  country_code: "de",
  result_type: "building",
  rank: { confidence: 0.9, confidence_building_level: 0.97, match_type: "full_match" },
};

describe("Geoapify adapter", () => {
  it("calls only the fixed HTTPS endpoint with encoded parameters and no redirects (SSRF)", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ results: [building] }));
    const provider = createGeoapifyProvider({
      apiKey: "test-key-0123456789", // gitleaks:allow – dummy value for a fake fetch
      timeoutMs: 1000,
      fetch: fetchImpl,
    });
    const result = await provider.geocode({
      ...query,
      street: "http://169.254.169.254/latest/meta-data",
      city: "Musterstadt&apiKey=stolen#@evil.example",
    });
    expect(result.status).toBe("MATCHED");
    const call = calls[0];
    expect(call?.url.origin).toBe(GEOAPIFY_ORIGIN);
    expect(call?.url.pathname).toBe("/v1/geocode/search");
    expect(call?.url.searchParams.get("street")).toBe("http://169.254.169.254/latest/meta-data");
    expect(call?.url.searchParams.getAll("apiKey")).toEqual(["test-key-0123456789"]);
    expect(call?.url.searchParams.get("filter")).toBe("countrycode:de");
    expect(call?.init?.redirect).toBe("error");
    expect(call?.init?.method).toBe("GET");
  });

  it("maps a building match to a normalised candidate", async () => {
    const { fetchImpl } = fakeFetch(() => json({ results: [building] }));
    const result = await createGeoapifyProvider({
      apiKey: "k".repeat(20),
      timeoutMs: 1000,
      fetch: fetchImpl,
    }).geocode(query);
    expect(result).toEqual({
      status: "MATCHED",
      provider: "geoapify",
      candidate: {
        street: "Musterstraße",
        houseNumber: "12a",
        postalCode: "12345",
        city: "Musterstadt",
        region: "Testland",
        country: "DE",
        latitude: 51.5,
        longitude: 7.1,
        precision: "BUILDING",
        confidence: 0.97,
      },
    });
  });

  it("treats an empty result list as no match", async () => {
    const { fetchImpl } = fakeFetch(() => json({ results: [] }));
    const result = await createGeoapifyProvider({
      apiKey: "k".repeat(20),
      timeoutMs: 1000,
      fetch: fetchImpl,
    }).geocode(query);
    expect(result.status).toBe("NO_MATCH");
  });

  it.each([
    ["latitude out of range", () => json({ results: [{ ...building, lat: 999 }] })],
    ["coordinates as strings", () => json({ results: [{ ...building, lat: "51.5" }] })],
    ["confidence above 1", () => json({ results: [{ ...building, rank: { confidence: 7 } }] })],
    ["invalid country code", () => json({ results: [{ ...building, country_code: "<script>" }] })],
    ["oversized text field", () => json({ results: [{ ...building, street: "x".repeat(5000) }] })],
    ["too many results", () => json({ results: Array.from({ length: 11 }, () => building) })],
    ["missing results array", () => json({ features: [] })],
    [
      "HTML instead of JSON",
      () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    ],
    ["broken JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    [
      "declared oversized body",
      () => json({ results: [] }, 200, { "content-length": String(10 * 1024 * 1024) }),
    ],
  ])("rejects a manipulated response: %s", async (_label, respond) => {
    const { fetchImpl } = fakeFetch(respond);
    const result = await createGeoapifyProvider({
      apiKey: "k".repeat(20),
      timeoutMs: 1000,
      fetch: fetchImpl,
    }).geocode(query);
    expect(result).toEqual({
      status: "UNAVAILABLE",
      provider: "geoapify",
      reason: "INVALID_RESPONSE",
    });
  });

  it.each([
    [401, "AUTH_FAILED"],
    [403, "AUTH_FAILED"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER_ERROR"],
    [503, "PROVIDER_ERROR"],
  ])("maps HTTP %i to %s", async (status, reason) => {
    const { fetchImpl } = fakeFetch(() => json({ message: "x" }, status));
    const result = await createGeoapifyProvider({
      apiKey: "k".repeat(20),
      timeoutMs: 1000,
      fetch: fetchImpl,
    }).geocode(query);
    expect(result).toEqual({ status: "UNAVAILABLE", provider: "geoapify", reason });
  });

  it("never throws on network failures or timeouts", async () => {
    const timeout = (() =>
      Promise.reject(new DOMException("t", "TimeoutError"))) as unknown as typeof fetch;
    const network = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const redirect = (() =>
      Promise.reject(new TypeError("redirect mode is set to error"))) as unknown as typeof fetch;
    const make = (f: typeof fetch) =>
      createGeoapifyProvider({ apiKey: "k".repeat(20), timeoutMs: 1000, fetch: f });
    expect(await make(timeout).geocode(query)).toMatchObject({ reason: "TIMEOUT" });
    expect(await make(network).geocode(query)).toMatchObject({ reason: "PROVIDER_ERROR" });
    expect(await make(redirect).geocode(query)).toMatchObject({ reason: "PROVIDER_ERROR" });
  });

  it("supports reverse geocoding against the same fixed endpoint", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ results: [building] }));
    const provider = createGeoapifyProvider({
      apiKey: "k".repeat(20),
      timeoutMs: 1000,
      fetch: fetchImpl,
    });
    const result = await provider.reverse?.({ latitude: 51.5, longitude: 7.1 });
    expect(result?.status).toBe("MATCHED");
    expect(calls[0]?.url.origin).toBe(GEOAPIFY_ORIGIN);
    expect(calls[0]?.url.pathname).toBe("/v1/geocode/reverse");
  });
});
