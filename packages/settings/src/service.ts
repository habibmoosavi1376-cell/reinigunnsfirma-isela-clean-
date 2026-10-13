import { recordAudit } from "@isela/audit";
import { auditActorOf, authorize, requireActor, type ServiceContext } from "@isela/auth";
import { and, desc, eq, gt, isNull, lte, or, schema, sql, type DbExecutor } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import {
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  type SettingKey,
  type SettingScopeType,
  type SettingValue,
} from "./registry.ts";

export interface SettingScope {
  readonly scopeType: SettingScopeType;
  readonly scopeId: string | null;
}

export const GLOBAL_SCOPE: SettingScope = { scopeType: "GLOBAL", scopeId: null };

export interface EffectiveSetting<K extends SettingKey> {
  readonly key: K;
  readonly value: SettingValue<K>;
  readonly version: number | null;
  readonly source: "STORED" | "DEFAULT";
}

function scopeCondition(scope: SettingScope) {
  return and(
    eq(schema.setting.scopeType, scope.scopeType),
    scope.scopeId === null
      ? isNull(schema.setting.scopeId)
      : eq(schema.setting.scopeId, scope.scopeId),
  );
}

/**
 * Returns the setting value effective at `at`, falling back to the registered default.
 * Stored values are re-validated; an invalid stored value is a configuration error and is
 * never silently used.
 */
export async function getEffectiveSetting<K extends SettingKey>(
  db: DbExecutor,
  key: K,
  scope: SettingScope,
  at: Date,
): Promise<EffectiveSetting<K>> {
  const definition = SETTING_DEFINITIONS[key];
  const [row] = await db
    .select({ value: schema.setting.value, version: schema.setting.version })
    .from(schema.setting)
    .where(
      and(
        eq(schema.setting.key, key),
        scopeCondition(scope),
        lte(schema.setting.effectiveFrom, at),
        or(isNull(schema.setting.effectiveUntil), gt(schema.setting.effectiveUntil, at)),
      ),
    )
    .orderBy(desc(schema.setting.version))
    .limit(1);
  if (row === undefined) {
    return {
      key,
      value: definition.defaultValue as SettingValue<K>,
      version: null,
      source: "DEFAULT",
    };
  }
  const parsed = definition.schema.safeParse(row.value);
  if (!parsed.success) {
    throw new DomainError("CONFIGURATION_ERROR", "Stored setting value is invalid", {
      key,
      version: row.version,
    });
  }
  return { key, value: parsed.data as SettingValue<K>, version: row.version, source: "STORED" };
}

const updateSettingInput = z.strictObject({
  key: z.enum(SETTING_KEYS),
  scopeType: z.enum(["GLOBAL", "SERVICE_AREA", "CUSTOMER"]),
  scopeId: z.uuid().nullable().default(null),
  value: z.unknown(),
  effectiveFrom: z.coerce.date().optional(),
  changeReason: z.string().trim().min(3).max(500),
});

/**
 * Creates a new version of a setting. The current open-ended version is closed at the new
 * version's start; versions are never overwritten. Retroactive changes are rejected.
 */
export async function updateSetting(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ version: number; effectiveFrom: Date }> {
  const actor = requireActor(ctx.actor);
  const data = parseInput(updateSettingInput, input);
  const definition = SETTING_DEFINITIONS[data.key];
  authorize(actor, definition.permission);

  if (!definition.scopes.includes(data.scopeType)) {
    throw new DomainError("VALIDATION_FAILED", "Scope not allowed for this setting", {
      key: data.key,
      scopeType: data.scopeType,
    });
  }
  const scope: SettingScope = { scopeType: data.scopeType, scopeId: data.scopeId };
  if ((scope.scopeType === "GLOBAL") !== (scope.scopeId === null)) {
    throw new DomainError("VALIDATION_FAILED", "scopeId must be set exactly for non-global scopes");
  }

  const value: unknown = parseInput(definition.schema, data.value);
  const now = ctx.clock.now();
  const effectiveFrom = data.effectiveFrom ?? now;
  if (effectiveFrom.getTime() < now.getTime() - 60_000) {
    throw new DomainError("VALIDATION_FAILED", "Settings cannot be changed retroactively");
  }

  return ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`setting:${data.key}:${scope.scopeType}:${scope.scopeId ?? ""}`}))`,
    );
    const [latest] = await tx
      .select()
      .from(schema.setting)
      .where(and(eq(schema.setting.key, data.key), scopeCondition(scope)))
      .orderBy(desc(schema.setting.version))
      .limit(1);

    if (latest !== undefined) {
      if (effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
        throw new DomainError("CONFLICT", "A newer or simultaneous version already exists", {
          key: data.key,
        });
      }
      await tx
        .update(schema.setting)
        .set({ effectiveUntil: effectiveFrom, updatedByUserId: actor.userId, updatedAt: now })
        .where(eq(schema.setting.id, latest.id));
    }

    const version = (latest?.version ?? 0) + 1;
    const [inserted] = await tx
      .insert(schema.setting)
      .values({
        key: data.key,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        version,
        value,
        effectiveFrom,
        changeReason: data.changeReason,
        createdByUserId: actor.userId,
      })
      .returning({ id: schema.setting.id });
    if (inserted === undefined) {
      throw new DomainError("CONFLICT", "Setting version could not be stored");
    }

    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "setting.version_created",
      entityType: "setting",
      entityId: inserted.id,
      before: latest === undefined ? undefined : { version: latest.version, value: latest.value },
      after: { key: data.key, version, value, effectiveFrom, changeReason: data.changeReason },
      correlationId: ctx.correlationId,
    });
    return { version, effectiveFrom };
  });
}
