import { and, eq, isNull, schema, sql, type DbExecutor, type SQL } from "@isela/database";
import { latitudeSchema, longitudeSchema, parseInput, z } from "@isela/validation";

export const geoPointSchema = z.strictObject({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});

export type GeoPoint = z.infer<typeof geoPointSchema>;

/** SQL expression for a WGS84 geography point. Values are bound parameters. */
export function geographyPointSql(point: GeoPoint): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${point.longitude}::double precision, ${point.latitude}::double precision), 4326)::geography`;
}

export interface MatchingServiceArea {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly priority: number;
}

/**
 * Generic service-area lookup: all ACTIVE areas containing the point, ordered by priority.
 * Works identically for any city, radius or polygon – there are no location special cases.
 * Read-only query primitive; callers are responsible for authorization.
 */
export async function findServiceAreasForPoint(
  db: DbExecutor,
  input: GeoPoint,
): Promise<MatchingServiceArea[]> {
  const point = parseInput(geoPointSchema, input);
  const p = geographyPointSql(point);
  const area = schema.serviceArea;
  return db
    .select({ id: area.id, key: area.key, name: area.name, priority: area.priority })
    .from(area)
    .where(
      and(
        eq(area.active, true),
        sql`(
          (${area.kind} = 'CIRCLE' AND ST_DWithin(${area.center}, ${p}, ${area.radiusM})) OR
          (${area.kind} = 'POLYGON' AND ST_Covers(${area.boundary}, ${p}))
        )`,
      ),
    )
    .orderBy(area.priority, area.key);
}

export type ServiceAreaMembership = "IN_AREA" | "OUTSIDE" | "UNKNOWN";

/**
 * Checks an address against active service areas using its geocoded point. Addresses
 * without coordinates are UNKNOWN – postal code or city name are never used as a substitute.
 */
export async function isAddressInServiceArea(
  db: DbExecutor,
  addressId: string,
): Promise<ServiceAreaMembership> {
  const address = schema.customerAddress;
  const area = schema.serviceArea;
  const [row] = await db
    .select({
      hasLocation: sql<boolean>`${address.location} IS NOT NULL`,
      inArea: sql<boolean>`EXISTS (
        SELECT 1 FROM ${area}
        WHERE ${area.active} = true AND (
          (${area.kind} = 'CIRCLE' AND ST_DWithin(${area.center}, ${address.location}, ${area.radiusM})) OR
          (${area.kind} = 'POLYGON' AND ST_Covers(${area.boundary}, ${address.location}))
        )
      )`,
    })
    .from(address)
    .where(and(eq(address.id, addressId), isNull(address.archivedAt)))
    .limit(1);
  if (row === undefined || !row.hasLocation) {
    return "UNKNOWN";
  }
  return row.inArea ? "IN_AREA" : "OUTSIDE";
}

export interface NearbyPartner {
  readonly id: string;
  readonly legalName: string;
  readonly distanceM: number;
}

const nearbyInput = z.strictObject({
  point: geoPointSchema,
  maxDistanceM: z.number().int().min(1).max(300_000),
});

/**
 * Active partners whose base is within `maxDistanceM` of the point AND whose own service
 * radius covers the point, nearest first.
 */
export async function findNearbyPartners(
  db: DbExecutor,
  input: { point: GeoPoint; maxDistanceM: number },
): Promise<NearbyPartner[]> {
  const { point, maxDistanceM } = parseInput(nearbyInput, input);
  const p = geographyPointSql(point);
  const partner = schema.partner;
  const rows = await db
    .select({
      id: partner.id,
      legalName: partner.legalName,
      // float8 is parsed to a JS number by node-postgres.
      distanceM: sql<number>`ST_Distance(${partner.baseLocation}, ${p})::double precision`,
    })
    .from(partner)
    .where(
      and(
        eq(partner.status, "ACTIVE"),
        isNull(partner.archivedAt),
        sql`ST_DWithin(${partner.baseLocation}, ${p}, LEAST(${maxDistanceM}::double precision, ${partner.serviceRadiusM}::double precision))`,
      ),
    )
    .orderBy(sql`ST_Distance(${partner.baseLocation}, ${p})`);
  return rows;
}
