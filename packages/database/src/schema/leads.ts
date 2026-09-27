import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { archivedAt, createdAt, geographyPoint, updatedAt } from "./columns.ts";
import { user } from "./auth.ts";

export const leadProviderKind = pgEnum("lead_provider_kind", [
  "BUSINESS_SEARCH",
  "PUBLIC_OPPORTUNITY",
  "WEBSITE_RESEARCH",
  "REFERRAL",
  "INTERNAL_INBOUND",
]);

export const processingLegalBasis = pgEnum("processing_legal_basis", [
  "GDPR_ART6_1A_CONSENT",
  "GDPR_ART6_1B_CONTRACT",
  "GDPR_ART6_1F_LEGITIMATE_INTEREST",
]);

export const leadSource = pgTable(
  "lead_source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    providerKind: leadProviderKind("provider_kind").notNull(),
    legalBasis: processingLegalBasis("legal_basis").notNull(),
    termsReviewedAt: timestamp("terms_reviewed_at", { withTimezone: true, mode: "date" }),
    allowedUse: text("allowed_use"),
    retentionDays: integer("retention_days").notNull(),
    rateLimitPerMinute: integer("rate_limit_per_minute").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    sourceMetadata: jsonb("source_metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "lead_source_enabled_requires_review_chk",
      sql`${t.enabled} = false OR (
        ${t.allowedUse} IS NOT NULL AND length(trim(${t.allowedUse})) > 0 AND (
          ${t.providerKind} IN ('REFERRAL', 'INTERNAL_INBOUND') OR ${t.termsReviewedAt} IS NOT NULL
        )
      )`,
    ),
    check("lead_source_retention_chk", sql`${t.retentionDays} BETWEEN 1 AND 1095`),
    check("lead_source_rate_limit_chk", sql`${t.rateLimitPerMinute} BETWEEN 1 AND 600`),
  ],
);

export const leadStatus = pgEnum("lead_status", [
  "DISCOVERED",
  "RESEARCHING",
  "QUALIFIED",
  "OUTREACH_DRAFTED",
  "CONTACTED",
  "RESPONSE",
  "QUALIFIED_OPPORTUNITY",
  "QUOTE_REQUEST",
  "QUOTE_SENT",
  "NEGOTIATION",
  "WON",
  "LOST",
  "FOLLOW_UP",
]);

export const lead = pgTable(
  "lead",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => leadSource.id, { onDelete: "restrict" }),
    sourceReference: text("source_reference"),
    status: leadStatus("status").notNull().default("DISCOVERED"),
    companyName: text("company_name").notNull(),
    segment: text("segment"),
    website: text("website"),
    postalCode: text("postal_code"),
    city: text("city"),
    location: geographyPoint("location"),
    outsideServiceArea: boolean("outside_service_area"),
    score: integer("score"),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "restrict" }),
    collectedAt: timestamp("collected_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (t) => [
    uniqueIndex("lead_source_reference_uq")
      .on(t.sourceId, t.sourceReference)
      .where(sql`${t.sourceReference} IS NOT NULL`),
    index("lead_status_idx").on(t.status),
    index("lead_location_gix").using("gist", t.location),
    check("lead_score_chk", sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 100`),
  ],
);

export const leadStatusTransition = pgTable(
  "lead_status_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "restrict" }),
    fromStatus: leadStatus("from_status").notNull(),
    toStatus: leadStatus("to_status").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("lead_status_transition_lead_idx").on(t.leadId),
    check("lead_status_transition_change_chk", sql`${t.fromStatus} <> ${t.toStatus}`),
  ],
);

export const contactConsentStatus = pgEnum("contact_consent_status", [
  "NOT_REQUIRED",
  "UNKNOWN",
  "GRANTED",
  "WITHDRAWN",
]);

export const leadContact = pgTable(
  "lead_contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "restrict" }),
    fullName: text("full_name").notNull(),
    roleTitle: text("role_title"),
    email: text("email"),
    phone: text("phone"),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => leadSource.id, { onDelete: "restrict" }),
    legalBasis: processingLegalBasis("legal_basis").notNull(),
    consentStatus: contactConsentStatus("consent_status").notNull().default("UNKNOWN"),
    suppressed: boolean("suppressed").notNull().default(false),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true, mode: "date" }),
    suppressionReason: text("suppression_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("lead_contact_lead_idx").on(t.leadId),
    check("lead_contact_channel_chk", sql`${t.email} IS NOT NULL OR ${t.phone} IS NOT NULL`),
    check("lead_contact_suppression_chk", sql`${t.suppressed} = (${t.suppressedAt} IS NOT NULL)`),
  ],
);

export const suppressionChannel = pgEnum("suppression_channel", ["EMAIL", "PHONE"]);

/** Global objection list (hashed values). Applies to every future lead and contact. */
export const contactSuppression = pgTable(
  "contact_suppression",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: suppressionChannel("channel").notNull(),
    valueHash: text("value_hash").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("contact_suppression_uq").on(t.channel, t.valueHash)],
);
