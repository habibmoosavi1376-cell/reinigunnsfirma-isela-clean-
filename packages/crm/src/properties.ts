import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  authorize,
  hasGlobalPermission,
  requireActor,
  type ServiceContext,
} from "@isela/auth";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNull,
  or,
  schema,
  type SQL,
  type Transaction,
} from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, trimmedText, z } from "@isela/validation";

/*
 * Property register: many properties per customer (e.g. property management with dozens of
 * buildings at different addresses and intervals, billed centrally to the customer). A
 * property always references an address of the SAME customer (service check + DB trigger).
 */

export const PROPERTY_TYPES = [
  "PRIVATE_HOME",
  "APARTMENT",
  "OFFICE",
  "PRACTICE",
  "STAIRWELL",
  "RETAIL",
  "GASTRONOMY",
  "GYM",
  "HOLIDAY_RENTAL",
  "COMMERCIAL",
  "PROPERTY_MANAGEMENT",
  "OTHER",
] as const;

export const PROPERTY_FREQUENCIES = ["ONCE", "WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM"] as const;

const optionalText = (max: number) => z.string().trim().max(max).optional();

const propertyFields = {
  name: trimmedText(200),
  propertyType: z.enum(PROPERTY_TYPES),
  areaSqm: z.number().positive().max(1_000_000).optional(),
  rooms: z.number().int().min(0).max(10_000).optional(),
  bathrooms: z.number().int().min(0).max(10_000).optional(),
  serviceFrequency: z.enum(PROPERTY_FREQUENCIES).optional(),
  serviceRequirements: optionalText(2000),
  notes: optionalText(2000),
};

const createPropertyInput = z.strictObject({
  customerId: z.uuid(),
  addressId: z.uuid(),
  ...propertyFields,
});

