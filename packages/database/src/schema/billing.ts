import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
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
import { serviceUnit } from "./catalog.ts";
import { createdAt, updatedAt } from "./columns.ts";
import { customer, property } from "./crm.ts";
import { booking, bookingItem, job } from "./operations.ts";
import { quote } from "./quotes.ts";

/*
 * Invoicing, payments and credit terms (day 6).
 * - An invoice is always generated on the server from a booking (the materialised accepted
 *   quote). Once issued it is an immutable snapshot: later price rules, quote or booking
 *   changes never alter it (the database rejects such updates, migration 0007).
 * - Payments are facts recorded against exactly one invoice. The invoice's paid amount is
 *   the sum of the amounts applied by CONFIRMED payments; it changes only through the
 *   billing services under a row lock and an optimistic version check.
 * - The payment history (paid jobs, overdue invoices, failed payments, chargebacks) belongs
 *   to the customer record – never to an account – so a new account cannot reset it.
 */

export const invoiceKind = pgEnum("invoice_kind", ["PREPAYMENT", "FINAL"]);

export const invoiceStatus = pgEnum("invoice_status", [
  "DRAFT",
  "ISSUED",
  "OPEN",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "VOID",
]);

/** Payment terms of the invoice: prepayment before service, or credit terms after it. */
export const invoicePaymentTerms = pgEnum("invoice_payment_terms", ["VORKASSE", "CREDIT_TERMS"]);

