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
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, geographyMultiPolygon, geographyPoint, updatedAt } from "./columns.ts";
import { propertyType } from "./enums.ts";

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

/** How the expected working time of a service is estimated (day 5). */
export const serviceDurationModel = pgEnum("service_duration_model", [
  "MANUAL",
  "FIXED",
  "PER_UNIT",
]);

/**
 * How a service is priced: RULE_BASED = versioned price rule set (@isela/pricing),
 * MANUAL_QUOTE = authorised staff enter the price. Never an automatic price commitment.
 */
export const servicePricingStrategy = pgEnum("service_pricing_strategy", [
  "MANUAL_QUOTE",
  "RULE_BASED",
]);

/**
 * Catalogue service. `key` is the stable slug. Day 5 adds the configurable service data model
 * (minimum quantity, duration model, pricing strategy, qualifications, property types) – no
 * prices: prices live in versioned price rule sets, never in the catalogue or the UI.
 */
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
    sortOrder: integer("sort_order").notNull().default(100),
    /** Smallest bookable quantity in `unit`; NULL = no minimum. */
    minQuantity: numeric("min_quantity", { precision: 12, scale: 3, mode: "number" }),
    durationModel: serviceDurationModel("duration_model").notNull().default("MANUAL"),
    /** FIXED: total minutes; PER_UNIT: set-up minutes added to the per-unit time. */
    baseDurationMinutes: integer("base_duration_minutes"),
    /** PER_UNIT: seconds per unit (integer, no floating point). */
    durationPerUnitSeconds: integer("duration_per_unit_seconds"),
    pricingStrategy: servicePricingStrategy("pricing_strategy").notNull().default("MANUAL_QUOTE"),
    /** Qualification keys an employee needs for this service (data, e.g. "window-height"). */
    requiredQualifications: text("required_qualifications")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Property types the service is offered for; empty = not restricted. */
    supportedPropertyTypes: propertyType("supported_property_types")
      .array()
      .notNull()
      .default(sql`'{}'::property_type[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("service_category_idx").on(t.categoryId),
    check("service_key_chk", sql`${t.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("service_min_quantity_chk", sql`${t.minQuantity} IS NULL OR ${t.minQuantity} > 0`),
    check(
      "service_duration_chk",
      sql`(${t.baseDurationMinutes} IS NULL OR ${t.baseDurationMinutes} BETWEEN 0 AND 10080) AND
        (${t.durationPerUnitSeconds} IS NULL OR ${t.durationPerUnitSeconds} BETWEEN 1 AND 86400) AND
        (${t.durationModel} <> 'FIXED' OR ${t.baseDurationMinutes} IS NOT NULL) AND
        (${t.durationModel} <> 'PER_UNIT' OR ${t.durationPerUnitSeconds} IS NOT NULL)`,
    ),
    check(
      "service_lists_chk",
      sql`cardinality(${t.requiredQualifications}) <= 20 AND cardinality(${t.supportedPropertyTypes}) <= 20`,
    ),
  ],
);

/** Optional extra of a service (e.g. inside of the fridge). Prices come from price rules. */
export const serviceOption = pgTable(
  "service_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("service_option_service_key_uq").on(t.serviceId, t.key),
    check("service_option_key_chk", sql`${t.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
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
