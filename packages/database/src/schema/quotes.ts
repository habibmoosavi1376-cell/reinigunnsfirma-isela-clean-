import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { service, serviceCategory, serviceUnit } from "./catalog.ts";
import { createdAt, updatedAt } from "./columns.ts";
import { customer, property } from "./crm.ts";
import { lead } from "./leads.ts";

/*
 * Quotes (manual, no automatic price promise). Amounts are integer cents and are always
 * computed on the server; the database re-checks the arithmetic. Status changes only happen
 * through the quote state machine and are recorded append-only in quote_status_transition.
 */

export const quoteStatus = pgEnum("quote_status", [
  "DRAFT",
  "PENDING_REVIEW",
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
  "CANCELLED",
]);

export const quote = pgTable(
  "quote",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id").references(() => property.id, { onDelete: "restrict" }),
    leadId: uuid("lead_id").references(() => lead.id, { onDelete: "restrict" }),
    status: quoteStatus("status").notNull().default("DRAFT"),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    netCents: bigint("net_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull().default(0),
    validUntil: date("valid_until", { mode: "string" }),
    notes: text("notes"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("quote_customer_idx").on(t.customerId),
    index("quote_status_idx").on(t.status),
    index("quote_lead_idx").on(t.leadId),
    check(
      "quote_amounts_chk",
      sql`${t.netCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    check("quote_notes_chk", sql`${t.notes} IS NULL OR length(${t.notes}) <= 4000`),
    check(
      "quote_sent_chk",
      sql`${t.status} IN ('DRAFT', 'PENDING_REVIEW', 'CANCELLED') OR (${t.validUntil} IS NOT NULL AND ${t.sentAt} IS NOT NULL)`,
    ),
  ],
);

export const quoteItem = pgTable(
  "quote_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quote.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
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
    unique("quote_item_position_uq").on(t.quoteId, t.position),
    check("quote_item_position_chk", sql`${t.position} >= 1`),
    check("quote_item_quantity_chk", sql`${t.quantity} > 0`),
    check(
      "quote_item_amounts_chk",
      sql`${t.unitPriceCents} >= 0 AND ${t.netCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    check("quote_item_tax_chk", sql`${t.taxRateBasisPoints} BETWEEN 0 AND 10000`),
    check("quote_item_description_chk", sql`length(${t.description}) BETWEEN 1 AND 500`),
  ],
);

export const quoteStatusTransition = pgTable(
  "quote_status_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quote.id, { onDelete: "restrict" }),
    fromStatus: quoteStatus("from_status").notNull(),
    toStatus: quoteStatus("to_status").notNull(),
    /** NULL only for automated expiry. */
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("quote_status_transition_quote_idx").on(t.quoteId),
    check("quote_status_transition_change_chk", sql`${t.fromStatus} <> ${t.toStatus}`),
  ],
);