export const invoice = pgTable(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Assigned on the server at issuance (never from the browser, never reused). */
    invoiceNumber: text("invoice_number"),
    kind: invoiceKind("kind").notNull(),
    status: invoiceStatus("status").notNull().default("DRAFT"),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => property.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "restrict" }),
    quoteId: uuid("quote_id").references(() => quote.id, { onDelete: "restrict" }),
    jobId: uuid("job_id").references(() => job.id, { onDelete: "restrict" }),
    paymentTerms: invoicePaymentTerms("payment_terms").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
    /** Sum of the amounts applied by confirmed payments (never above the gross amount). */
    paidCents: bigint("paid_cents", { mode: "number" }).notNull().default(0),
    issueDate: date("issue_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    issuedByUserId: text("issued_by_user_id").references(() => user.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "date" }),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("invoice_number_uq").on(t.invoiceNumber),
    // At most one active invoice per booking – also the guard against double invoicing.
    uniqueIndex("invoice_booking_active_uq")
      .on(t.bookingId)
      .where(sql`${t.status} NOT IN ('CANCELLED', 'VOID')`),
    index("invoice_customer_created_idx").on(t.customerId, t.createdAt),
    index("invoice_status_due_idx").on(t.status, t.dueDate),
    index("invoice_created_idx").on(t.createdAt),
    check(
      "invoice_amounts_chk",
      sql`${t.netCents} > 0 AND ${t.taxCents} >= 0 AND ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    check("invoice_paid_range_chk", sql`${t.paidCents} >= 0 AND ${t.paidCents} <= ${t.grossCents}`),
    check(
      "invoice_paid_status_chk",
      sql`(${t.status} <> 'PAID' OR (${t.paidCents} = ${t.grossCents} AND ${t.paidAt} IS NOT NULL)) AND
        (${t.status} NOT IN ('ISSUED', 'OPEN') OR ${t.paidCents} = 0) AND
        (${t.status} <> 'OVERDUE' OR ${t.paidCents} < ${t.grossCents}) AND
        (${t.status} <> 'PARTIALLY_PAID' OR (${t.paidCents} > 0 AND ${t.paidCents} < ${t.grossCents})) AND
        (${t.status} NOT IN ('DRAFT', 'CANCELLED') OR ${t.paidCents} = 0)`,
    ),
    check(
      "invoice_number_chk",
      sql`(${t.status} IN ('DRAFT', 'CANCELLED')) = (${t.invoiceNumber} IS NULL) AND
        (${t.invoiceNumber} IS NULL OR length(${t.invoiceNumber}) BETWEEN 3 AND 40)`,
    ),
    check(
      "invoice_issued_chk",
      sql`${t.status} IN ('DRAFT', 'CANCELLED') OR (${t.issueDate} IS NOT NULL AND ${t.dueDate} IS NOT NULL AND
        ${t.dueDate} >= ${t.issueDate} AND ${t.issuedAt} IS NOT NULL AND ${t.issuedByUserId} IS NOT NULL)`,
    ),
    check(
      "invoice_void_chk",
      sql`(${t.status} = 'VOID') = (${t.voidedAt} IS NOT NULL AND ${t.voidReason} IS NOT NULL) AND
        (${t.voidReason} IS NULL OR length(${t.voidReason}) <= 1000)`,
    ),
    check(
      "invoice_terms_chk",
      sql`(${t.kind} = 'PREPAYMENT') = (${t.paymentTerms} = 'VORKASSE') AND
        (${t.kind} <> 'FINAL' OR ${t.jobId} IS NOT NULL)`,
    ),
    check("invoice_version_chk", sql`${t.version} >= 1`),
  ],
);

/** Immutable line snapshot copied from the booking items (append-only). */
export const invoiceItem = pgTable(
  "invoice_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    bookingItemId: uuid("booking_item_id").references(() => bookingItem.id, {
      onDelete: "restrict",
    }),
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
    unique("invoice_item_position_uq").on(t.invoiceId, t.position),
    check("invoice_item_quantity_chk", sql`${t.quantity} > 0`),
    check(
      "invoice_item_amounts_chk",
      sql`${t.unitPriceCents} >= 0 AND ${t.netCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    check("invoice_item_tax_rate_chk", sql`${t.taxRateBasisPoints} BETWEEN 0 AND 10000`),
  ],
);

export const invoiceStatusTransition = pgTable(
  "invoice_status_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "restrict" }),
    /** NULL = creation. */
    fromStatus: invoiceStatus("from_status"),
    toStatus: invoiceStatus("to_status").notNull(),
    /** NULL = system (e.g. overdue run). */
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("invoice_status_transition_invoice_idx").on(t.invoiceId),
    check(
      "invoice_status_transition_change_chk",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`,
    ),
    check(
      "invoice_status_transition_reason_chk",
      sql`${t.reason} IS NULL OR length(${t.reason}) <= 1000`,
    ),
  ],
);

/**
 * Invoice number counters per series and calendar year. The next number is taken with an
 * UPSERT under the row lock inside the issuing transaction, so a rollback also rolls back the
 * counter: numbers are unique, sequential and never reused (no `count + 1`).
 */
export const invoiceNumberCounter = pgTable(
  "invoice_number_counter",
  {
    seriesKey: text("series_key").notNull(),
    year: integer("year").notNull(),
    lastValue: bigint("last_value", { mode: "number" }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "invoice_number_counter_pk", columns: [t.seriesKey, t.year] }),
    check("invoice_number_counter_value_chk", sql`${t.lastValue} >= 1`),
    check("invoice_number_counter_year_chk", sql`${t.year} BETWEEN 2000 AND 9999`),
  ],
);

export const paymentMethod = pgEnum("payment_method", [
  "BANK_TRANSFER",
  "SEPA_DIRECT_DEBIT",
  "CARD",
]);

export const paymentRecordStatus = pgEnum("payment_record_status", [
  "PENDING",
  "AUTHORIZED",
  "CONFIRMED",
  "FAILED",
  "REFUND_PENDING",
  "REFUNDED",
  "CHARGED_BACK",
]);

export const payment = pgTable(
  "payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    status: paymentRecordStatus("status").notNull().default("PENDING"),
    method: paymentMethod("method").notNull(),
    /** "MANUAL" for payments recorded by finance staff, otherwise the provider key. */
    provider: text("provider").notNull(),
    /** Provider's payment id (NULL for manual payments). */
    providerPaymentId: text("provider_payment_id"),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    /** Part of the amount applied to the invoice (the rest is an overpayment to clarify). */
    appliedCents: bigint("applied_cents", { mode: "number" }).notNull().default(0),
    /** Client- or provider-supplied key; the same key never creates a second payment. */
    idempotencyKey: text("idempotency_key").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
    refundedAt: timestamp("refunded_at", { withTimezone: true, mode: "date" }),
    chargedBackAt: timestamp("charged_back_at", { withTimezone: true, mode: "date" }),
    /** Short reason code/text for failures, refunds and chargebacks (no bank or card data). */
    statusReason: text("status_reason"),
    /** NULL = recorded by a provider event. */
    recordedByUserId: text("recorded_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payment_idempotency_key_uq").on(t.idempotencyKey),
    uniqueIndex("payment_provider_payment_uq")
      .on(t.provider, t.providerPaymentId)
      .where(sql`${t.providerPaymentId} IS NOT NULL`),
    index("payment_invoice_idx").on(t.invoiceId),
    index("payment_customer_status_idx").on(t.customerId, t.status),
    index("payment_status_created_idx").on(t.status, t.createdAt),
    check("payment_amount_chk", sql`${t.amountCents} > 0`),
    check(
      "payment_applied_chk",
      sql`${t.appliedCents} >= 0 AND ${t.appliedCents} <= ${t.amountCents} AND
        (${t.status} IN ('CONFIRMED', 'REFUND_PENDING') OR ${t.appliedCents} = 0)`,
    ),
    check(
      "payment_confirmed_chk",
      sql`${t.status} NOT IN ('CONFIRMED', 'REFUND_PENDING', 'REFUNDED', 'CHARGED_BACK') OR ${t.confirmedAt} IS NOT NULL`,
    ),
    check(
      "payment_text_chk",
      sql`length(${t.idempotencyKey}) BETWEEN 8 AND 200 AND length(${t.provider}) BETWEEN 1 AND 40 AND
        (${t.providerPaymentId} IS NULL OR length(${t.providerPaymentId}) <= 200) AND
        (${t.statusReason} IS NULL OR length(${t.statusReason}) <= 500)`,
    ),
    check("payment_version_chk", sql`${t.version} >= 1`),
  ],
);

/**
 * Proof of a received payment: bank/transaction reference, provider, amount, time and who
 * recorded it. Never card numbers, CVV, PINs or secrets (rejected by the domain service).
 * Unique per provider, so the same bank transaction cannot be booked twice.
 */
export const paymentReference = pgTable(
  "payment_reference",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payment.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    reference: text("reference").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    recordedByUserId: text("recorded_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payment_reference_provider_uq").on(t.provider, t.reference),
    index("payment_reference_payment_idx").on(t.paymentId),
    check("payment_reference_amount_chk", sql`${t.amountCents} > 0`),
    check("payment_reference_text_chk", sql`length(${t.reference}) BETWEEN 3 AND 200`),
  ],
);

export const paymentTransition = pgTable(
  "payment_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payment.id, { onDelete: "restrict" }),
    fromStatus: paymentRecordStatus("from_status"),
    toStatus: paymentRecordStatus("to_status").notNull(),
    actorUserId: text("actor_user_id"),
    /** Provider event that caused the transition (NULL for manual steps). */
    providerEventId: uuid("provider_event_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payment_transition_payment_idx").on(t.paymentId),
    check(
      "payment_transition_change_chk",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`,
    ),
    check("payment_transition_reason_chk", sql`${t.reason} IS NULL OR length(${t.reason}) <= 500`),
  ],
);

