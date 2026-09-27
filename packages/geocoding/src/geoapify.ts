import { latitudeSchema, longitudeSchema, z } from "@isela/validation";
import type {
  AddressQuery,
  GeoPointInput,
  GeocodeCandidate,
  GeocodePrecision,
  GeocodeResult,
  GeocodeUnavailableReason,
  GeocodingProvider,
} from "./contract.ts";

/*
 * Geoapify adapter (Geoapify GmbH, Germany; EU data centres; results may be stored).
 * Decision and evaluation: docs/PHASE_1_DAY_3_REPORT.md §2.
 *
 * Security:
 * - The endpoint is a code constant (never configurable, never derived from input) – user
 *   input only ever ends up as encoded query parameters, so it cannot redirect the request.
 * - Redirects are refused, requests time out, oversized or non-JSON bodies are rejected.
 * - The response is validated strictly; out-of-range coordinates, wrong types or foreign
 *   countries never become coordinates.
 * - Neither the URL (contains the API key) nor address data are logged.
 */

export const GEOAPIFY_ORIGIN = "https://api.geoapify.com";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TEXT = 200;

const text = z.string().max(MAX_TEXT).optional();
const unit = z.number().min(0).max(1).optional();

const geoapifyResultSchema = z.object({
  lat: latitudeSchema,
  lon: longitudeSchema,
  housenumber: text,
  street: text,
  postcode: text,
  city: text,
  state: text,
  country_code: z.string().regex(/^[a-zA-Z]{2}$/),
  result_type: z.string().max(40).optional(),
  rank: z
    .object({
      confidence: unit,
      confidence_street_level: unit,
      confidence_building_level: unit,
      match_type: z.string().max(40).optional(),
    })
    .optional(),
});

const geoapifyResponseSchema = z.object({
  results: z.array(geoapifyResultSchema).max(10),
});

export type GeoapifyResult = z.infer<typeof geoapifyResultSchema>;

function precisionOf(result: GeoapifyResult): GeocodePrecision {
  switch (result.result_type) {
    case "building":
    case "amenity":
      return result.housenumber === undefined ? "STREET" : "BUILDING";
    case "street":
      return "STREET";
    case "postcode":
      return "POSTCODE";
    case "city":
    case "suburb":
    case "district":
      return "CITY";
    default:
      return "OTHER";
  }
}

/** Maps a validated Geoapify result to the provider-independent candidate. */
export function toCandidate(result: GeoapifyResult): GeocodeCandidate {
  const precision = precisionOf(result);
  const rank = result.rank;
  const confidence =
    precision === "BUILDING"
      ? (rank?.confidence_building_level ?? rank?.confidence ?? 0)
      : precision === "STREET"
        ? (rank?.confidence_street_level ?? rank?.confidence ?? 0)
        : (rank?.confidence ?? 0);
  return {
    street: result.street ?? null,
    houseNumber: result.housenumber ?? null,
    postalCode: result.postcode ?? null,
    city: result.city ?? null,
    region: result.state ?? null,
    country: result.country_code.toUpperCase(),
    latitude: result.lat,
    longitude: result.lon,
    precision,
    confidence,
  };
}

export interface GeoapifyOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** Injected in tests only; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

export function createGeoapifyProvider(options: GeoapifyOptions): GeocodingProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const id = "geoapify";

  async function request(path: string, params: URLSearchParams): Promise<GeocodeResult> {
    params.set("format", "json");
    params.set("limit", "1");
    params.set("lang", "de");
    params.set("apiKey", options.apiKey);
    const url = new URL(path, GEOAPIFY_ORIGIN);
    url.search = params.toString();

    let response: Response;
    try {
      response = await doFetch(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      return unavailable(timedOut ? "TIMEOUT" : "PROVIDER_ERROR");
    }

    if (response.status === 401 || response.status === 403) return unavailable("AUTH_FAILED");
    if (response.status === 429) return unavailable("RATE_LIMITED");
    if (!response.ok) return unavailable("PROVIDER_ERROR");

    const contentType = response.headers.get("content-type") ?? "";
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (
      !contentType.toLowerCase().includes("application/json") ||
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      return unavailable("INVALID_RESPONSE");
    }
    let body: unknown;
    try {
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE_BYTES) return unavailable("INVALID_RESPONSE");
      body = JSON.parse(raw);
    } catch {
      return unavailable("INVALID_RESPONSE");
    }
    const parsed = geoapifyResponseSchema.safeParse(body);
    if (!parsed.success) return unavailable("INVALID_RESPONSE");
    const first = parsed.data.results[0];
    if (first === undefined) return { status: "NO_MATCH", provider: id };
    return { status: "MATCHED", provider: id, candidate: toCandidate(first) };
  }

  function unavailable(reason: GeocodeUnavailableReason): GeocodeResult {
    return { status: "UNAVAILABLE", provider: id, reason };
  }

  return {
    id,
    geocode(query: AddressQuery) {
      const params = new URLSearchParams({
        street: query.street,
        housenumber: query.houseNumber,
        postcode: query.postalCode,
        city: query.city,
        filter: `countrycode:${query.country.toLowerCase()}`,
      });
      return request("/v1/geocode/search", params);
    },
    reverse(point: GeoPointInput) {
      const params = new URLSearchParams({
        lat: String(point.latitude),
        lon: String(point.longitude),
      });
      return request("/v1/geocode/reverse", params);
    },
  };
}
