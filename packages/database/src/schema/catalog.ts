import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, geographyMultiPolygon, geographyPoint, updatedAt } from "./columns.ts";

/* Reference data: cities and postal codes are address data, never service-area logic. */

export const city = pgTable(
  "city",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    stateCode: text("state_code").notNull(),
    country: char("country", { length: 2 }).notNull().default("DE"),
    /** Official municipality key (e.g. German AGS), unique when present. */
    officialKey: text("official_key").unique(),
    centroid: geographyPoint("centroid"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("city_name_idx").on(t.name)],
);

export const postalCode = pgTable(
  "postal_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    country: char("country", { length: 2 }).notNull().default("DE"),
    createdAt: createdAt(),
  },
  (t) => [unique("postal_code_code_country_uq").on(t.code, t.country)],
);

/** n:m – a postal code can span several municipalities and vice versa. */
export const postalCodeCity = pgTable(
  "postal_code_city",
  {
    postalCodeId: uuid("postal_code_id")
      .notNull()
      .references(() => postalCode.id, { onDelete: "restrict" }),
    cityId: uuid("city_id")
      .notNull()
      .references(() => city.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.postalCodeId, t.cityId] }),
    index("postal_code_city_city_idx").on(t.cityId),
  ],
);

export const serviceAreaKind = pgEnum("service_area_kind", ["CIRCLE", "POLYGON"]);

export const serviceArea = pgTable(
  "service_area",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    kind: serviceAreaKind("kind").notNull(),
    center: geographyPoint("center"),
    radiusM: integer("radius_m"),
    boundary: geographyMultiPolygon("boundary"),
    active: boolean("active").notNull().default(false),
    priority: integer("priority").notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "service_area_shape_chk",
      sql`(
        (${t.kind} = 'CIRCLE' AND ${t.center} IS NOT NULL AND ${t.radiusM} IS NOT NULL AND ${t.boundary} IS NULL) OR
        (${t.kind} = 'POLYGON' AND ${t.boundary} IS NOT NULL AND ${t.center} IS NULL AND ${t.radiusM} IS NULL)
      )`,
    ),
    check(
      "service_area_radius_chk",
      sql`${t.radiusM} IS NULL OR (${t.radiusM} > 0 AND ${t.radiusM} <= 1000000)`,
    ),
    index("service_area_center_gix").using("gist", t.center),
    index("service_area_boundary_gix").using("gist", t.boundary),
  ],
);

export const serviceCategory = pgTable("service_category", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  /** German URL segment for public pages (e.g. "bueroreinigung"); data, not code. */
  urlSlug: text("url_slug").unique(),
  name: text("name").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const serviceUnit = pgEnum("service_unit", ["HOUR", "SQUARE_METER", "FLAT", "UNIT"]);

export const service = pgTable(
  "service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => serviceCategory.id, { onDelete: "restrict" }),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    unit: serviceUnit("unit").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("service_category_idx").on(t.categoryId)],
);

export const landingPageStatus = pgEnum("landing_page_status", ["DRAFT", "PUBLISHED"]);

/**
 * Local service page "/<service>-<city>" as data. Nothing is generated automatically: a page
 * can only be PUBLISHED with reviewed, real content (CHECK below); availability is verified
 * against active service areas in PostGIS before publishing (catalog: landing-pages.ts).
 */
export const landingPage = pgTable(
  "landing_page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceCategoryId: uuid("service_category_id")
      .notNull()
      .references(() => serviceCategory.id, { onDelete: "restrict" }),
    cityId: uuid("city_id")
      .notNull()
      .references(() => city.id, { onDelete: "restrict" }),
    serviceAreaId: uuid("service_area_id")
      .notNull()
      .references(() => serviceArea.id, { onDelete: "restrict" }),
    slug: text("slug").notNull().unique(),
    status: landingPageStatus("status").notNull().default("DRAFT"),
    /** Reviewed page content (headline, sections); NULL until written by a person. */
    content: jsonb("content").$type<Record<string, unknown>>(),
    contentReviewedAt: timestamp("content_reviewed_at", { withTimezone: true, mode: "date" }),
    contentReviewedByUserId: text("content_reviewed_by_user_id"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("landing_page_category_city_uq").on(t.serviceCategoryId, t.cityId),
    check(
      "landing_page_publish_chk",
      sql`${t.status} = 'DRAFT' OR (
        ${t.content} IS NOT NULL AND ${t.contentReviewedAt} IS NOT NULL AND
        ${t.contentReviewedByUserId} IS NOT NULL AND ${t.publishedAt} IS NOT NULL
      )`,
    ),
    check("landing_page_slug_chk", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);