export const providerEventStatus = pgEnum("provider_event_status", [
  "RECEIVED",
  "PROCESSED",
  "IGNORED",
  "REJECTED",
]);

/**
 * Inbound payment-provider events (webhooks). The unique (provider, provider_event_id) makes
 * processing idempotent: duplicates and replays are recognised and never applied twice. Only
 * a hash of the verified payload is stored.
 */
export const paymentProviderEvent = pgTable(
  "payment_provider_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    status: providerEventStatus("status").notNull().default("RECEIVED"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    paymentId: uuid("payment_id").references(() => payment.id, { onDelete: "restrict" }),
    outcome: text("outcome"),
  },
  (t) => [
    uniqueIndex("payment_provider_event_uq").on(t.provider, t.providerEventId),
    index("payment_provider_event_payment_idx").on(t.paymentId),
    check(
      "payment_provider_event_text_chk",
      sql`length(${t.providerEventId}) BETWEEN 1 AND 200 AND length(${t.eventType}) BETWEEN 1 AND 100 AND
        (${t.outcome} IS NULL OR length(${t.outcome}) <= 200)`,
    ),
    check(
      "payment_provider_event_processed_chk",
      sql`(${t.status} = 'RECEIVED') = (${t.processedAt} IS NULL)`,
    ),
  ],
);

