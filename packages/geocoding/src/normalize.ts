import type { AddressQuery } from "./contract.ts";

/*
 * Address normalisation for geocoding queries and for comparing a provider match with the
 * user's input. Pure functions; no location is special-cased.
 */

function collapse(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Expands the common German street abbreviation ("Musterstr." → "Musterstraße"). */
export function normalizeStreet(street: string): string {
  return collapse(street)
    .replace(/(str)\.(?=\s|$)/gi, "$1aße")
    .replace(/(^|\s)(Str)\.?(?=\s|$)/g, "$1Straße");
}

/** "12 a" → "12a", "12-14" stays, letters lower case. */
export function normalizeHouseNumber(houseNumber: string): string {
  return collapse(houseNumber)
    .replace(/(\d)\s+([a-z])$/i, "$1$2")
    .toLowerCase();
}

export function normalizePostalCodeValue(postalCode: string, country: string): string {
  const compact = collapse(postalCode).toUpperCase();
  return country.toUpperCase() === "DE" ? compact.replace(/\s/g, "") : compact;
}

export function normalizeAddressQuery(input: AddressQuery): AddressQuery {
  const country = collapse(input.country).toUpperCase();
  return {
    street: normalizeStreet(input.street),
    houseNumber: normalizeHouseNumber(input.houseNumber),
    postalCode: normalizePostalCodeValue(input.postalCode, country),
    city: collapse(input.city),
    country,
  };
}

/**
 * Comparison key: case-insensitive, umlauts folded, "straße/strasse/str" unified, punctuation
 * and spaces removed. "Musterstr. " and "Musterstraße" produce the same key.
 */
export function comparisonKey(value: string): string {
  return collapse(value)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/strasse|str\./g, "str")
    .replace(/[^a-z0-9]/g, "");
}
