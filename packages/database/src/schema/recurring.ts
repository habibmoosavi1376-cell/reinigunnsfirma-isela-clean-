import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { createdAt, updatedAt } from "./columns.ts";
import { customer, property } from "./crm.ts";
import { booking } from "./operations.ts";
import { quote } from "./quotes.ts";

/*
 * Recurring cleaning (day 8).
 * - service_contract: a recurrence rule over an ACCEPTED quote (scope and price template).
 * - contract_pause: periods without appointments (inclusive calendar days).
 * - contract_occurrence: one row per contract and calendar day – the idempotency guard of
 *   the generation (UNIQUE(contract_id, occurrence_date)); a booked occurrence points to
 *   exactly one booking.
 * - public_holiday / holiday_year_coverage: verified holiday data per region. Generation is
 *   refused for years without an approved coverage row, so missing data never results in
 *   appointments on public holidays. No holiday data is shipped with the code.
 * Every generated booking goes through the central payment-terms engine like any other
 * booking (prepayment for new customers and jobs 1–2, credit terms only with approval).
 */

export const contractStatus = pgEnum("contract_status", ["ACTIVE", "PAUSED", "ENDED"]);
export const recurrenceFrequency = pgEnum("recurrence_frequency", [
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
]);
export const occurrenceStatus = pgEnum("occurrence_status", ["BOOKED", "SKIPPED"]);
export const occurrenceSkipReason = pgEnum("occurrence_skip_reason", [
  "HOLIDAY",
  "PAUSED",
  "INVALID_LOCAL_TIME",
]);

export const serviceContract = pgTable(
  "service_contract",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => property.id, { onDelete: "restrict" }),
    /** Accepted quote whose items and amounts are copied into every booking. */
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quote.id, { onDelete: "restrict" }),
    frequency: recurrenceFrequency("frequency").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    windowStartMinute: integer("window_start_minute").notNull(),
    windowEndMinute: integer("window_end_minute").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    status: contractStatus("status").notNull().default("ACTIVE"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A quote is the template of at most one contract.
    uniqueIndex("service_contract_quote_uq").on(t.quoteId),
    index("service_contract_customer_idx").on(t.customerId),
    check(
      "service_contract_window_chk",
      sql`${t.windowStartMinute} >= 0 AND ${t.windowStartMinute} < ${t.windowEndMinute} AND ${t.windowEndMinute} <= 1440`,
    ),
    check(
      "service_contract_duration_chk",
      sql`${t.durationMinutes} >= 15 AND ${t.durationMinutes} <= ${t.windowEndMinute} - ${t.windowStartMinute}`,
    ),
    check(
      "service_contract_dates_chk",
      sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
    check(
      "service_contract_monthly_chk",
      sql`${t.frequency} <> 'MONTHLY' OR extract(day from ${t.startDate}) <= 28`,
    ),
    check("service_contract_version_chk", sql`${t.version} >= 1`),
  ],
);

export const contractPause = pgTable(
  "contract_pause",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => serviceContract.id, { onDelete: "restrict" }),
    fromDate: date("from_date", { mode: "string" }).notNull(),
    toDate: date("to_date", { mode: "string" }).notNull(),
    reason: text("reason").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("contract_pause_contract_idx").on(t.contractId),
    check("contract_pause_dates_chk", sql`${t.toDate} >= ${t.fromDate}`),
    check("contract_pause_reason_chk", sql`length(${t.reason}) BETWEEN 3 AND 500`),
  ],
);

export const contractOccurrence = pgTable(
  "contract_occurrence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => serviceContract.id, { onDelete: "restrict" }),
    occurrenceDate: date("occurrence_date", { mode: "string" }).notNull(),
    status: occurrenceStatus("status").notNull(),
    skipReason: occurrenceSkipReason("skip_reason"),
    bookingId: uuid("booking_id").references(() => booking.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    // Idempotency: one row per contract and day, whatever the number of generation runs.
    unique("contract_occurrence_day_uq").on(t.contractId, t.occurrenceDate),
    uniqueIndex("contract_occurrence_booking_uq")
      .on(t.bookingId)
      .where(sql`${t.bookingId} IS NOT NULL`),
    check(
      "contract_occurrence_state_chk",
      sql`(${t.status} = 'BOOKED' AND ${t.bookingId} IS NOT NULL AND ${t.skipReason} IS NULL) OR
        (${t.status} = 'SKIPPED' AND ${t.bookingId} IS NULL AND ${t.skipReason} IS NOT NULL)`,
    ),
  ],
);

export const publicHoliday = pgTable(
  "public_holiday",
  {
    /** ISO 3166-2 subdivision, e.g. "DE-NW". */
    region: text("region").notNull(),
    holidayDate: date("holiday_date", { mode: "string" }).notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.region, t.holidayDate] }),
    check("public_holiday_region_chk", sql`${t.region} ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'`),
    check("public_holiday_name_chk", sql`length(${t.name}) BETWEEN 2 AND 200`),
  ],
);

/** A year of `public_holiday` rows was loaded from a named source and approved by a person. */
export const holidayYearCoverage = pgTable(
  "holiday_year_coverage",
  {
    region: text("region").notNull(),
    year: integer("year").notNull(),
    sourceReference: text("source_reference").notNull(),
    approvedByUserId: text("approved_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.region, t.year] }),
    check("holiday_year_coverage_year_chk", sql`${t.year} BETWEEN 2000 AND 2100`),
    check("holiday_year_coverage_source_chk", sql`length(${t.sourceReference}) BETWEEN 5 AND 500`),
  ],
);
