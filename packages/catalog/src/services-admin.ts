import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  hasGlobalPermission,
  requireActor,
  type Permission,
  type ServiceContext,
} from "@isela/auth";
import { and, asc, eq, schema, type Transaction } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, trimmedText, z } from "@isela/validation";

/*
 * Service catalogue administration (day 5). Categories, services and options are data –
 * nothing is hard-coded in UI components. The catalogue holds no prices: pricing strategy
 * RULE_BASED refers to the versioned price rule sets (@isela/pricing).
 */

const SERVICE_UNITS = ["HOUR", "SQUARE_METER", "FLAT", "UNIT"] as const;
const DURATION_MODELS = ["MANUAL", "FIXED", "PER_UNIT"] as const;
const PRICING_STRATEGIES = ["MANUAL_QUOTE", "RULE_BASED"] as const;
const PROPERTY_TYPES = [
  "APARTMENT",
  "PRIVATE_HOME",
  "OFFICE",
  "PRACTICE",
  "STAIRWELL",
  "COMMERCIAL",
  "OTHER",
  "RETAIL",
  "GASTRONOMY",
  "GYM",
  "HOLIDAY_RENTAL",
  "PROPERTY_MANAGEMENT",
] as const;

const slug = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Key must be a lowercase slug");
const optionalText = z.string().trim().max(2000).optional();
const qualifications = z
  .array(
    z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(64),
  )
  .max(20)
  .transform((q) => [...new Set(q)].sort());

function requireGlobal(ctx: ServiceContext, permission: Permission) {
  const actor = requireActor(ctx.actor);
  if (!hasGlobalPermission(actor, permission)) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission });
  }
  return actor;
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return (cause?.code ?? (error as { code?: unknown } | undefined)?.code) === "23505";
}

const durationShape = {
  durationModel: z.enum(DURATION_MODELS),
  baseDurationMinutes: z.number().int().min(0).max(10_080).nullable(),
  durationPerUnitSeconds: z.number().int().min(1).max(86_400).nullable(),
};

function assertDuration(d: {
  durationModel: (typeof DURATION_MODELS)[number];
  baseDurationMinutes: number | null;
  durationPerUnitSeconds: number | null;
}): void {
  if (d.durationModel === "FIXED" && d.baseDurationMinutes === null) {
    throw new DomainError("VALIDATION_FAILED", "A fixed duration needs minutes");
  }
  if (d.durationModel === "PER_UNIT" && d.durationPerUnitSeconds === null) {
    throw new DomainError("VALIDATION_FAILED", "A per-unit duration needs seconds per unit");
  }
}

const createCategoryInput = z.strictObject({
  key: slug,
  name: trimmedText(200),
  description: optionalText,
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export async function createServiceCategory(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireGlobal(ctx, "catalog:manage");
  const data = parseInput(createCategoryInput, input);
  try {
    return await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.serviceCategory)
        .values({
          key: data.key,
          name: data.name,
          description: data.description === "" ? null : (data.description ?? null),
          sortOrder: data.sortOrder ?? 100,
        })
        .returning({ id: schema.serviceCategory.id });
      if (row === undefined) throw new DomainError("CONFLICT", "Category could not be created");
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "catalog.category_created",
        entityType: "service_category",
        entityId: row.id,
        after: { key: data.key },
        correlationId: ctx.correlationId,
      });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("CONFLICT", "Key already exists");
    throw error;
  }
}

const updateCategoryInput = z.strictObject({
  categoryId: z.uuid(),
  name: trimmedText(200).optional(),
  description: optionalText,
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export async function updateServiceCategory(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireGlobal(ctx, "catalog:manage");
  const { categoryId, ...patch } = parseInput(updateCategoryInput, input);
  const changedFields = Object.keys(patch);
  if (changedFields.length === 0) throw new DomainError("VALIDATION_FAILED", "Nothing to update");
  await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.serviceCategory)
      .set({
        ...patch,
        ...(patch.description === undefined
          ? {}
          : { description: patch.description === "" ? null : patch.description }),
        updatedAt: ctx.clock.now(),
      })
      .where(eq(schema.serviceCategory.id, categoryId))
      .returning({ id: schema.serviceCategory.id });
    if (updated.length === 0) throw new DomainError("NOT_FOUND", "Category not found");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "catalog.category_updated",
      entityType: "service_category",
      entityId: categoryId,
      after: { changedFields, ...(patch.active === undefined ? {} : { active: patch.active }) },
      correlationId: ctx.correlationId,
    });
  });
}

