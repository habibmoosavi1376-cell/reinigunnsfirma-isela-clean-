import { recordAudit } from "@isela/audit";
import { auditActorOf, authorize, requireActor, type ServiceContext } from "@isela/auth";
import { and, eq, schema, sql, type DbExecutor } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";

/*
 * Local service pages ("/<service>-<city>") are data. A page is only publishable when the
 * service, the location, the availability and the content are all real:
 * - active service category with a URL slug and at least one active service,
 * - a city with a known centroid that lies inside the page's ACTIVE service area (PostGIS),
 * - content written and reviewed by a person.
 * Nothing is generated automatically; there are no doorway pages.
 */

export type LandingPageBlocker =
  | "CATEGORY_INACTIVE"
  | "CATEGORY_WITHOUT_SLUG"
  | "NO_ACTIVE_SERVICE"
  | "SERVICE_AREA_INACTIVE"
  | "CITY_WITHOUT_LOCATION"
  | "CITY_OUTSIDE_SERVICE_AREA"
  | "SLUG_MISMATCH"
  | "CONTENT_MISSING"
  | "CONTENT_NOT_REVIEWED";

export interface LandingPageAssessment {
  readonly landingPageId: string;
  readonly publishable: boolean;
  readonly blockers: readonly LandingPageBlocker[];
}

async function assess(db: DbExecutor, landingPageId: string): Promise<LandingPageAssessment> {
  const page = schema.landingPage;
  const category = schema.serviceCategory;
  const area = schema.serviceArea;
  const city = schema.city;
  const [row] = await db
    .select({
      slug: page.slug,
      hasContent: sql<boolean>`${page.content} IS NOT NULL`,
      reviewed: sql<boolean>`${page.contentReviewedAt} IS NOT NULL`,
      categoryActive: category.active,
      categorySlug: category.urlSlug,
      hasActiveService: sql<boolean>`EXISTS (
        SELECT 1 FROM ${schema.service}
        WHERE ${schema.service.categoryId} = ${category.id} AND ${schema.service.active} = true
      )`,
      areaActive: area.active,
      cityHasLocation: sql<boolean>`${city.centroid} IS NOT NULL`,
      cityInArea: sql<boolean>`COALESCE(
        (${area.kind} = 'CIRCLE' AND ST_DWithin(${area.center}, ${city.centroid}, ${area.radiusM})) OR
        (${area.kind} = 'POLYGON' AND ST_Covers(${area.boundary}, ${city.centroid})),
        false)`,
    })
    .from(page)
    .innerJoin(category, eq(category.id, page.serviceCategoryId))
    .innerJoin(area, eq(area.id, page.serviceAreaId))
    .innerJoin(city, eq(city.id, page.cityId))
    .where(eq(page.id, landingPageId))
    .limit(1);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Landing page not found");
  }
  const blockers: LandingPageBlocker[] = [];
  if (!row.categoryActive) blockers.push("CATEGORY_INACTIVE");
  if (row.categorySlug === null) blockers.push("CATEGORY_WITHOUT_SLUG");
  else if (!row.slug.startsWith(`${row.categorySlug}-`)) blockers.push("SLUG_MISMATCH");
  if (!row.hasActiveService) blockers.push("NO_ACTIVE_SERVICE");
  if (!row.areaActive) blockers.push("SERVICE_AREA_INACTIVE");
  if (!row.cityHasLocation) blockers.push("CITY_WITHOUT_LOCATION");
  else if (!row.cityInArea) blockers.push("CITY_OUTSIDE_SERVICE_AREA");
  if (!row.hasContent) blockers.push("CONTENT_MISSING");
  if (!row.reviewed) blockers.push("CONTENT_NOT_REVIEWED");
  return { landingPageId, publishable: blockers.length === 0, blockers };
}

const idInput = z.strictObject({ landingPageId: z.uuid() });

export async function assessLandingPage(
  ctx: ServiceContext,
  input: unknown,
): Promise<LandingPageAssessment> {
  authorize(ctx.actor, "catalog:read");
  const { landingPageId } = parseInput(idInput, input);
  return assess(ctx.db, landingPageId);
}

/** Publishes a page only if every publication condition holds (re-checked in the transaction). */
export async function publishLandingPage(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "catalog:manage");
  const { landingPageId } = parseInput(idInput, input);
  await ctx.db.transaction(async (tx) => {
    const assessment = await assess(tx, landingPageId);
    if (!assessment.publishable) {
      throw new DomainError("POLICY_VIOLATION", "Landing page is not publishable", {
        blockers: assessment.blockers,
      });
    }
    await tx
      .update(schema.landingPage)
      .set({ status: "PUBLISHED", publishedAt: ctx.clock.now(), updatedAt: ctx.clock.now() })
      .where(eq(schema.landingPage.id, landingPageId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "landing_page.published",
      entityType: "landing_page",
      entityId: landingPageId,
      after: { status: "PUBLISHED" },
      correlationId: ctx.correlationId,
    });
  });
}

/**
 * Public: slugs of published pages that are STILL publishable (e.g. a deactivated service
 * area removes its pages from the sitemap immediately).
 */
export async function listPublishedLandingPageSlugs(db: DbExecutor): Promise<string[]> {
  const rows = await db
    .select({ id: schema.landingPage.id, slug: schema.landingPage.slug })
    .from(schema.landingPage)
    .where(and(eq(schema.landingPage.status, "PUBLISHED")))
    .orderBy(schema.landingPage.slug);
  const slugs: string[] = [];
  for (const row of rows) {
    if ((await assess(db, row.id)).publishable) slugs.push(row.slug);
  }
  return slugs;
}
