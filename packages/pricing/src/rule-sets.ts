import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  hasGlobalPermission,
  requireActor,
  type Actor,
  type Permission,
  type ServiceContext,
} from "@isela/auth";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  max,
  schema,
  sql,
  type DbExecutor,
  type Transaction,
} from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { emptyPriceRules, listConfigRequired, priceRulesSchema, type PriceRules } from "./rules.ts";

/*
 * Price rule sets: versioned, auditable business data. Drafts are edited by pricing:manage,
 * activation (the business decision) needs pricing:approve. An active rule set is immutable
 * (database trigger); a new version replaces it and the old one is RETIRED – calculations
 * keep referencing the version they used, so existing quotes never change retroactively.
 */

function requireGlobal(actor: Actor, permission: Permission): void {
  if (!hasGlobalPermission(actor, permission)) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission });
  }
}

function parseRules(value: unknown): PriceRules {
  const parsed = priceRulesSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", "Invalid price rules", {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

const reasonSchema = z.string().trim().min(3).max(1000);

const createDraftInput = z.strictObject({
  serviceAreaId: z.uuid().nullable().optional(),
  rules: z.unknown().optional(),
  changeReason: reasonSchema,
});

export async function createPriceRuleSetDraft(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ id: string; version: number }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "pricing:manage");
  const data = parseInput(createDraftInput, input);
  const rules = data.rules === undefined ? emptyPriceRules() : parseRules(data.rules);
  return ctx.db.transaction(async (tx) => {
    if (data.serviceAreaId != null) {
      const [area] = await tx
        .select({ id: schema.serviceArea.id })
        .from(schema.serviceArea)
        .where(eq(schema.serviceArea.id, data.serviceAreaId))
        .limit(1);
      if (area === undefined) throw new DomainError("NOT_FOUND", "Service area not found");
    }
    // Serialise version allocation (unique index is the last line of defence).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('price_rule_set:version', 0))`,
    );
    const [last] = await tx
      .select({ version: max(schema.priceRuleSet.version) })
      .from(schema.priceRuleSet);
    const version = (last?.version ?? 0) + 1;
    const [row] = await tx
      .insert(schema.priceRuleSet)
      .values({
        version,
        serviceAreaId: data.serviceAreaId ?? null,
        rules,
        changeReason: data.changeReason,
        createdByUserId: actor.userId,
      })
      .returning({ id: schema.priceRuleSet.id });
    if (row === undefined) throw new DomainError("CONFLICT", "Rule set could not be created");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "pricing.rule_set_created",
      entityType: "price_rule_set",
      entityId: row.id,
      after: { version, serviceAreaId: data.serviceAreaId ?? null },
      correlationId: ctx.correlationId,
    });
    return { id: row.id, version };
  });
}

const updateDraftInput = z.strictObject({
  ruleSetId: z.uuid(),
  rules: z.unknown(),
  changeReason: reasonSchema,
});

export async function updatePriceRuleSetDraft(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "pricing:manage");
  const data = parseInput(updateDraftInput, input);
  const rules = parseRules(data.rules);
  await ctx.db.transaction(async (tx) => {
    const current = await lockRuleSet(tx, data.ruleSetId);
    if (current.status !== "DRAFT") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Only draft rule sets can be edited");
    }
    await tx
      .update(schema.priceRuleSet)
      .set({ rules, changeReason: data.changeReason, updatedAt: ctx.clock.now() })
      .where(eq(schema.priceRuleSet.id, current.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "pricing.rule_set_updated",
      entityType: "price_rule_set",
      entityId: current.id,
      after: { version: current.version, configRequired: listConfigRequired(rules).length },
      correlationId: ctx.correlationId,
    });
  });
}

type RuleSetRow = typeof schema.priceRuleSet.$inferSelect;

async function lockRuleSet(tx: Transaction, id: string): Promise<RuleSetRow> {
  const [row] = await tx
    .select()
    .from(schema.priceRuleSet)
    .where(eq(schema.priceRuleSet.id, id))
    .for("update")
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Rule set not found");
  return row;
}

/** Referenced services/extras must exist so that a rule set never prices unknown ids. */
async function assertReferencesExist(db: DbExecutor, rules: PriceRules): Promise<void> {
  const serviceIds = Object.keys(rules.services);
  if (serviceIds.length > 0) {
    const found = await db
      .select({ id: schema.service.id })
      .from(schema.service)
      .where(inArray(schema.service.id, serviceIds));
    if (found.length !== serviceIds.length) {
      throw new DomainError("VALIDATION_FAILED", "Rule set references unknown services");
    }
  }
  const extraIds = Object.keys(rules.extras);
  if (extraIds.length > 0) {
    const found = await db
      .select({ id: schema.serviceOption.id })
      .from(schema.serviceOption)
      .where(inArray(schema.serviceOption.id, extraIds));
    if (found.length !== extraIds.length) {
      throw new DomainError("VALIDATION_FAILED", "Rule set references unknown extras");
    }
  }
}

const activateInput = z.strictObject({ ruleSetId: z.uuid() });