const createServiceInput = z.strictObject({
  categoryId: z.uuid(),
  key: slug,
  name: trimmedText(200),
  description: optionalText,
  unit: z.enum(SERVICE_UNITS),
  minQuantity: z.number().positive().max(1_000_000).nullable().optional(),
  ...durationShape,
  pricingStrategy: z.enum(PRICING_STRATEGIES),
  requiredQualifications: qualifications.optional(),
  supportedPropertyTypes: z.array(z.enum(PROPERTY_TYPES)).max(20).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

async function assertCategory(tx: Transaction, categoryId: string): Promise<void> {
  const [category] = await tx
    .select({ id: schema.serviceCategory.id })
    .from(schema.serviceCategory)
    .where(eq(schema.serviceCategory.id, categoryId))
    .limit(1);
  if (category === undefined) throw new DomainError("NOT_FOUND", "Category not found");
}

export async function createCatalogService(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireGlobal(ctx, "catalog:manage");
  const data = parseInput(createServiceInput, input);
  assertDuration(data);
  try {
    return await ctx.db.transaction(async (tx) => {
      await assertCategory(tx, data.categoryId);
      const [row] = await tx
        .insert(schema.service)
        .values({
          categoryId: data.categoryId,
          key: data.key,
          name: data.name,
          description: data.description === "" ? null : (data.description ?? null),
          unit: data.unit,
          minQuantity: data.minQuantity ?? null,
          durationModel: data.durationModel,
          baseDurationMinutes: data.baseDurationMinutes,
          durationPerUnitSeconds: data.durationPerUnitSeconds,
          pricingStrategy: data.pricingStrategy,
          requiredQualifications: data.requiredQualifications ?? [],
          supportedPropertyTypes: [...new Set(data.supportedPropertyTypes ?? [])],
          sortOrder: data.sortOrder ?? 100,
        })
        .returning({ id: schema.service.id });
      if (row === undefined) throw new DomainError("CONFLICT", "Service could not be created");
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "catalog.service_created",
        entityType: "service",
        entityId: row.id,
        after: {
          key: data.key,
          categoryId: data.categoryId,
          unit: data.unit,
          pricingStrategy: data.pricingStrategy,
        },
        correlationId: ctx.correlationId,
      });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("CONFLICT", "Key already exists");
    throw error;
  }
}

const updateServiceInput = z.strictObject({
  serviceId: z.uuid(),
  name: trimmedText(200).optional(),
  description: optionalText,
  active: z.boolean().optional(),
  minQuantity: z.number().positive().max(1_000_000).nullable().optional(),
  durationModel: durationShape.durationModel.optional(),
  baseDurationMinutes: durationShape.baseDurationMinutes.optional(),
  durationPerUnitSeconds: durationShape.durationPerUnitSeconds.optional(),
  pricingStrategy: z.enum(PRICING_STRATEGIES).optional(),
  requiredQualifications: qualifications.optional(),
  supportedPropertyTypes: z.array(z.enum(PROPERTY_TYPES)).max(20).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

/** Key, unit and category are immutable (quotes and rule sets reference them). */
export async function updateCatalogService(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireGlobal(ctx, "catalog:manage");
  const { serviceId, ...patch } = parseInput(updateServiceInput, input);
  const changedFields = Object.keys(patch);
  if (changedFields.length === 0) throw new DomainError("VALIDATION_FAILED", "Nothing to update");
  await ctx.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.service)
      .where(eq(schema.service.id, serviceId))
      .for("update")
      .limit(1);
    if (current === undefined) throw new DomainError("NOT_FOUND", "Service not found");
    const next = {
      durationModel: patch.durationModel ?? current.durationModel,
      baseDurationMinutes:
        patch.baseDurationMinutes === undefined
          ? current.baseDurationMinutes
          : patch.baseDurationMinutes,
      durationPerUnitSeconds:
        patch.durationPerUnitSeconds === undefined
          ? current.durationPerUnitSeconds
          : patch.durationPerUnitSeconds,
    };
    assertDuration(next);
    await tx
      .update(schema.service)
      .set({
        ...patch,
        ...(patch.description === undefined
          ? {}
          : { description: patch.description === "" ? null : patch.description }),
        ...(patch.supportedPropertyTypes === undefined
          ? {}
          : { supportedPropertyTypes: [...new Set(patch.supportedPropertyTypes)] }),
        updatedAt: ctx.clock.now(),
      })
      .where(eq(schema.service.id, serviceId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "catalog.service_updated",
      entityType: "service",
      entityId: serviceId,
      after: { changedFields, ...(patch.active === undefined ? {} : { active: patch.active }) },
      correlationId: ctx.correlationId,
    });
  });
}

const createOptionInput = z.strictObject({
  serviceId: z.uuid(),
  key: slug,
  name: trimmedText(200),
  description: optionalText,
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export async function createServiceOption(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireGlobal(ctx, "catalog:manage");
  const data = parseInput(createOptionInput, input);
  try {
    return await ctx.db.transaction(async (tx) => {
      const [service] = await tx
        .select({ id: schema.service.id })
        .from(schema.service)
        .where(eq(schema.service.id, data.serviceId))
        .limit(1);
      if (service === undefined) throw new DomainError("NOT_FOUND", "Service not found");
      const [row] = await tx
        .insert(schema.serviceOption)
        .values({
          serviceId: data.serviceId,
          key: data.key,
          name: data.name,
          description: data.description === "" ? null : (data.description ?? null),
          sortOrder: data.sortOrder ?? 100,
        })
        .returning({ id: schema.serviceOption.id });
      if (row === undefined) throw new DomainError("CONFLICT", "Option could not be created");
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "catalog.option_created",
        entityType: "service",
        entityId: data.serviceId,
        after: { optionId: row.id, key: data.key },
        correlationId: ctx.correlationId,
      });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("CONFLICT", "Key already exists");
    throw error;
  }
}

const optionActiveInput = z.strictObject({
  serviceId: z.uuid(),
  optionId: z.uuid(),
  active: z.boolean(),
});

export async function setServiceOptionActive(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireGlobal(ctx, "catalog:manage");
  const data = parseInput(optionActiveInput, input);
  await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.serviceOption)
      .set({ active: data.active, updatedAt: ctx.clock.now() })
      .where(
        and(
          eq(schema.serviceOption.id, data.optionId),
          eq(schema.serviceOption.serviceId, data.serviceId),
        ),
      )
      .returning({ id: schema.serviceOption.id });
    if (updated.length === 0) throw new DomainError("NOT_FOUND", "Option not found");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "catalog.option_updated",
      entityType: "service",
      entityId: data.serviceId,
      after: { optionId: data.optionId, active: data.active },
      correlationId: ctx.correlationId,
    });
  });
}

