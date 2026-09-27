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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { archivedAt, createdAt, geographyPoint, updatedAt } from "./columns.ts";
import { city, postalCode } from "./catalog.ts";

export const customerKind = pgEnum("customer_kind", ["PRIVATE", "BUSINESS", "PROPERTY_MANAGEMENT"]);
export const customerStatus = pgEnum("customer_status", ["ACTIVE", "INACTIVE", "BLOCKED"]);
export const duplicateReviewStatus = pgEnum("duplicate_review_status", ["NONE", "PENDING"]);

export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: customerKind("kind").notNull(),
    displayName: text("display_name").notNull(),
    companyName: text("company_name"),
    status: customerStatus("status").notNull().default("ACTIVE"),
    duplicateReviewStatus: duplicateReviewStatus("duplicate_review_status")
      .notNull()
      .default("NONE"),
    createdByUserId: text("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    check("customer_company_name_chk", sql`${t.kind} = 'PRIVATE' OR ${t.companyName} IS NOT NULL`),
  ],
);

export const customerIdentityKind = pgEnum("customer_identity_kind", [
  "EMAIL",
  "PHONE",
  "TAX_ID",
  "PAYMENT_REFERENCE",
  "ADDRESS",
]);

/**
 * Hashed identity attributes used to detect returning customers. EMAIL, TAX_ID and
 * PAYMENT_REFERENCE are unique system-wide; PHONE and ADDRESS are signals only.
 */
export const customerIdentity = pgTable(
  "customer_identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    kind: customerIdentityKind("kind").notNull(),
    valueHash: text("value_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("customer_identity_unique_kinds_uq")
      .on(t.kind, t.valueHash)
      .where(sql`${t.kind} IN ('EMAIL', 'TAX_ID', 'PAYMENT_REFERENCE')`),
    unique("customer_identity_customer_kind_value_uq").on(t.customerId, t.kind, t.valueHash),
    index("customer_identity_lookup_idx").on(t.kind, t.valueHash),
  ],
);

export const duplicateCandidateStatus = pgEnum("duplicate_candidate_status", [
  "OPEN",
  "CONFIRMED_SAME",
  "CONFIRMED_DIFFERENT",
]);

export const customerDuplicateCandidate = pgTable(
  "customer_duplicate_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    candidateCustomerId: uuid("candidate_customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    matchedBy: customerIdentityKind("matched_by").notNull(),
    status: duplicateCandidateStatus("status").notNull().default("OPEN"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedByUserId: text("resolved_by_user_id"),
  },
  (t) => [
    unique("customer_duplicate_candidate_uq").on(t.customerId, t.candidateCustomerId, t.matchedBy),
    check(
      "customer_duplicate_candidate_self_chk",
      sql`${t.customerId} <> ${t.candidateCustomerId}`,
    ),
  ],
);

export const addressType = pgEnum("address_type", ["BILLING", "SERVICE", "OTHER"]);
export const geocodingStatus = pgEnum("geocoding_status", [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "MANUAL",
  "NEEDS_REVIEW",
]);
export const addressSource = pgEnum("address_source", ["CUSTOMER_INPUT", "STAFF_INPUT", "IMPORT"]);
export const addressVerificationStatus = pgEnum("address_verification_status", [
  "UNVERIFIED",
  "VERIFIED",
  "REJECTED",
]);

export const customerAddress = pgTable(
  "customer_address",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    addressType: addressType("address_type").notNull(),
    street: text("street").notNull(),
    houseNumber: text("house_number").notNull(),
    postalCode: text("postal_code").notNull(),
    city: text("city").notNull(),
    country: char("country", { length: 2 }).notNull().default("DE"),
    cityId: uuid("city_id").references(() => city.id, { onDelete: "restrict" }),
    postalCodeId: uuid("postal_code_id").references(() => postalCode.id, {
      onDelete: "restrict",
    }),
    latitude: numeric("latitude", { precision: 9, scale: 6, mode: "number" }),
    longitude: numeric("longitude", { precision: 9, scale: 6, mode: "number" }),
    /** Derived from latitude/longitude – never written directly. */
    location: geographyPoint("location").generatedAlwaysAs(
      sql`CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)::geography END`,
    ),
    geocodingStatus: geocodingStatus("geocoding_status").notNull().default("PENDING"),
    geocodedAt: timestamp("geocoded_at", { withTimezone: true, mode: "date" }),
    source: addressSource("source").notNull(),
    verificationStatus: addressVerificationStatus("verification_status")
      .notNull()
      .default("UNVERIFIED"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    index("customer_address_customer_idx").on(t.customerId),
    index("customer_address_location_gix").using("gist", t.location),
    check(
      "customer_address_coordinates_chk",
      sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`,
    ),
    check(
      "customer_address_coordinate_range_chk",
      sql`${t.latitude} IS NULL OR (${t.latitude} BETWEEN -90 AND 90 AND ${t.longitude} BETWEEN -180 AND 180)`,
    ),
    check(
      "customer_address_geocoding_chk",
      sql`(${t.geocodingStatus} IN ('SUCCEEDED', 'MANUAL')) = (${t.latitude} IS NOT NULL AND ${t.geocodedAt} IS NOT NULL)`,
    ),
  ],
);

export const propertyType = pgEnum("property_type", [
  "APARTMENT",
  "HOUSE",
  "OFFICE",
  "PRACTICE",
  "STAIRWELL",
  "COMMERCIAL",
  "OTHER",
]);

export const property = pgTable(
  "property",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    addressId: uuid("address_id")
      .notNull()
      .references(() => customerAddress.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    propertyType: propertyType("property_type").notNull(),
    areaSqm: numeric("area_sqm", { precision: 10, scale: 2, mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    index("property_customer_idx").on(t.customerId),
    check("property_area_chk", sql`${t.areaSqm} IS NULL OR ${t.areaSqm} > 0`),
  ],
);

export const partnerStatus = pgEnum("partner_status", [
  "PENDING_VERIFICATION",
  "ACTIVE",
  "SUSPENDED",
]);

/** Minimal partner master data required for geo matching; extended on day 5. */
export const partner = pgTable(
  "partner",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legalName: text("legal_name").notNull(),
    status: partnerStatus("status").notNull().default("PENDING_VERIFICATION"),
    baseLatitude: numeric("base_latitude", { precision: 9, scale: 6, mode: "number" }).notNull(),
    baseLongitude: numeric("base_longitude", { precision: 9, scale: 6, mode: "number" }).notNull(),
    baseLocation: geographyPoint("base_location")
      .notNull()
      .generatedAlwaysAs(
        sql`ST_SetSRID(ST_MakePoint(base_longitude::double precision, base_latitude::double precision), 4326)::geography`,
      ),
    serviceRadiusM: integer("service_radius_m").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    index("partner_base_location_gix").using("gist", t.baseLocation),
    check(
      "partner_service_radius_chk",
      sql`${t.serviceRadiusM} > 0 AND ${t.serviceRadiusM} <= 300000`,
    ),
  ],
);
