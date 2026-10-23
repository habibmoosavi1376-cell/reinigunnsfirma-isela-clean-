import type {
  AddressQuery,
  GeocodeCandidate,
  GeocodePrecision,
  GeocodeResult,
  GeocodeUnavailableReason,
} from "./contract.ts";
import { comparisonKey, normalizeHouseNumber } from "./normalize.ts";

/**
 * Decides whether a provider match may be used for the service-area check. Only an
 * unambiguous, building-level match of the same postal code is accepted automatically;
 * everything else needs a human decision. Coordinates of uncertain matches are never used
 * silently.
 */
export interface GeocodeAcceptancePolicy {
  /** Minimum normalised confidence (0..1) for automatic acceptance. */
  readonly minConfidence: number;
  /** Precisions that may be accepted automatically. */
  readonly acceptedPrecisions: readonly GeocodePrecision[];
}

/** Technical quality thresholds (not a business rule); see docs/PHASE_1_DAY_3_REPORT.md. */
export const DEFAULT_ACCEPTANCE_POLICY: GeocodeAcceptancePolicy = {
  minConfidence: 0.8,
  acceptedPrecisions: ["BUILDING"],
};

export type GeocodeReviewReason =
  | "PRECISION_TOO_LOW"
  | "LOW_CONFIDENCE"
  | "POSTAL_CODE_MISMATCH"
  | "STREET_MISMATCH"
  | "HOUSE_NUMBER_MISMATCH";

export type GeocodeAssessment =
  | { readonly outcome: "ACCEPTED"; readonly candidate: GeocodeCandidate }
  | {
      readonly outcome: "NEEDS_REVIEW";
      readonly candidate: GeocodeCandidate;
      readonly reasons: readonly GeocodeReviewReason[];
    }
  | {
      readonly outcome: "NO_MATCH";
      readonly reasons: readonly ("COUNTRY_MISMATCH" | "NO_RESULT")[];
    }
  | { readonly outcome: "UNAVAILABLE"; readonly reason: GeocodeUnavailableReason };

export function assessGeocodeResult(
  query: AddressQuery,
  result: GeocodeResult,
  policy: GeocodeAcceptancePolicy = DEFAULT_ACCEPTANCE_POLICY,
): GeocodeAssessment {
  if (result.status === "UNAVAILABLE") {
    return { outcome: "UNAVAILABLE", reason: result.reason };
  }
  if (result.status === "NO_MATCH") {
    return { outcome: "NO_MATCH", reasons: ["NO_RESULT"] };
  }
  const candidate = result.candidate;
  // A match in another country is never usable – not even for review.
  if (candidate.country.toUpperCase() !== query.country.toUpperCase()) {
    return { outcome: "NO_MATCH", reasons: ["COUNTRY_MISMATCH"] };
  }

  const reasons: GeocodeReviewReason[] = [];
  if (!policy.acceptedPrecisions.includes(candidate.precision)) {
    reasons.push("PRECISION_TOO_LOW");
  }
  if (!(candidate.confidence >= policy.minConfidence)) {
    reasons.push("LOW_CONFIDENCE");
  }
  if (
    candidate.postalCode === null ||
    comparisonKey(candidate.postalCode) !== comparisonKey(query.postalCode)
  ) {
    reasons.push("POSTAL_CODE_MISMATCH");
  }
  if (
    candidate.street === null ||
    comparisonKey(candidate.street) !== comparisonKey(query.street)
  ) {
    reasons.push("STREET_MISMATCH");
  }
  if (
    candidate.precision === "BUILDING" &&
    (candidate.houseNumber === null ||
      comparisonKey(normalizeHouseNumber(candidate.houseNumber)) !==
        comparisonKey(query.houseNumber))
  ) {
    reasons.push("HOUSE_NUMBER_MISMATCH");
  }

  return reasons.length === 0
    ? { outcome: "ACCEPTED", candidate }
    : { outcome: "NEEDS_REVIEW", candidate, reasons };
}