export const creditTermsStatus = pgEnum("credit_terms_status", [
  "REQUESTED",
  "APPROVED",
  "DENIED",
  "REVOKED",
]);

/**
 * Credit-terms approval flow (invoice after service). Meeting the minimum history is only the
 * precondition for a request – approval is always a separate, audited decision of a second
 * person (four-eyes, enforced by the database).
 */
export const creditTermsApproval = pgTable(
  "credit_terms_approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    status: creditTermsStatus("status").notNull().default("REQUESTED"),
    requestReason: text("request_reason").notNull(),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Customer credit limit set with the approval. */
    creditLimitCents: bigint("credit_limit_cents", { mode: "number" }),
    /** Internal trust assessment 0–100 recorded by the approver. */
    trustScore: integer("trust_score"),
    validUntil: date("valid_until", { mode: "string" }),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decisionReason: text("decision_reason"),
    revokedByUserId: text("revoked_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokeReason: text("revoke_reason"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One open request or active approval per customer – also the concurrency guard.
    uniqueIndex("credit_terms_active_uq")
      .on(t.customerId)
      .where(sql`${t.status} IN ('REQUESTED', 'APPROVED')`),
    index("credit_terms_customer_idx").on(t.customerId, t.createdAt),
    check(
      "credit_terms_decision_chk",
      sql`(${t.status} = 'REQUESTED') = (${t.decidedAt} IS NULL) AND
        (${t.decidedAt} IS NULL OR (${t.decidedByUserId} IS NOT NULL AND ${t.decisionReason} IS NOT NULL))`,
    ),
    check(
      "credit_terms_approved_chk",
      sql`${t.status} NOT IN ('APPROVED', 'REVOKED') OR ${t.decidedByUserId} IS NULL OR
        (${t.creditLimitCents} > 0 AND ${t.trustScore} BETWEEN 0 AND 100)`,
    ),
    check(
      "credit_terms_four_eyes_chk",
      sql`${t.status} NOT IN ('APPROVED', 'REVOKED') OR ${t.decidedByUserId} IS NULL OR ${t.decidedByUserId} <> ${t.requestedByUserId}`,
    ),
    check(
      "credit_terms_revoke_chk",
      sql`(${t.status} = 'REVOKED') = (${t.revokedAt} IS NOT NULL AND ${t.revokedByUserId} IS NOT NULL AND ${t.revokeReason} IS NOT NULL)`,
    ),
    check(
      "credit_terms_text_chk",
      sql`length(${t.requestReason}) BETWEEN 3 AND 1000 AND
        (${t.decisionReason} IS NULL OR length(${t.decisionReason}) <= 1000) AND
        (${t.revokeReason} IS NULL OR length(${t.revokeReason}) <= 1000)`,
    ),
    check("credit_terms_version_chk", sql`${t.version} >= 1`),
  ],
);

export const paymentTermsOutcome = pgEnum("payment_terms_outcome", [
  "VORKASSE_REQUIRED",
  "CREDIT_TERMS_ALLOWED",
  "BLOCKED",
  "REVIEW_REQUIRED",
]);

export const riskEvaluationTrigger = pgEnum("risk_evaluation_trigger", [
  "BOOKING",
  "PAYMENT",
  "OVERDUE",
  "CREDIT_DECISION",
  "MANUAL",
]);

/** Append-only log of payment-terms evaluations (explainable: reasons and counted facts). */
export const paymentRiskEvaluation = pgTable(
  "payment_risk_evaluation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    outcome: paymentTermsOutcome("outcome").notNull(),
    reasons: text("reasons").array().notNull(),
    /** Counted facts only (numbers/flags) – no personal data. */
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
    policyVersion: integer("policy_version"),
    trigger: riskEvaluationTrigger("trigger").notNull(),
    actorUserId: text("actor_user_id"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("payment_risk_evaluation_customer_idx").on(t.customerId, t.evaluatedAt)],
);
