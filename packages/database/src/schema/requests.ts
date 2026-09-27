import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, geographyPoint } from "./columns.ts";
import { serviceArea, serviceCategory } from "./catalog.ts";
import { customer, geocodingStatus, propertyType } from "./crm.ts";
import { lead } from "./leads.ts";

export const requestFrequency = pgEnum("request_frequency", [
  "ONCE",
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "CUSTOM",
]);

export const requestCustomerType = pgEnum("request_customer_type", [
  "PRIVATE",
  "BUSINESS",
  "PROPERTY_MANAGEMENT",
]);

/**
 * Result of the PostGIS service-area check. UNKNOWN whenever no trusted coordinates exist
 * (not geocoded, provider unavailable, uncertain match awaiting human review).
 */
export const serviceAreaStatus = pgEnum("service_area_status", [
  "UNKNOWN",
  "AVAILABLE",
  "NOT_AVAILABLE",
]);

/**
 * Details of a cleaning request submitted through the website ("Reinigung anfragen").
 * Always belongs to exactly one lead. No price, booking or assignment is derived here.
 */
export const serviceRequest = pgTable(
  "service_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customer.id, { onDelete: "restrict" }),
    submittedByUserId: text("submitted_by_user_id"),
    customerType: requestCustomerType("customer_type").notNull(),
    serviceCategoryId: uuid("service_category_id")
      .notNull()
      .references(() => serviceCategory.id, { onDelete: "restrict" }),
    propertyType: propertyType("property_type").notNull(),
    approximateAreaSqm: numeric("approximate_area_sqm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    frequency: requestFrequency("frequency").notNull(),
    /** Property management only: number of properties to be looked after (optional). */
    numberOfProperties: integer("number_of_properties"),
    message: text("message"),
    street: text("street").notNull(),
    houseNumber: text("house_number").notNull(),
    postalCode: text("postal_code").notNull(),
    city: text("city").notNull(),
    country: char("country", { length: 2 }).notNull().default("DE"),
    latitude: numeric("latitude", { precision: 9, scale: 6, mode: "number" }),
    longitude: numeric("longitude", { precision: 9, scale: 6, mode: "number" }),
    location: geographyPoint("location").generatedAlwaysAs(
      sql`CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)::geography END`,
    ),
    geocodingStatus: geocodingStatus("geocoding_status").notNull().default("PENDING"),
    serviceAreaStatus: serviceAreaStatus("service_area_status").notNull().default("UNKNOWN"),
    /** Highest-priority active service area containing the point (only when AVAILABLE). */
    serviceAreaId: uuid("service_area_id").references(() => serviceArea.id, {
      onDelete: "restrict",
    }),
    serviceAreaCheckedAt: timestamp("service_area_checked_at", {
      withTimezone: true,
      mode: "date",
    }),
    privacyNoticeVersion: text("privacy_notice_version").notNull(),
    privacyNoticeAcknowledgedAt: timestamp("privacy_notice_acknowledged_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("service_request_lead_uq").on(t.leadId),
    index("service_request_customer_idx").on(t.customerId),
    index("service_request_created_idx").on(t.createdAt),
    index("service_request_service_area_idx").on(t.serviceAreaId),
    check(
      "service_request_area_chk",
      sql`${t.approximateAreaSqm} IS NULL OR ${t.approximateAreaSqm} > 0`,
    ),
    check("service_request_message_chk", sql`${t.message} IS NULL OR length(${t.message}) <= 2000`),
    check(
      "service_request_coordinates_chk",
      sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`,
    ),
    check(
      "service_request_area_status_chk",
      sql`${t.serviceAreaStatus} = 'UNKNOWN' OR ${t.latitude} IS NOT NULL`,
    ),
    check(
      "service_request_area_id_chk",
      sql`(${t.serviceAreaStatus} = 'AVAILABLE') = (${t.serviceAreaId} IS NOT NULL)`,
    ),
    check(
      "service_request_geocoded_chk",
      sql`(${t.geocodingStatus} IN ('SUCCEEDED', 'MANUAL')) = (${t.latitude} IS NOT NULL)`,
    ),
    check(
      "service_request_properties_chk",
      sql`${t.numberOfProperties} IS NULL OR (${t.numberOfProperties} BETWEEN 1 AND 100000 AND ${t.customerType} = 'PROPERTY_MANAGEMENT')`,
    ),
  ],
);

export const geocodingOutcome = pgEnum("geocoding_outcome", [
  "ACCEPTED",
  "NEEDS_REVIEW",
  "NO_MATCH",
  "UNAVAILABLE",
  "MANUAL_CONFIRMED",
  "MANUAL_REJECTED",
]);

export const geocodePrecision = pgEnum("geocode_precision", [
  "BUILDING",
  "STREET",
  "POSTCODE",
  "CITY",
  "OTHER",
]);

/**
 * Append-only history of geocoding runs and human review decisions for a service request
 * (database trigger prevents UPDATE/DELETE). Stores the provider's normalised address; the
 * request's own coordinates are only set from ACCEPTED or MANUAL_CONFIRMED rows.
 */
export const geocodingAttempt = pgTable(
  "geocoding_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceRequestId: uuid("service_request_id")
      .notNull()
      .references(() => serviceRequest.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    outcome: geocodingOutcome("outcome").notNull(),
    precision: geocodePrecision("precision"),
    confidence: numeric("confidence", { precision: 4, scale: 3, mode: "number" }),
    latitude: numeric("latitude", { precision: 9, scale: 6, mode: "number" }),
    longitude: numeric("longitude", { precision: 9, scale: 6, mode: "number" }),
    street: text("street"),
    houseNumber: text("house_number"),
    postalCode: text("postal_code"),
    city: text("city"),
    region: text("region"),
    country: char("country", { length: 2 }),
    reasons: text("reasons")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** NULL = automated run; otherwise the staff member who decided. */
    performedByUserId: text("performed_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("geocoding_attempt_request_idx").on(t.serviceRequestId, t.createdAt),
    check(
      "geocoding_attempt_coordinates_chk",
      sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`,
    ),
    check(
      "geocoding_attempt_outcome_chk",
      sql`(${t.outcome} IN ('ACCEPTED', 'NEEDS_REVIEW', 'MANUAL_CONFIRMED')) = (${t.latitude} IS NOT NULL)`,
    ),
    check(
      "geocoding_attempt_manual_chk",
      sql`(${t.outcome} IN ('MANUAL_CONFIRMED', 'MANUAL_REJECTED')) = (${t.performedByUserId} IS NOT NULL)`,
    ),
    check(
      "geocoding_attempt_confidence_chk",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
  ],
);

/**
 * Fixed-window counters for public, unauthenticated endpoints (e.g. the request form).
 * Keys are hashed (no IP addresses or e-mail addresses in clear text).
 */
export const publicRateLimit = pgTable("public_rate_limit", {
  key: text("key").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "date" }).notNull(),
  count: integer("count").notNull(),
});
