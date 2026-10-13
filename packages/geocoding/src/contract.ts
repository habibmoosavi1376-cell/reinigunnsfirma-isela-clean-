/**
 * Provider-independent geocoding contract. CRM and UI only ever see these types; a concrete
 * provider (e.g. Geoapify) is an adapter behind `GeocodingProvider` and can be replaced
 * without touching callers. There is intentionally no "fake" provider in production code:
 * without a configured provider, geocoding simply does not happen (status stays PENDING).
 */

/** Normalised address sent to a provider. Country is ISO 3166-1 alpha-2 (upper case). */
export interface AddressQuery {
  readonly street: string;
  readonly houseNumber: string;
  readonly postalCode: string;
  readonly city: string;
  readonly country: string;
}

/** How precisely the returned point identifies the address. */
export type GeocodePrecision = "BUILDING" | "STREET" | "POSTCODE" | "CITY" | "OTHER";

export const GEOCODE_PRECISIONS: readonly GeocodePrecision[] = [
  "BUILDING",
  "STREET",
  "POSTCODE",
  "CITY",
  "OTHER",
];

/** A single provider match, already validated and normalised by the adapter. */
export interface GeocodeCandidate {
  readonly street: string | null;
  readonly houseNumber: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly country: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly precision: GeocodePrecision;
  /** Provider confidence normalised to 0..1 (1 = certain). */
  readonly confidence: number;
}

export type GeocodeUnavailableReason =
  | "NOT_CONFIGURED"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE";

export type GeocodeResult =
  | { readonly status: "MATCHED"; readonly provider: string; readonly candidate: GeocodeCandidate }
  | { readonly status: "NO_MATCH"; readonly provider: string }
  | {
      readonly status: "UNAVAILABLE";
      readonly provider: string;
      readonly reason: GeocodeUnavailableReason;
    };

export interface GeoPointInput {
  readonly latitude: number;
  readonly longitude: number;
}

export interface GeocodingProvider {
  /** Stable identifier stored with every result (e.g. "geoapify"). */
  readonly id: string;
  /** Address → coordinates. Must never throw for provider/network problems. */
  geocode(query: AddressQuery): Promise<GeocodeResult>;
  /** Optional: coordinates → normalised address. */
  reverse?(point: GeoPointInput): Promise<GeocodeResult>;
}
