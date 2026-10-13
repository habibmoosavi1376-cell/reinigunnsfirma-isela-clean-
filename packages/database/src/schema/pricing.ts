import { sql } from "drizzle-orm";
import {
  bigint,
  char,
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
import { user } from "./auth.ts";
import { service, serviceArea } from "./catalog.ts";
import { createdAt, updatedAt } from "./columns.ts";

/*
 * Pricing (day 5). Price rules are versioned data: a rule set is edited only as DRAFT, becomes
 * immutable once ACTIVE (trigger in migration 0006) and is RETIRED when replaced. Every
 * calculation is stored append-only with its engine and rule-set version, so later rule
 * changes never alter existing quotes. Values that the owner has not decided yet are stored as
 * "CONFIG_REQUIRED" inside the rule document; the engine then refuses to produce a price.
 */

export const priceRuleSetStatus = pgEnum("price_rule_set_status", ["DRAFT", "ACTIVE", "RETIRED"]);

export const priceRuleSet = pgTable(
  "price_rule_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic version number (part of `pricing_version`). */
    version: integer("version").notNull().unique(),
    /** NULL = default rule set; otherwise regional rules for one service area. */
    serviceAreaId: uuid("service_area_id").references(() => serviceArea.id, {
      onDelete: "restrict",
    }),
    status: priceRuleSetStatus("status").notNull().default("DRAFT"),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    /** Rule document, validated by @isela/pricing before every write. */
    rules: jsonb("rules").$type<Record<string, unknown>>().notNull(),
    changeReason: text("change_reason").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    activatedByUserId: text("activated_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true, mode: "date" }),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one ACTIVE rule set per scope (default / each service area).
    uniqueIndex("price_rule_set_active_default_uq")
      .on(t.status)
      .where(sql`${t.status} = 'ACTIVE' AND ${t.serviceAreaId} IS NULL`),
    uniqueIndex("price_rule_set_active_area_uq")
      .on(t.serviceAreaId)
      .where(sql`${t.status} = 'ACTIVE' AND ${t.serviceAreaId} IS NOT NULL`),
    check("price_rule_set_version_chk", sql`${t.version} >= 1`),
    check(
      "price_rule_set_activation_chk",
      sql`${t.status} = 'DRAFT' OR (${t.activatedAt} IS NOT NULL AND ${t.activatedByUserId} IS NOT NULL)`,
    ),
    check(
      "price_rule_set_retired_chk",
      sql`(${t.status} = 'RETIRED') = (${t.retiredAt} IS NOT NULL)`,
    ),
    check("price_rule_set_reason_chk", sql`length(${t.changeReason}) BETWEEN 3 AND 1000`),
  ],
);

export const pricingCalculationStatus = pgEnum("pricing_calculation_status", [
  "CALCULATED",
  "CONFIG_REQUIRED",
]);

/**
 * Append-only record of one engine run (input, breakdown, result, versions). Internal cost and
 * margin columns are only exposed to roles with `finance:internal_read`.
 */
export const pricingCalculation = pgTable(
  "pricing_calculation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: pricingCalculationStatus("status").notNull(),
    engineVersion: text("engine_version").notNull(),
    /** e.g. "v1+r3" = engine v1 with rule set version 3; NULL without an active rule set. */
    pricingVersion: text("pricing_version"),
    ruleSetId: uuid("rule_set_id").references(() => priceRuleSet.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "restrict" }),
    /** Quote the calculation was made for (plain uuid – quotes reference calculations). */
    quoteId: uuid("quote_id"),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    netCents: bigint("net_cents", { mode: "number" }),
    taxRateBasisPoints: integer("tax_rate_basis_points"),
    taxCents: bigint("tax_cents", { mode: "number" }),
    grossCents: bigint("gross_cents", { mode: "number" }),
    estimatedLaborMinutes: integer("estimated_labor_minutes"),
    directCostsCents: bigint("direct_costs_cents", { mode: "number" }),
    internalCostCents: bigint("internal_cost_cents", { mode: "number" }),
    /** May be negative (loss) – visible to finance roles only. */
    contributionMarginCents: bigint("contribution_margin_cents", { mode: "number" }),
    /** Normalised engine input (no personal data: quantities, keys, ids). */
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    /** Breakdown or the list of missing configuration keys. */
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("pricing_calculation_quote_idx").on(t.quoteId),
    check(
      "pricing_calculation_amounts_chk",
      sql`${t.status} <> 'CALCULATED' OR (
        ${t.netCents} > 0 AND ${t.taxCents} >= 0 AND ${t.grossCents} = ${t.netCents} + ${t.taxCents} AND
        ${t.taxRateBasisPoints} BETWEEN 0 AND 10000 AND ${t.pricingVersion} IS NOT NULL AND
        ${t.ruleSetId} IS NOT NULL AND ${t.estimatedLaborMinutes} >= 0 AND ${t.directCostsCents} >= 0
      )`,
    ),
    check(
      "pricing_calculation_config_required_chk",
      sql`${t.status} <> 'CONFIG_REQUIRED' OR (${t.netCents} IS NULL AND ${t.grossCents} IS NULL)`,
    ),
  ],
);
