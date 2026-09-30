import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import { city, leadSource, serviceArea, serviceCategory } from "../schema/index.ts";
import {
  SEED_LEAD_SOURCES,
  SEED_SERVICE_CATEGORIES,
  SEED_START_CITY,
  SEED_START_SERVICE_AREA,
} from "./reference-data.ts";

/**
 * Idempotent seed of reference data. Existing rows are left untouched so that changes
 * made by administrators (e.g. activating a service area) are never overwritten.
 */
export async function seedReferenceData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(serviceCategory)
      .values(SEED_SERVICE_CATEGORIES.map((c) => ({ ...c })))
      .onConflictDoUpdate({
        target: serviceCategory.key,
        // Only fills a missing slug (added in migration 0003); never overwrites admin changes.
        set: { urlSlug: sql`COALESCE(${serviceCategory.urlSlug}, excluded.url_slug)` },
      });

    await tx
      .insert(city)
      .values({ ...SEED_START_CITY })
      .onConflictDoNothing({
        target: city.officialKey,
      });

    const area = SEED_START_SERVICE_AREA;
    await tx
      .insert(serviceArea)
      .values({
        key: area.key,
        name: area.name,
        kind: "CIRCLE",
        center: sql`ST_SetSRID(ST_MakePoint(${area.longitude}, ${area.latitude}), 4326)::geography`,
        radiusM: area.radiusM,
        priority: area.priority,
        active: false,
      })
      .onConflictDoNothing({ target: serviceArea.key });

    await tx
      .insert(leadSource)
      .values(SEED_LEAD_SOURCES.map((s) => ({ ...s, enabled: true })))
      .onConflictDoNothing({ target: leadSource.key });
  });
}
