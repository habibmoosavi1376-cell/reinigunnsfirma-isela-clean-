import type { DbExecutor } from "@isela/database";
import { findServiceAreasForPoint, type GeoPoint, type MatchingServiceArea } from "./geo.ts";

export type ServiceAvailability = "AVAILABLE" | "NOT_AVAILABLE" | "UNKNOWN";

export interface ServiceAvailabilityResult {
  readonly status: ServiceAvailability;
  /** Highest-priority active area containing the point (AVAILABLE only). */
  readonly serviceArea: MatchingServiceArea | null;
  readonly matchingAreaCount: number;
}

/**
 * Service availability for a trusted point, using the generic PostGIS lookup (circles and
 * polygons, active areas only, ordered by priority). Without trusted coordinates the result
 * is UNKNOWN – never a guess from postal code or city name.
 */
export async function checkServiceAvailability(
  db: DbExecutor,
  point: GeoPoint | null,
): Promise<ServiceAvailabilityResult> {
  if (point === null) {
    return { status: "UNKNOWN", serviceArea: null, matchingAreaCount: 0 };
  }
  const areas = await findServiceAreasForPoint(db, point);
  const first = areas[0];
  return first === undefined
    ? { status: "NOT_AVAILABLE", serviceArea: null, matchingAreaCount: 0 }
    : { status: "AVAILABLE", serviceArea: first, matchingAreaCount: areas.length };
}
