import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { service, serviceArea, serviceCategory, serviceUnit } from "./catalog.ts";
import { createdAt, updatedAt } from "./columns.ts";
import { customer, customerAddress, partner, property } from "./crm.ts";
import { quote, quoteItem } from "./quotes.ts";
import { employee } from "./workforce.ts";

/*
 * Bookings and jobs (day 5).
 * - Booking = "the customer has booked a cleaning" (commercial, from an ACCEPTED quote).
 * - Job     = "this concrete cleaning is carried out" (operational, assigned to staff/partner).
 * Status columns change only through the domain state machines (@isela/operations); every
 * change is recorded in an append-only transition table and in the audit log. The database
 * repeats the most important guards (payment before confirmation, no double assignment).
 */

export const bookingStatus = pgEnum("booking_status", [
  "REQUESTED",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "SCHEDULED",
  "CANCELLED",
  "COMPLETED",
]);

/** Origin of a booking. Only accepted quotes create bookings so far. */
export const bookingSource = pgEnum("booking_source", ["QUOTE"]);

/** Result of the payment-risk evaluation at booking time. */
export const paymentRequirement = pgEnum("payment_requirement", [
  "VORKASSE_REQUIRED",
  "CREDIT_TERMS_APPROVED",
]);

export const paymentStatus = pgEnum("payment_status", [
  "PAYMENT_REQUIRED",
  "PAYMENT_PENDING",
  "PAYMENT_CONFIRMED",
  "PAYMENT_FAILED",
  "REFUND_PENDING",
  "REFUNDED",
]);

export const booking = pgTable(
  "booking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => property.id, { onDelete: "restrict" }),
    /** Service address (the property's address at booking time). */
    addressId: uuid("address_id")
      .notNull()
      .references(() => customerAddress.id, { onDelete: "restrict" }),
    quoteId: uuid("quote_id").references(() => quote.id, { onDelete: "restrict" }),
    source: bookingSource("source").notNull(),
    status: bookingStatus("status").notNull().default("REQUESTED"),
    /** Requested calendar date (business time zone) and time window. */
    requestedDate: date("requested_date", { mode: "string" }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true, mode: "date" }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
    paymentRequirement: paymentRequirement("payment_requirement").notNull(),
    /** NULL only with approved credit terms (invoice after service, day 6). */
    paymentStatus: paymentStatus("payment_status"),
    /** Payment-risk decision snapshot: terms, reason codes, policy version. */
    paymentDecision: jsonb("payment_decision").$type<Record<string, unknown>>().notNull(),
    /**
     * Set when the payment protection reverted the booking to prepayment (overdue invoice,
     * chargeback): the booking needs a finance review before it is carried out (day 6).
     */
    paymentReviewRequired: boolean("payment_review_required").notNull().default(false),
    operationalNotes: text("operational_notes"),
    cancellationReason: text("cancellation_reason"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    // One booking per quote – also the guard against two concurrent conversions.
    uniqueIndex("booking_quote_uq")
      .on(t.quoteId)
      .where(sql`${t.quoteId} IS NOT NULL`),
    // Customer portal and customer file: own bookings by date.
    index("booking_customer_window_idx").on(t.customerId, t.windowStart),
    // Back-office list: status filter ordered by date.
    index("booking_status_window_idx").on(t.status, t.windowStart),
    check("booking_window_chk", sql`${t.windowEnd} > ${t.windowStart}`),
    check(
      "booking_duration_chk",
      sql`${t.durationMinutes} > 0 AND ${t.durationMinutes} * interval '1 minute' <= ${t.windowEnd} - ${t.windowStart}`,
    ),
    check(
      "booking_amounts_chk",
      sql`${t.netCents} > 0 AND ${t.taxCents} >= 0 AND ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    check("booking_source_chk", sql`${t.source} <> 'QUOTE' OR ${t.quoteId} IS NOT NULL`),
    check(
      "booking_payment_status_chk",
      sql`(${t.paymentRequirement} = 'VORKASSE_REQUIRED') = (${t.paymentStatus} IS NOT NULL)`,
    ),
    // Payment guard in the database: prepayment bookings are only confirmed once paid.
    check(
      "booking_prepayment_guard_chk",
      sql`${t.paymentRequirement} <> 'VORKASSE_REQUIRED' OR ${t.status} IN ('REQUESTED', 'PENDING_PAYMENT', 'CANCELLED') OR
        ${t.paymentStatus} IN ('PAYMENT_CONFIRMED', 'REFUND_PENDING', 'REFUNDED')`,
    ),
    check(
      "booking_pending_payment_chk",
      sql`${t.status} <> 'PENDING_PAYMENT' OR ${t.paymentRequirement} = 'VORKASSE_REQUIRED'`,
    ),
    check(
      "booking_cancel_chk",
      sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} IS NOT NULL AND ${t.cancellationReason} IS NOT NULL)`,
    ),
    check(
      "booking_text_chk",
      sql`(${t.operationalNotes} IS NULL OR length(${t.operationalNotes}) <= 2000) AND
        (${t.cancellationReason} IS NULL OR length(${t.cancellationReason}) <= 1000)`,
    ),
    check("booking_version_chk", sql`${t.version} >= 1`),
  ],
);