/** Activates a draft and retires the previously active rule set of the same scope. */
export async function activatePriceRuleSet(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ version: number; retiredVersion: number | null; configRequired: string[] }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "pricing:approve");
  const { ruleSetId } = parseInput(activateInput, input);
  return ctx.db.transaction(async (tx) => {
    // One activation per scope at a time.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('price_rule_set:activate', 0))`,
    );
    const draft = await lockRuleSet(tx, ruleSetId);
    if (draft.status !== "DRAFT") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Only draft rule sets can be activated");
    }
    const rules = parseRules(draft.rules);
    await assertReferencesExist(tx, rules);
    const now = ctx.clock.now();
    const scope =
      draft.serviceAreaId === null
        ? isNull(schema.priceRuleSet.serviceAreaId)
        : eq(schema.priceRuleSet.serviceAreaId, draft.serviceAreaId);
    const retired = await tx
      .update(schema.priceRuleSet)
      .set({ status: "RETIRED", retiredAt: now, updatedAt: now })
      .where(and(eq(schema.priceRuleSet.status, "ACTIVE"), scope))
      .returning({ version: schema.priceRuleSet.version });
    await tx
      .update(schema.priceRuleSet)
      .set({ status: "ACTIVE", activatedAt: now, activatedByUserId: actor.userId, updatedAt: now })
      .where(and(eq(schema.priceRuleSet.id, draft.id), eq(schema.priceRuleSet.status, "DRAFT")));
    const configRequired = listConfigRequired(rules);
    const retiredVersion = retired[0]?.version ?? null;
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "pricing.rule_set_activated",
      entityType: "price_rule_set",
      entityId: draft.id,
      before: { activeVersion: retiredVersion },
      after: { version: draft.version, configRequired: configRequired.length },
      correlationId: ctx.correlationId,
    });
    return { version: draft.version, retiredVersion, configRequired };
  });
}

export interface ActiveRuleSet {
  readonly id: string;
  readonly version: number;
  readonly currency: string;
  readonly rules: PriceRules;
}

/**
 * Active rule set for a service area (regional rules first, then the default). Read primitive
 * for server-side services; callers authorise.
 */
export async function getActivePriceRuleSet(
  db: DbExecutor,
  serviceAreaId: string | null,
): Promise<ActiveRuleSet | null> {
  const r = schema.priceRuleSet;
  const rows = await db
    .select({
      id: r.id,
      version: r.version,
      currency: r.currency,
      rules: r.rules,
      area: r.serviceAreaId,
    })
    .from(r)
    .where(
      and(
        eq(r.status, "ACTIVE"),
        serviceAreaId === null
          ? isNull(r.serviceAreaId)
          : sql`(${r.serviceAreaId} = ${serviceAreaId} OR ${r.serviceAreaId} IS NULL)`,
      ),
    );
  const row = rows.find((x) => x.area !== null) ?? rows.find((x) => x.area === null);
  if (row === undefined) return null;
  return { id: row.id, version: row.version, currency: row.currency, rules: parseRules(row.rules) };
}

export interface PriceRuleSetSummary {
  readonly id: string;
  readonly version: number;
  readonly status: "DRAFT" | "ACTIVE" | "RETIRED";
  readonly serviceAreaId: string | null;
  readonly serviceAreaName: string | null;
  readonly changeReason: string;
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
  readonly configRequired: readonly string[];
}

export async function listPriceRuleSets(ctx: ServiceContext): Promise<PriceRuleSetSummary[]> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "pricing:read");
  const r = schema.priceRuleSet;
  const rows = await ctx.db
    .select({
      id: r.id,
      version: r.version,
      status: r.status,
      serviceAreaId: r.serviceAreaId,
      serviceAreaName: schema.serviceArea.name,
      changeReason: r.changeReason,
      createdAt: r.createdAt,
      activatedAt: r.activatedAt,
      rules: r.rules,
    })
    .from(r)
    .leftJoin(schema.serviceArea, eq(schema.serviceArea.id, r.serviceAreaId))
    .orderBy(desc(r.version))
    .limit(50);
  return rows.map(({ rules, ...row }) => ({
    ...row,
    configRequired: listConfigRequired(parseRules(rules)),
  }));
}

export async function getPriceRuleSet(
  ctx: ServiceContext,
  input: unknown,
): Promise<PriceRuleSetSummary & { rules: PriceRules }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "pricing:read");
  const { ruleSetId } = parseInput(activateInput, input);
  const r = schema.priceRuleSet;
  const [row] = await ctx.db
    .select({
      id: r.id,
      version: r.version,
      status: r.status,
      serviceAreaId: r.serviceAreaId,
      serviceAreaName: schema.serviceArea.name,
      changeReason: r.changeReason,
      createdAt: r.createdAt,
      activatedAt: r.activatedAt,
      rules: r.rules,
    })
    .from(r)
    .leftJoin(schema.serviceArea, eq(schema.serviceArea.id, r.serviceAreaId))
    .where(eq(r.id, ruleSetId))
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Rule set not found");
  const rules = parseRules(row.rules);
  return { ...row, rules, configRequired: listConfigRequired(rules) };
}