async function assertAddressOfCustomer(
  tx: Transaction,
  customerId: string,
  addressId: string,
): Promise<void> {
  const [address] = await tx
    .select({ id: schema.customerAddress.id })
    .from(schema.customerAddress)
    .where(
      and(
        eq(schema.customerAddress.id, addressId),
        eq(schema.customerAddress.customerId, customerId),
        isNull(schema.customerAddress.archivedAt),
      ),
    )
    .limit(1);
  if (address === undefined) {
    throw new DomainError("NOT_FOUND", "Address not found for this customer");
  }
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

export async function createProperty(ctx: ServiceContext, input: unknown): Promise<string> {
  const data = parseInput(createPropertyInput, input);
  const actor = requireActor(ctx.actor);
  authorize(actor, "property:write", { customerId: data.customerId });

  return ctx.db.transaction(async (tx) => {
    // The address must belong to the same customer (also enforced by a DB trigger).
    await assertAddressOfCustomer(tx, data.customerId, data.addressId);
    const [row] = await tx
      .insert(schema.property)
      .values({
        customerId: data.customerId,
        addressId: data.addressId,
        name: data.name,
        propertyType: data.propertyType,
        areaSqm: data.areaSqm ?? null,
        rooms: data.rooms ?? null,
        bathrooms: data.bathrooms ?? null,
        serviceFrequency: data.serviceFrequency ?? null,
        serviceRequirements: emptyToNull(data.serviceRequirements),
        notes: emptyToNull(data.notes),
      })
      .returning({ id: schema.property.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Property could not be created");
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "property.created",
      entityType: "property",
      entityId: row.id,
      after: {
        customerId: data.customerId,
        addressId: data.addressId,
        propertyType: data.propertyType,
      },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const updatePropertyInput = z.strictObject({
  propertyId: z.uuid(),
  addressId: z.uuid().optional(),
  name: trimmedText(200).optional(),
  propertyType: z.enum(PROPERTY_TYPES).optional(),
  areaSqm: z.number().positive().max(1_000_000).nullable().optional(),
  rooms: z.number().int().min(0).max(10_000).nullable().optional(),
  bathrooms: z.number().int().min(0).max(10_000).nullable().optional(),
  serviceFrequency: z.enum(PROPERTY_FREQUENCIES).nullable().optional(),
  serviceRequirements: optionalText(2000),
  notes: optionalText(2000),
  active: z.boolean().optional(),
});

/** Updates a property. The customer (owner) is derived from the property, never from input. */
export async function updateProperty(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  const data = parseInput(updatePropertyInput, input);
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.property)
      .where(and(eq(schema.property.id, data.propertyId), isNull(schema.property.archivedAt)))
      .for("update")
      .limit(1);
    if (before === undefined) {
      throw new DomainError("NOT_FOUND", "Property not found");
    }
    authorize(actor, "property:write", { customerId: before.customerId });
    if (data.addressId !== undefined && data.addressId !== before.addressId) {
      await assertAddressOfCustomer(tx, before.customerId, data.addressId);
    }
    const patch: Partial<typeof schema.property.$inferInsert> = {};
    if (data.addressId !== undefined) patch.addressId = data.addressId;
    if (data.name !== undefined) patch.name = data.name;
    if (data.propertyType !== undefined) patch.propertyType = data.propertyType;
    if (data.areaSqm !== undefined) patch.areaSqm = data.areaSqm;
    if (data.rooms !== undefined) patch.rooms = data.rooms;
    if (data.bathrooms !== undefined) patch.bathrooms = data.bathrooms;
    if (data.serviceFrequency !== undefined) patch.serviceFrequency = data.serviceFrequency;
    if (data.serviceRequirements !== undefined) {
      patch.serviceRequirements = emptyToNull(data.serviceRequirements);
    }
    if (data.notes !== undefined) patch.notes = emptyToNull(data.notes);
    if (data.active !== undefined) patch.active = data.active;
    const changed = Object.keys(patch).filter(
      (key) => patch[key as keyof typeof patch] !== before[key as keyof typeof before],
    );
    if (changed.length === 0) {
      throw new DomainError("VALIDATION_FAILED", "Nothing to update");
    }
    await tx
      .update(schema.property)
      .set({ ...patch, updatedAt: ctx.clock.now() })
      .where(eq(schema.property.id, data.propertyId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "property.updated",
      entityType: "property",
      entityId: data.propertyId,
      // Field names only (free-text notes may contain personal data).
      after: { customerId: before.customerId, changedFields: changed, active: patch.active },
      correlationId: ctx.correlationId,
    });
  });
}

export interface PropertyView {
  readonly id: string;
  readonly addressId: string;
  readonly name: string;
  readonly propertyType: string;
  readonly areaSqm: number | null;
  readonly rooms: number | null;
  readonly bathrooms: number | null;
  readonly serviceFrequency: string | null;
  readonly serviceRequirements: string | null;
  readonly notes: string | null;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const listInput = z.strictObject({ customerId: z.uuid() });

export async function listProperties(ctx: ServiceContext, input: unknown): Promise<PropertyView[]> {
  const { customerId } = parseInput(listInput, input);
  authorize(ctx.actor, "property:read", { customerId });
  const p = schema.property;
  return ctx.db
    .select({
      id: p.id,
      addressId: p.addressId,
      name: p.name,
      propertyType: p.propertyType,
      areaSqm: p.areaSqm,
      rooms: p.rooms,
      bathrooms: p.bathrooms,
      serviceFrequency: p.serviceFrequency,
      serviceRequirements: p.serviceRequirements,
      notes: p.notes,
      active: p.active,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })
    .from(p)
    .where(and(eq(p.customerId, customerId), isNull(p.archivedAt)))
    .orderBy(asc(p.createdAt));
}

/** Escapes LIKE wildcards so user search text is matched literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const propertySearchSchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  propertyType: z.enum(PROPERTY_TYPES).optional(),
  active: z.enum(["true", "false"]).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export interface PropertySearchItem {
  readonly id: string;
  readonly name: string;
  readonly propertyType: string;
  readonly active: boolean;
  readonly customerId: string;
  readonly customerName: string;
  readonly postalCode: string;
  readonly city: string;
  readonly serviceFrequency: string | null;
}

/** Staff-wide property search (requires GLOBAL property:read). */
export async function searchProperties(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ items: PropertySearchItem[]; total: number; page: number; pageSize: number }> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "property:read");
  if (!hasGlobalPermission(actor, "property:read")) {
    throw new DomainError("FORBIDDEN", "Not allowed");
  }
  const f = parseInput(propertySearchSchema, input ?? {});
  const p = schema.property;
  const c = schema.customer;
  const a = schema.customerAddress;
  const conditions: SQL[] = [isNull(p.archivedAt)];
  if (f.propertyType !== undefined) conditions.push(eq(p.propertyType, f.propertyType));
  if (f.active !== undefined) conditions.push(eq(p.active, f.active === "true"));
  if (f.q !== undefined) {
    const pattern = likePattern(f.q);
    const search = or(
      ilike(p.name, pattern),
      ilike(c.displayName, pattern),
      ilike(c.companyName, pattern),
      ilike(a.street, pattern),
      ilike(a.city, pattern),
      ilike(a.postalCode, pattern),
    );
    if (search !== undefined) conditions.push(search);
  }
  const where = and(...conditions);
  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(p)
    .innerJoin(c, eq(c.id, p.customerId))
    .innerJoin(a, eq(a.id, p.addressId))
    .where(where);
  const items = await ctx.db
    .select({
      id: p.id,
      name: p.name,
      propertyType: p.propertyType,
      active: p.active,
      customerId: c.id,
      customerName: c.displayName,
      postalCode: a.postalCode,
      city: a.city,
      serviceFrequency: p.serviceFrequency,
    })
    .from(p)
    .innerJoin(c, eq(c.id, p.customerId))
    .innerJoin(a, eq(a.id, p.addressId))
    .where(where)
    .orderBy(desc(p.createdAt), desc(p.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items, total: totalRow?.total ?? 0, page: f.page, pageSize: f.pageSize };
}
