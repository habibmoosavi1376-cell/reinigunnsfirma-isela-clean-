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

export interface PublicService {
  readonly name: string;
  readonly description: string | null;
}

export interface PublicServicePage {
  readonly key: string;
  readonly urlSlug: string;
  readonly name: string;
  readonly description: string | null;
  /** Active services of the category (names/descriptions only – no prices, no internals). */
  readonly services: readonly PublicService[];
  /**
   * Day 7 quality gate: a service page is only indexable (sitemap, robots "index") when an
   * administrator wrote a description for the category. Pages without real content stay
   * reachable for visitors but are "noindex" – no thin or generated pages in search engines.
   */
  readonly indexable: boolean;
}

/** Minimum length of a category description before its page counts as real content. */
export const MIN_INDEXABLE_DESCRIPTION_LENGTH = 120;

function toServicePage(
  category: { key: string; urlSlug: string; name: string; description: string | null },
  services: readonly PublicService[],
): PublicServicePage {
  const description = category.description?.trim() ?? "";
  return {
    key: category.key,
    urlSlug: category.urlSlug,
    name: category.name,
    description: category.description,
    services,
    indexable: description.length >= MIN_INDEXABLE_DESCRIPTION_LENGTH,
  };
}

/** Active categories with a URL slug, i.e. those that can have a public service page. */
export async function listPublicServicePages(db: DbExecutor): Promise<PublicServicePage[]> {
  const c = schema.serviceCategory;
  const rows = await db
    .select({ key: c.key, urlSlug: c.urlSlug, name: c.name, description: c.description })
    .from(c)
    .where(and(eq(c.active, true), isNotNull(c.urlSlug)))
    .orderBy(asc(c.sortOrder), asc(c.key));
  return rows.map((row) => toServicePage({ ...row, urlSlug: row.urlSlug ?? "" }, []));
}

/** One public service page by URL slug; null if the category is unknown, inactive or slugless. */
export async function getPublicServicePage(
  db: DbExecutor,
  urlSlug: string,
): Promise<PublicServicePage | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(urlSlug) || urlSlug.length > 80) return null;
  const c = schema.serviceCategory;
  const [category] = await db
    .select({ id: c.id, key: c.key, urlSlug: c.urlSlug, name: c.name, description: c.description })
    .from(c)
    .where(and(eq(c.active, true), eq(c.urlSlug, urlSlug)))
    .limit(1);
  if (category === undefined || category.urlSlug === null) return null;
  const s = schema.service;
  const services = await db
    .select({ name: s.name, description: s.description })
    .from(s)
    .where(and(eq(s.categoryId, category.id), eq(s.active, true)))
    .orderBy(asc(s.sortOrder), asc(s.key));
  return toServicePage(
    {
      key: category.key,
      urlSlug: category.urlSlug,
      name: category.name,
      description: category.description,
    },
    services,
  );
}
