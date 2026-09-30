import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { service, serviceArea } from "./catalog.ts";
import { archivedAt, createdAt, geographyPoint, updatedAt } from "./columns.ts";
import { partner } from "./crm.ts";

/*
 * Workforce (day 5): own employees and partner verification data used by the assignment
 * rules. Only operational data is stored – no health data (absences carry a neutral kind),
 * no private addresses (the optional base is an operational starting point).
 */

export const employee = pgTable(
  "employee",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Linked STAFF account (own jobs only); NULL until the account exists. */
    userId: text("user_id")
      .unique()
      .references(() => user.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    active: boolean("active").notNull().default(true),
    /** Qualification keys (data), matched against service.required_qualifications. */
    qualifications: text("qualifications")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    baseLatitude: numeric("base_latitude", { precision: 9, scale: 6, mode: "number" }),
    baseLongitude: numeric("base_longitude", { precision: 9, scale: 6, mode: "number" }),
    baseLocation: geographyPoint("base_location").generatedAlwaysAs(
      sql`CASE WHEN base_latitude IS NOT NULL AND base_longitude IS NOT NULL THEN ST_SetSRID(ST_MakePoint(base_longitude::double precision, base_latitude::double precision), 4326)::geography END`,
    ),
    /** Capacity: maximum jobs per calendar day; NULL = no limit configured. */
    maxJobsPerDay: integer("max_jobs_per_day"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    check("employee_name_chk", sql`length(${t.displayName}) BETWEEN 1 AND 200`),
    check(
      "employee_coordinates_chk",
      sql`(${t.baseLatitude} IS NULL) = (${t.baseLongitude} IS NULL) AND
        (${t.baseLatitude} IS NULL OR (${t.baseLatitude} BETWEEN -90 AND 90 AND ${t.baseLongitude} BETWEEN -180 AND 180))`,
    ),
    check(
      "employee_capacity_chk",
      sql`${t.maxJobsPerDay} IS NULL OR ${t.maxJobsPerDay} BETWEEN 1 AND 50`,
    ),
    check("employee_qualifications_chk", sql`cardinality(${t.qualifications}) <= 50`),
  ],
);

/** Service areas an employee works in (assignment requires the job's area). */
export const employeeServiceArea = pgTable(
  "employee_service_area",
  {
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "restrict" }),
    serviceAreaId: uuid("service_area_id")
      .notNull()
      .references(() => serviceArea.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.serviceAreaId] })],
);

/** Weekly working window in business-local time (ISO weekday 1 = Monday). */
export const employeeWorkingWindow = pgTable(
  "employee_working_window",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "restrict" }),
    weekday: smallint("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("employee_working_window_employee_idx").on(t.employeeId),
    check("employee_working_window_weekday_chk", sql`${t.weekday} BETWEEN 1 AND 7`),
    check(
      "employee_working_window_minutes_chk",
      sql`${t.startMinute} BETWEEN 0 AND 1439 AND ${t.endMinute} BETWEEN 1 AND 1440 AND ${t.endMinute} > ${t.startMinute}`,
    ),
  ],
);

/** Neutral absence kinds – deliberately no "sick" value (health data, Art. 9 GDPR). */
export const employeeUnavailabilityKind = pgEnum("employee_unavailability_kind", [
  "ABSENCE",
  "TRAINING",
  "OTHER",
]);

export const employeeUnavailability = pgTable(
  "employee_unavailability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employee.id, { onDelete: "restrict" }),
    kind: employeeUnavailabilityKind("kind").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("employee_unavailability_employee_idx").on(t.employeeId, t.startsAt),
    check("employee_unavailability_period_chk", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

/** Services a partner offers (service match for partner assignment). */
export const partnerService = pgTable(
  "partner_service",
  {
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partner.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.partnerId, t.serviceId] }),
    index("partner_service_service_idx").on(t.serviceId),
  ],
);

export const partnerDocumentKind = pgEnum("partner_document_kind", [
  "TRADE_REGISTRATION",
  "LIABILITY_INSURANCE",
  "OTHER",
]);

export const partnerDocumentStatus = pgEnum("partner_document_status", [
  "PENDING",
  "VERIFIED",
  "REJECTED",
]);

/**
 * Verification evidence of a partner (metadata only – file uploads follow with the secure
 * upload module). `reference` is a short identifier, never the document content.
 */
export const partnerDocument = pgTable(
  "partner_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partner.id, { onDelete: "restrict" }),
    kind: partnerDocumentKind("kind").notNull(),
    status: partnerDocumentStatus("status").notNull().default("PENDING"),
    reference: text("reference"),
    validUntil: date("valid_until", { mode: "string" }),
    verifiedByUserId: text("verified_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("partner_document_partner_idx").on(t.partnerId),
    check(
      "partner_document_verified_chk",
      sql`${t.status} = 'PENDING' OR (${t.verifiedAt} IS NOT NULL AND ${t.verifiedByUserId} IS NOT NULL)`,
    ),
    check(
      "partner_document_reference_chk",
      sql`${t.reference} IS NULL OR length(${t.reference}) <= 100`,
    ),
  ],
);
