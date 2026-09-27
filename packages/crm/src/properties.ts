import { recordAudit } from "@isela/audit";
import { auditActorOf, authorize, requireActor, type ServiceContext } from "@isela/auth";
import { and, asc, eq, isNull, schema } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, trimmedText, z } from "@isela/validation";

const createPropertyInput = z.strictObject({
  customerId: z.uuid(),
  addressId: z.uuid(),
  name: trimmedText(200),
  propertyType: z.enum([
    "APARTMENT",
    "HOUSE",
    "OFFICE",
    "PRACTICE",
    "STAIRWELL",
    "COMMERCIAL",
    "OTHER",
  ]),
  areaSqm: z.number().positive().max(1_000_000).optional(),
});

export async function createProperty(ctx: ServiceContext, input: unknown): Promise<string> {
  const data = parseInput(createPropertyInput, input);
  const actor = requireActor(ctx.actor);
  authorize(actor, "property:write", { customerId: data.customerId });

  return ctx.db.transaction(async (tx) => {
    // The address must belong to the same customer (also enforced by a DB trigger).
    const [address] = await tx
      .select({ id: schema.customerAddress.id })
      .from(schema.customerAddress)
      .where(
        and(
          eq(schema.customerAddress.id, data.addressId),
          eq(schema.customerAddress.customerId, data.customerId),
          isNull(schema.customerAddress.archivedAt),
        ),
      )
      .limit(1);
    if (address === undefined) {
      throw new DomainError("NOT_FOUND", "Address not found for this customer");
    }
    const [row] = await tx
      .insert(schema.property)
      .values({
        customerId: data.customerId,
        addressId: data.addressId,
        name: data.name,
        propertyType: data.propertyType,
        areaSqm: data.areaSqm ?? null,
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

export interface PropertyView {
  readonly id: string;
  readonly addressId: string;
  readonly name: string;
  readonly propertyType: string;
  readonly areaSqm: number | null;
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
    })
    .from(p)
    .where(and(eq(p.customerId, customerId), isNull(p.archivedAt)))
    .orderBy(asc(p.createdAt));
}