export interface CatalogServiceView {
  readonly id: string;
  readonly categoryId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly unit: (typeof SERVICE_UNITS)[number];
  readonly active: boolean;
  readonly sortOrder: number;
  readonly minQuantity: number | null;
  readonly durationModel: (typeof DURATION_MODELS)[number];
  readonly baseDurationMinutes: number | null;
  readonly durationPerUnitSeconds: number | null;
  readonly pricingStrategy: (typeof PRICING_STRATEGIES)[number];
  readonly requiredQualifications: readonly string[];
  readonly supportedPropertyTypes: readonly (typeof PROPERTY_TYPES)[number][];
  readonly options: readonly {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly active: boolean;
  }[];
}

export interface CatalogAdminView {
  readonly categories: readonly {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
    readonly active: boolean;
    readonly sortOrder: number;
    readonly services: readonly CatalogServiceView[];
  }[];
}

/** Full catalogue incl. inactive entries for the back office (GLOBAL catalog:read). */
export async function getCatalogAdmin(ctx: ServiceContext): Promise<CatalogAdminView> {
  requireGlobal(ctx, "catalog:read");
  const [categories, services, options] = await Promise.all([
    ctx.db
      .select({
        id: schema.serviceCategory.id,
        key: schema.serviceCategory.key,
        name: schema.serviceCategory.name,
        description: schema.serviceCategory.description,
        active: schema.serviceCategory.active,
        sortOrder: schema.serviceCategory.sortOrder,
      })
      .from(schema.serviceCategory)
      .orderBy(asc(schema.serviceCategory.sortOrder), asc(schema.serviceCategory.key)),
    ctx.db
      .select({
        id: schema.service.id,
        categoryId: schema.service.categoryId,
        key: schema.service.key,
        name: schema.service.name,
        description: schema.service.description,
        unit: schema.service.unit,
        active: schema.service.active,
        sortOrder: schema.service.sortOrder,
        minQuantity: schema.service.minQuantity,
        durationModel: schema.service.durationModel,
        baseDurationMinutes: schema.service.baseDurationMinutes,
        durationPerUnitSeconds: schema.service.durationPerUnitSeconds,
        pricingStrategy: schema.service.pricingStrategy,
        requiredQualifications: schema.service.requiredQualifications,
        supportedPropertyTypes: schema.service.supportedPropertyTypes,
      })
      .from(schema.service)
      .orderBy(asc(schema.service.sortOrder), asc(schema.service.name)),
    ctx.db
      .select({
        id: schema.serviceOption.id,
        serviceId: schema.serviceOption.serviceId,
        key: schema.serviceOption.key,
        name: schema.serviceOption.name,
        active: schema.serviceOption.active,
      })
      .from(schema.serviceOption)
      .orderBy(asc(schema.serviceOption.sortOrder), asc(schema.serviceOption.name)),
  ]);
  return {
    categories: categories.map((c) => ({
      ...c,
      services: services
        .filter((s) => s.categoryId === c.id)
        .map((s) => ({
          ...s,
          options: options
            .filter((o) => o.serviceId === s.id)
            .map((o) => ({ id: o.id, key: o.key, name: o.name, active: o.active })),
        })),
    })),
  };
}
