import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.ts";
import { customer } from "./crm.ts";
import { booking } from "./operations.ts";

/*
 * Transactional notification outbox (day 8). Rows are written idempotently (unique dedupe key
 * per purpose and subject) and delivered by a background dispatcher through the EmailSender
 * port. No recipient address or message body is stored: the recipient (verified customer
 * account) is resolved at delivery time, the body is rendered from the booking.
 *
 * Delivery is at-most-once: the row is committed as SENDING before the provider is called.
 * A row stuck in SENDING (crash between provider call and commit) becomes UNCERTAIN and is
 * never retried automatically – a person checks it. Temporary failures go back to PENDING
 * with exponential backoff until `max attempts`, then DEAD.
 */

export const notificationPurpose = pgEnum("notification_purpose", ["APPOINTMENT_REMINDER"]);

export const notificationStatus = pgEnum("notification_status", [
  "PENDING",
  "SENDING",
  "SENT",
  "DEAD",
  "UNCERTAIN",
  "NO_RECIPIENT",
  "SUPPRESSED",
  "OBSOLETE",
  /** A person reviewed a failed/uncertain delivery and closed it without resending. */
  "DISMISSED",
]);

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: notificationPurpose("purpose").notNull(),
    /** e.g. "APPOINTMENT_REMINDER:<booking id>" – the idempotency key. */
    dedupeKey: text("dedupe_key").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => booking.id, { onDelete: "restrict" }),
    status: notificationStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    /** Machine-readable error class only (never provider messages, addresses or content). */
    lastErrorCode: text("last_error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("notification_outbox_dedupe_uq").on(t.dedupeKey),
    index("notification_outbox_due_idx").on(t.status, t.nextAttemptAt),
    check("notification_outbox_attempts_chk", sql`${t.attempts} >= 0 AND ${t.attempts} <= 20`),
    check("notification_outbox_sent_chk", sql`(${t.status} = 'SENT') = (${t.sentAt} IS NOT NULL)`),
    check(
      "notification_outbox_sending_chk",
      sql`${t.status} <> 'SENDING' OR ${t.claimedAt} IS NOT NULL`,
    ),
    check(
      "notification_outbox_error_chk",
      sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ '^[A-Z_]{2,40}$'`,
    ),
  ],
);
