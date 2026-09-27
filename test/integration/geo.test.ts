import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createServiceArea,
  findNearbyPartners,
  findServiceAreasForPoint,
  setServiceAreaActive,
} from "@isela/catalog";
import { addCustomerAddress, checkAddressServiceArea, registerCustomer } from "@isela/crm";
import { SEED_START_SERVICE_AREA, eq, schema } from "@isela/database";
import { expectDomainError } from "../support/assertions.ts";
import { TEST_CRM_CONFIG, contextForRole, openTestDatabase } from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

// Coordinates relative to the seeded start-market centre; the tests never refer to a city name.
const centre = {
  latitude: SEED_START_SERVICE_AREA.latitude,
  longitude: SEED_START_SERVICE_AREA.longitude,
};
const insideRadius = { latitude: centre.latitude + 0.1, longitude: centre.longitude }; // ≈ 11 km north
const outsideRadius = { latitude: centre.latitude + 0.45, longitude: centre.longitude }; // ≈ 50 km north

type Ctx = Awaited<ReturnType<typeof contextForRole>>;
let admin: Ctx;
let dispatcher: Ctx;
let startAreaId: string;

beforeAll(async () => {
  admin = await contextForRole(db, "ADMIN");
  dispatcher = await contextForRole(db, "DISPATCHER");
  const [area] = await db
    .select({ id: schema.serviceArea.id })
    .from(schema.serviceArea)
    .where(eq(schema.serviceArea.key, SEED_START_SERVICE_AREA.key));
  startAreaId = area?.id ?? "";
});

describe("service areas", () => {
  it("ignores inactive areas (the start market is seeded inactive)", async () => {
    expect(await findServiceAreasForPoint(db, insideRadius)).toEqual([]);
  });

  it("matches points inside an active circle and not outside of it", async () => {
    await setServiceAreaActive(admin, { serviceAreaId: startAreaId, active: true });
    expect((await findServiceAreasForPoint(db, insideRadius)).map((a) => a.key)).toEqual([
      SEED_START_SERVICE_AREA.key,
    ]);
    expect(await findServiceAreasForPoint(db, outsideRadius)).toEqual([]);
  });

  it("supports expansion by data: a larger circle and a polygon", async () => {
    const wideId = await createServiceArea(admin, {
      kind: "CIRCLE",
      key: "wide-circle",
      name: "Expansion 60 km",
      center: centre,
      radiusM: 60_000,
      priority: 200,
    });
    const polygonId = await createServiceArea(admin, {
      kind: "POLYGON",
      key: "expansion-region",
      name: "Expansion region",
      coordinates: [
        [
          [
            [centre.longitude - 1, centre.latitude + 0.3],
            [centre.longitude + 1, centre.latitude + 0.3],
            [centre.longitude + 1, centre.latitude + 1],
            [centre.longitude - 1, centre.latitude + 1],
            [centre.longitude - 1, centre.latitude + 0.3],
          ],
        ],
      ],
      priority: 300,
    });
    expect(await findServiceAreasForPoint(db, outsideRadius)).toEqual([]);
    await setServiceAreaActive(admin, { serviceAreaId: wideId, active: true });
    await setServiceAreaActive(admin, { serviceAreaId: polygonId, active: true });
    expect((await findServiceAreasForPoint(db, outsideRadius)).map((a) => a.key)).toEqual([
      "wide-circle",
      "expansion-region",
    ]);
    await setServiceAreaActive(admin, { serviceAreaId: wideId, active: false });
    await setServiceAreaActive(admin, { serviceAreaId: polygonId, active: false });
  });

  it("rejects invalid (self-intersecting) polygons", async () => {
    await expectDomainError(
      createServiceArea(admin, {
        kind: "POLYGON",
        key: "bow-tie",
        name: "Bow tie",
        coordinates: [
          [
            [
              [7, 51],
              [7.1, 51.1],
              [7.1, 51],
              [7, 51.1],
              [7, 51],
            ],
          ],
        ],
      }),
      "VALIDATION_FAILED",
    );
  });

  it("requires catalog:manage to change areas", async () => {
    await expectDomainError(
      setServiceAreaActive(dispatcher, { serviceAreaId: startAreaId, active: false }),
      "FORBIDDEN",
    );
  });
});

describe("address membership", () => {
  it("uses the geocoded point, and reports UNKNOWN without coordinates", async () => {
    const { customerId } = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Geo" },
      TEST_CRM_CONFIG,
    );
    const base = {
      customerId,
      addressType: "SERVICE",
      street: "Weg",
      houseNumber: "1",
      postalCode: "45879",
      city: "Beliebig",
    };
    const inside = await addCustomerAddress(
      dispatcher,
      { ...base, ...insideRadius },
      TEST_CRM_CONFIG,
    );
    const outside = await addCustomerAddress(
      dispatcher,
      { ...base, houseNumber: "2", ...outsideRadius },
      TEST_CRM_CONFIG,
    );
    const unknown = await addCustomerAddress(
      dispatcher,
      { ...base, houseNumber: "3" },
      TEST_CRM_CONFIG,
    );
    expect(await checkAddressServiceArea(dispatcher, { addressId: inside.addressId })).toBe(
      "IN_AREA",
    );
    expect(await checkAddressServiceArea(dispatcher, { addressId: outside.addressId })).toBe(
      "OUTSIDE",
    );
    // Same postal code and city as the inside address – still UNKNOWN: text never decides.
    expect(await checkAddressServiceArea(dispatcher, { addressId: unknown.addressId })).toBe(
      "UNKNOWN",
    );

    const otherCustomer = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Other" },
      TEST_CRM_CONFIG,
    );
    const foreign = await contextForRole(db, "CUSTOMER", { customerId: otherCustomer.customerId });
    await expectDomainError(
      checkAddressServiceArea(foreign, { addressId: inside.addressId }),
      "FORBIDDEN",
    );
  });
});

describe("partner proximity", () => {
  it("returns active partners in range whose own radius covers the point, nearest first", async () => {
    const partner = (
      name: string,
      lat: number,
      radius: number,
      status: "ACTIVE" | "PENDING_VERIFICATION" = "ACTIVE",
    ) => ({
      legalName: name,
      status,
      baseLatitude: lat,
      baseLongitude: centre.longitude,
      serviceRadiusM: radius,
    });
    await db
      .insert(schema.partner)
      .values([
        partner("Near Partner", centre.latitude + 0.02, 20_000),
        partner("Far Partner", centre.latitude + 0.2, 30_000),
        partner("Small Radius Partner", centre.latitude + 0.15, 5_000),
        partner("Unverified Partner", centre.latitude + 0.01, 50_000, "PENDING_VERIFICATION"),
      ]);
    const result = await findNearbyPartners(db, { point: centre, maxDistanceM: 40_000 });
    expect(result.map((p) => p.legalName)).toEqual(["Near Partner", "Far Partner"]);
    expect(result[0]?.distanceM).toBeGreaterThan(1_000);
    expect(result[0]?.distanceM).toBeLessThan(3_000);
  });
});
