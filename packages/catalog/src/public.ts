import { and, asc, eq, isNotNull, schema, type DbExecutor } from "@isela/database";

/*
 * Public, read-only catalogue data for the website. Explicitly public (no permission):
 * only active, non-sensitive master data is returned.
 */

export interface PublicServiceCategory {
  readonly key: string;
  readonly urlSlug: string | null;
  readonly name: string;
  readonly description: string | null;
}

export async function listPublicServiceCategories(
  db: DbExecutor,
): Promise<PublicServiceCategory[]> {
  const c = schema.serviceCategory;
  return db
    .select({ key: c.key, urlSlug: c.urlSlug, name: c.name, description: c.description })
    .from(c)
    .where(eq(c.active, true))
    .orderBy(asc(c.sortOrder), asc(c.key));
}

export interface PublicServiceArea {
  readonly key: string;
  readonly name: string;
}

/** Names of ACTIVE service areas only – availability of an address is decided by PostGIS. */
export async function listActiveServiceAreas(db: DbExecutor): Promise<PublicServiceArea[]> {
  const a = schema.serviceArea;
  return db
    .select({ key: a.key, name: a.name })
    .from(a)
    .where(and(eq(a.active, true), isNotNull(a.name)))
    .orderBy(asc(a.priority), asc(a.key));
}
