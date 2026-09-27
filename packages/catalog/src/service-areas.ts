import { recordAudit } from "@isela/audit";
import { auditActorOf, authorize, requireActor, type ServiceContext } from "@isela/auth";
import { eq, schema, sql } from "@isela/database";
import { DomainError } from "@isela/shared";
import { latitudeSchema, longitudeSchema, parseInput, z } from "@isela/validation";
import { geoPointSchema, geographyPointSql } from "./geo.ts";

const position = z.tuple([longitudeSchema, latitudeSchema]);
const linearRing = z
  .array(position)
  .min(4)
  .refine((ring) => {
    const first = ring[0];
    const last = ring[ring.length - 1];
    return (
      first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
    );
  }, "Linear ring must be closed");

const keySchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Key must be a lowercase slug");

/** Service areas are data: a circle (centre + radius) or a GeoJSON MultiPolygon. */
export const serviceAreaInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("CIRCLE"),
    key: keySchema,
    name: z.string().trim().min(1).max(200),
    center: geoPointSchema,
    radiusM: z.number().int().min(1).max(1_000_000),
    priority: z.number().int().min(0).max(10_000).default(100),
  }),
  z.strictObject({
    kind: z.literal("POLYGON"),
    key: keySchema,
    name: z.string().trim().min(1).max(200),
    /** GeoJSON MultiPolygon coordinates: polygons → rings → [lng, lat]. */
    coordinates: z.array(z.array(linearRing).min(1)).min(1).max(500),
    priority: z.number().int().min(0).max(10_000).default(100),
  }),
]);

export type ServiceAreaInput = z.input<typeof serviceAreaInputSchema>;

/** Creates a service area (inactive). Activation is a separate, audited step. */
export async function createServiceArea(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "catalog:manage");
  const data = parseInput(serviceAreaInputSchema, input);

  return ctx.db.transaction(async (tx) => {
    let shape: {
      center: ReturnType<typeof sql> | null;
      radiusM: number | null;
      boundary: ReturnType<typeof sql> | null;
    };
    if (data.kind === "CIRCLE") {
      shape = { center: geographyPointSql(data.center), radiusM: data.radiusM, boundary: null };
    } else {
      const geoJson = JSON.stringify({ type: "MultiPolygon", coordinates: data.coordinates });
      const [validity] = await tx
        .execute<{ valid: boolean }>(
          sql`SELECT ST_IsValid(ST_GeomFromGeoJSON(${geoJson})) AS valid`,
        )
        .then((r) => r.rows);
      if (validity?.valid !== true) {
        throw new DomainError("VALIDATION_FAILED", "Polygon geometry is not valid");
      }
      shape = {
        center: null,
        radiusM: null,
        boundary: sql`ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geoJson}), 4326))::geography`,
      };
    }

    const [row] = await tx
      .insert(schema.serviceArea)
      .values({
        key: data.key,
        name: data.name,
        kind: data.kind,
        priority: data.priority,
        active: false,
        center: shape.center ?? null,
        radiusM: shape.radiusM,
        boundary: shape.boundary ?? null,
      })
      .returning({ id: schema.serviceArea.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Service area could not be created");
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "service_area.created",
      entityType: "service_area",
      entityId: row.id,
      after: { key: data.key, kind: data.kind, active: false },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const activationInput = z.strictObject({ serviceAreaId: z.uuid(), active: z.boolean() });

export async function setServiceAreaActive(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "catalog:manage");
  const { serviceAreaId, active } = parseInput(activationInput, input);
  await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.serviceArea)
      .set({ active, updatedAt: ctx.clock.now() })
      .where(eq(schema.serviceArea.id, serviceAreaId))
      .returning({ id: schema.serviceArea.id });
    if (updated.length === 0) {
      throw new DomainError("NOT_FOUND", "Service area not found");
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: active ? "service_area.activated" : "service_area.deactivated",
      entityType: "service_area",
      entityId: serviceAreaId,
      after: { active },
      correlationId: ctx.correlationId,
    });
  });
}
