import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "./columns.ts";

export const consentSubjectType = pgEnum("consent_subject_type", [
  "CUSTOMER",
  "LEAD_CONTACT",
  "USER",
]);
export const consentPurpose = pgEnum("consent_purpose", [
  "MARKETING_EMAIL",
  "MARKETING_PHONE",
  "COOKIES_ANALYTICS",
  "REVIEW_REQUEST",
  "REFERRAL_CONTACT",
  "OTHER_COMMUNICATION",
]);
/** Only consent-type legal bases – other bases are documented on the processed record. */
export const consentLegalBasis = pgEnum("consent_legal_basis", ["GDPR_ART6_1A", "TDDDG_25_1"]);
export const consentStatus = pgEnum("consent_status", ["GRANTED", "WITHDRAWN"]);

/** Immutable consent evidence. A withdrawal is a new row; the latest row per subject/purpose wins. */
export const consent = pgTable(
  "consent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: consentSubjectType("subject_type").notNull(),
    // text: USER subjects use Better Auth ids, other subjects use UUIDs.
    subjectId: text("subject_id").notNull(),
    purpose: consentPurpose("purpose").notNull(),
    legalBasis: consentLegalBasis("legal_basis").notNull(),
    status: consentStatus("status").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: "date" }),
    source: text("source").notNull(),
    textVersion: text("text_version").notNull(),
    evidenceReference: text("evidence_reference"),
    recordedByUserId: text("recorded_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("consent_subject_idx").on(t.subjectType, t.subjectId, t.purpose, t.createdAt),
    check(
      "consent_status_dates_chk",
      sql`(${t.status} = 'GRANTED' AND ${t.grantedAt} IS NOT NULL AND ${t.withdrawnAt} IS NULL) OR
          (${t.status} = 'WITHDRAWN' AND ${t.withdrawnAt} IS NOT NULL)`,
    ),
    check(
      "consent_cookie_basis_chk",
      sql`(${t.purpose} = 'COOKIES_ANALYTICS') = (${t.legalBasis} = 'TDDDG_25_1')`,
    ),
  ],
);

export const settingScopeType = pgEnum("setting_scope_type", [
  "GLOBAL",
  "SERVICE_AREA",
  "CUSTOMER",
]);

/**
 * Versioned, typed configuration. Values are validated against the registered schema of
 * the key before insert. Overlapping validity periods per key and scope are prevented by
 * an exclusion constraint (see migration 0002).
 */
export const setting = pgTable(
  "setting",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    scopeType: settingScopeType("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    version: integer("version").notNull(),
    value: jsonb("value").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true, mode: "date" }),
    changeReason: text("change_reason").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    unique("setting_version_uq").on(t.key, t.scopeType, t.scopeId, t.version).nullsNotDistinct(),
    index("setting_lookup_idx").on(t.key, t.scopeType, t.scopeId),
    check("setting_scope_chk", sql`(${t.scopeType} = 'GLOBAL') = (${t.scopeId} IS NULL)`),
    check("setting_version_chk", sql`${t.version} >= 1`),
    check(
      "setting_period_chk",
      sql`${t.effectiveUntil} IS NULL OR ${t.effectiveUntil} > ${t.effectiveFrom}`,
    ),
  ],
);

export const auditActorType = pgEnum("audit_actor_type", ["USER", "SYSTEM"]);

/** Append-only audit trail (UPDATE/DELETE blocked by trigger, see migration 0002). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    correlationId: text("correlation_id"),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId, t.occurredAt),
    index("audit_log_actor_idx").on(t.actorId, t.occurredAt),
    check("audit_log_actor_chk", sql`(${t.actorType} = 'SYSTEM') OR (${t.actorId} IS NOT NULL)`),
  ],
);
