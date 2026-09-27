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
import { serviceCategory } from "./catalog.ts";
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

export const serviceAreaStatus = pgEnum("service_area_status", ["UNKNOWN", "IN_AREA", "OUTSIDE"]);

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