/** Contractual snapshot of the accepted quote items (append-only). */
export const bookingItem = pgTable(
  "booking_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    quoteItemId: uuid("quote_item_id").references(() => quoteItem.id, { onDelete: "restrict" }),
    serviceCategoryId: uuid("service_category_id")
      .notNull()
      .references(() => serviceCategory.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => service.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3, mode: "number" }).notNull(),
    unit: serviceUnit("unit").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    taxRateBasisPoints: integer("tax_rate_basis_points").notNull(),
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("booking_item_position_uq").on(t.bookingId, t.position),
    check("booking_item_quantity_chk", sql`${t.quantity} > 0`),
    check(
      "booking_item_amounts_chk",
      sql`${t.unitPriceCents} >= 0 AND ${t.netCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
  ],
);

export const bookingStatusTransition = pgTable(
  "booking_status_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "restrict" }),
    /** NULL = creation. */
    fromStatus: bookingStatus("from_status"),
    toStatus: bookingStatus("to_status").notNull(),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("booking_status_transition_booking_idx").on(t.bookingId),
    check(
      "booking_status_transition_change_chk",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`,
    ),
  ],
);

export const paymentStatusTransition = pgTable(
  "payment_status_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "restrict" }),
    /** NULL = initial state at booking creation. */
    fromStatus: paymentStatus("from_status"),
    toStatus: paymentStatus("to_status").notNull(),
    actorUserId: text("actor_user_id"),
    /** Payment reference or reason (no bank or card data). */
    reference: text("reference"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payment_status_transition_booking_idx").on(t.bookingId),
    check(
      "payment_status_transition_change_chk",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`,
    ),
    check(
      "payment_status_transition_reference_chk",
      sql`${t.reference} IS NULL OR length(${t.reference}) <= 200`,
    ),
  ],
);

export const jobStatus = pgEnum("job_status", [
  "PLANNED",
  "ASSIGNMENT_PENDING",
  "ASSIGNED",
  "IN_PROGRESS",
  "COMPLETED",
  "QUALITY_CHECK",
  "CLOSED",
  "CANCELLED",
]);

export const fulfillmentType = pgEnum("fulfillment_type", ["IN_HOUSE", "PARTNER"]);

export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "restrict" }),
    status: jobStatus("status").notNull().default("PLANNED"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true, mode: "date" }).notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true, mode: "date" }).notNull(),
    /** Highest-priority active service area of the service address at job creation. */
    serviceAreaId: uuid("service_area_id").references(() => serviceArea.id, {
      onDelete: "restrict",
    }),
    /** Union of the services' required qualifications at job creation (snapshot). */
    requiredQualifications: text("required_qualifications")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    fulfillmentType: fulfillmentType("fulfillment_type"),
    operationalNotes: text("operational_notes"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    // One job per booking (recurring series follow on day 8) – also the race guard.
    unique("job_booking_uq").on(t.bookingId),
    // Dispatch board: jobs by status and start time.
    index("job_status_start_idx").on(t.status, t.scheduledStart),
    check("job_schedule_chk", sql`${t.scheduledEnd} > ${t.scheduledStart}`),
    check(
      "job_fulfillment_chk",
      sql`${t.status} IN ('PLANNED', 'ASSIGNMENT_PENDING', 'CANCELLED') OR ${t.fulfillmentType} IS NOT NULL`,
    ),
    check(
      "job_notes_chk",
      sql`${t.operationalNotes} IS NULL OR length(${t.operationalNotes}) <= 2000`,
    ),
    check("job_version_chk", sql`${t.version} >= 1`),
  ],
);

export const jobStatusTransition = pgTable(
  "job_status_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "restrict" }),
    fromStatus: jobStatus("from_status"),
    toStatus: jobStatus("to_status").notNull(),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("job_status_transition_job_idx").on(t.jobId),
    check(
      "job_status_transition_change_chk",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`,
    ),
  ],
);

export const assignmentStatus = pgEnum("assignment_status", ["ACTIVE", "RELEASED"]);

/**
 * Assignment of a job to exactly one employee or one partner. Overlapping ACTIVE assignments
 * of the same employee are rejected by an exclusion constraint (migration 0006); partners are
 * limited by their configured capacity (checked under an advisory lock).
 */
export const jobAssignment = pgTable(
  "job_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id").references(() => employee.id, { onDelete: "restrict" }),
    partnerId: uuid("partner_id").references(() => partner.id, { onDelete: "restrict" }),
    status: assignmentStatus("status").notNull().default("ACTIVE"),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Explainable score and factors at assignment time (no opaque AI score). */
    score: integer("score"),
    factors: jsonb("factors").$type<Record<string, unknown>>().notNull(),
    assignedByUserId: text("assigned_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    releasedByUserId: text("released_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    releaseReason: text("release_reason"),
  },
  (t) => [
    uniqueIndex("job_assignment_active_job_uq")
      .on(t.jobId)
      .where(sql`${t.status} = 'ACTIVE'`),
    // Partner capacity checks and "own jobs" of a partner.
    index("job_assignment_partner_active_idx")
      .on(t.partnerId, t.startsAt)
      .where(sql`${t.status} = 'ACTIVE' AND ${t.partnerId} IS NOT NULL`),
    check("job_assignment_target_chk", sql`(${t.employeeId} IS NULL) <> (${t.partnerId} IS NULL)`),
    check("job_assignment_period_chk", sql`${t.endsAt} > ${t.startsAt}`),
    check("job_assignment_score_chk", sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 100`),
    check(
      "job_assignment_release_chk",
      sql`(${t.status} = 'RELEASED') = (${t.releasedAt} IS NOT NULL AND ${t.releasedByUserId} IS NOT NULL AND ${t.releaseReason} IS NOT NULL)`,
    ),
    check(
      "job_assignment_reason_chk",
      sql`${t.releaseReason} IS NULL OR length(${t.releaseReason}) <= 1000`,
    ),
  ],
);
