import { customType, timestamp } from "drizzle-orm/pg-core";

/**
 * PostGIS geography columns (SRID 4326, distances in metres), backed by the domains
 * `geo_point` and `geo_multipolygon` (migration 0000) because drizzle-kit quotes type
 * names that contain parentheses.
 * Values are always written through SQL expressions (see `packages/catalog` geo services)
 * and read through explicit `ST_*` projections, so the TypeScript representation is an
 * opaque string.
 */
export const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geo_point";
  },
});

export const geographyMultiPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geo_multipolygon";
  },
});

export function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

export function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

export function archivedAt() {
  return timestamp("archived_at", { withTimezone: true, mode: "date" });
}
