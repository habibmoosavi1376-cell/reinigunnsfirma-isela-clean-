import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkServiceAvailability,
  createServiceArea,
  findServiceAreasForPoint,
  setServiceAreaActive,
} from "@isela/catalog";
import {
  correctRequestAddress,
  registerCustomer,
  rerunRequestGeocoding,
  reviewGeocodingCandidate,
  submitServiceRequest,
  type GeocodingDeps,
} from "@isela/crm";
import { and, desc, eq, schema, sql } from "@isela/database";
import type { GeocodeCandidate, GeocodeResult, GeocodingProvider } from "@isela/geocoding";
import { systemClock } from "@isela/shared";
import { expectDomainError } from "../support/assertions.ts";
import {
  TEST_CRM_CONFIG,
  contextForRole,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";

/*
 * Address pipeline with a TEST-ONLY geocoding double (production code has no fake provider).
 * Coordinates are far away from any seeded area so that the tests are independent.
 */

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

const ORIGIN = { latitude: -45, longitude: 170 };
const insideCircle = { latitude: -45.01, longitude: 170 }; // ≈ 1.1 km south
const outsideAll = { latitude: -45.6, longitude: 170.9 };
const insidePolygon = { latitude: -45.15, longitude: 170.25 };

/** Programmable provider double: returns the next queued result. */
class TestGeocoder implements GeocodingProvider {
  readonly id = `test-geocoder-${randomUUID().slice(0, 8)}`;
  readonly queue: (GeocodeResult | Error)[] = [];
  calls = 0;
  geocode(): Promise<GeocodeResult> {
    this.calls += 1;
    const next = this.queue.shift();
    if (next === undefined) return Promise.resolve({ status: "NO_MATCH", provider: this.id });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
  match(point: { latitude: number; longitude: number }, overrides: Partial<GeocodeCandidate> = {}) {
    this.queue.push({
      status: "MATCHED",
      provider: this.id,
      candidate: {
        street: "Teststraße",
        houseNumber: "7",
        postalCode: "12345",
        city: "Teststadt",
        region: "Testregion",
        country: "DE",
        precision: "BUILDING",
        confidence: 0.99,
        ...point,
        ...overrides,
      },
    });
  }
}

let admin: Awaited<ReturnType<typeof contextForRole>>;
let circleId: string;
let polygonId: string;
let wideId: string;
let inactiveId: string;

beforeAll(async () => {
  admin = await contextForRole(db, "ADMIN");
  circleId = await createServiceArea(admin, {
    kind: "CIRCLE",
    key: `t3-circle-${randomUUID().slice(0, 6)}`,
    name: "Testgebiet Kreis",
    center: ORIGIN,
    radiusM: 5000,
    priority: 10,
  });
  wideId = await createServiceArea(admin, {
    kind: "CIRCLE",
    key: `t3-wide-${randomUUID().slice(0, 6)}`,
    name: "Testgebiet weit",
    center: ORIGIN,
    radiusM: 40_000,
    priority: 50,
  });
  polygonId = await createServiceArea(admin, {
    kind: "POLYGON",
    key: `t3-poly-${randomUUID().slice(0, 6)}`,
    name: "Testgebiet Polygon",
    coordinates: [
      [
        [
          [170.2, -45.2],
          [170.3, -45.2],
          [170.3, -45.1],
          [170.2, -45.1],
          [170.2, -45.2],
        ],
      ],
    ],
    priority: 5,
  });
  inactiveId = await createServiceArea(admin, {
    kind: "CIRCLE",
    key: `t3-inactive-${randomUUID().slice(0, 6)}`,
    name: "Testgebiet inaktiv",
    center: outsideAll,
    radiusM: 5000,
    priority: 1,
  });
  for (const id of [circleId, wideId, polygonId]) {
    await setServiceAreaActive(admin, { serviceAreaId: id, active: true });
  }
});

describe("service availability (generic PostGIS lookup)", () => {
  it("returns AVAILABLE inside a circle, choosing the highest-priority area", async () => {
    const result = await checkServiceAvailability(db, insideCircle);
    expect(result.status).toBe("AVAILABLE");
    expect(result.serviceArea?.id).toBe(circleId);
    expect(result.matchingAreaCount).toBe(2);
  });

  it("returns AVAILABLE inside a polygon", async () => {
    const result = await checkServiceAvailability(db, insidePolygon);
    expect(result.serviceArea?.id).toBe(polygonId);
  });

  it("falls back to the next area outside the small circle", async () => {
    const result = await checkServiceAvailability(db, { latitude: -45.2, longitude: 170 }); // ≈ 22 km
    expect(result.serviceArea?.id).toBe(wideId);
  });

  it("returns NOT_AVAILABLE outside all areas and ignores inactive areas", async () => {
    expect((await checkServiceAvailability(db, outsideAll)).status).toBe("NOT_AVAILABLE");
    // The inactive area covers exactly this point – it must be ignored.
    const matches = await findServiceAreasForPoint(db, outsideAll);
    expect(matches.map((area) => area.id)).not.toContain(inactiveId);
  });

  it("returns UNKNOWN without trusted coordinates", async () => {
    expect(await checkServiceAvailability(db, null)).toEqual({
      status: "UNKNOWN",
      serviceArea: null,
      matchingAreaCount: 0,
    });
  });

  it("handles boundaries inclusively and rejects invalid coordinates", async () => {
    // Exactly on the polygon edge (ST_Covers includes the boundary).
    expect(
      (await checkServiceAvailability(db, { latitude: -45.15, longitude: 170.2 })).status,
    ).toBe("AVAILABLE");
    await expectDomainError(
      checkServiceAvailability(db, { latitude: 91, longitude: 0 }),
      "VALIDATION_FAILED",
    );
  });
});

let clientCounter = 0;
function submit(
  geocoder: GeocodingProvider | null,
  overrides: Record<string, unknown> = {},
  budget = 100,
) {
  clientCounter += 1;
  const geocoding: GeocodingDeps = { provider: geocoder, maxRequestsPerMinute: budget };
  return submitServiceRequest(
    {
      customerType: "PRIVATE",
      fullName: "Testdaten Person",
      email: uniqueEmail("geo"),
      street: "Teststr.",
      houseNumber: "7",
      postalCode: "12345",
      city: "Teststadt",
      serviceCategoryKey: "apartment-cleaning",
      propertyType: "APARTMENT",
      frequency: "ONCE",
      privacyNoticeAcknowledged: true,
      privacyNoticeVersion: "test-v1",
      ...overrides,
    },
    {
      db,
      clock: systemClock,
      config: TEST_CRM_CONFIG,
      requester: null,
      clientKey: `203.0.113.${String(clientCounter)}-geo`,
      rateLimitPerHour: 50,
      geocoding,
    },
  );
}

async function requestRow(requestId: string) {
  const [row] = await db
    .select()
    .from(schema.serviceRequest)
    .where(eq(schema.serviceRequest.id, requestId));
  return row;
}

async function attempts(requestId: string) {
  return db
    .select()
    .from(schema.geocodingAttempt)
    .where(eq(schema.geocodingAttempt.serviceRequestId, requestId))
    .orderBy(desc(schema.geocodingAttempt.createdAt), desc(schema.geocodingAttempt.id));
}

describe("request → lead → geocoding → service area", () => {
  it("stores a confident match, the availability and the audit trail (SYSTEM, no PII)", async () => {
    const geocoder = new TestGeocoder();
    geocoder.match(insideCircle);
    const result = await submit(geocoder);
    expect(result.serviceAreaStatus).toBe("AVAILABLE");

    const row = await requestRow(result.requestId);
    expect(row).toMatchObject({
      geocodingStatus: "SUCCEEDED",
      serviceAreaStatus: "AVAILABLE",
      serviceAreaId: circleId,
      latitude: insideCircle.latitude,
    });
    const [attempt] = await attempts(result.requestId);
    expect(attempt).toMatchObject({
      outcome: "ACCEPTED",
      provider: geocoder.id,
      precision: "BUILDING",
      region: "Testregion",
    });

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.entityId} IN (${result.requestId}, ${result.leadId})`);
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "lead.created",
        "service_request.submitted",
        "service_request.geocoded",
        "service_request.service_area_changed",
      ]),
    );
    expect(audit.every((a) => a.actorType === "SYSTEM")).toBe(true);
    const text = JSON.stringify(audit);
    for (const pii of ["Testdaten Person", "Teststr", "@example.test"])
      expect(text).not.toContain(pii);
  });

  it("marks points outside all areas as NOT_AVAILABLE", async () => {
    const geocoder = new TestGeocoder();
    geocoder.match(outsideAll);
    expect((await submit(geocoder)).serviceAreaStatus).toBe("NOT_AVAILABLE");
  });

  it("keeps uncertain matches out of the availability decision until a human decides", async () => {
    const geocoder = new TestGeocoder();
    geocoder.match(insideCircle, { precision: "STREET", houseNumber: null });
    const result = await submit(geocoder);
    expect(result.serviceAreaStatus).toBe("UNKNOWN");
    let row = await requestRow(result.requestId);
    expect(row).toMatchObject({
      geocodingStatus: "NEEDS_REVIEW",
      latitude: null,
      serviceAreaId: null,
    });
    const [review] = await attempts(result.requestId);
    expect(review?.outcome).toBe("NEEDS_REVIEW");
    expect(review?.reasons).toContain("PRECISION_TOO_LOW");

    const dispatcher = await contextForRole(db, "DISPATCHER");
    const decided = await reviewGeocodingCandidate(dispatcher, {
      serviceRequestId: result.requestId,
      attemptId: review?.id,
      decision: "CONFIRM",
    });
    expect(decided.serviceAvailability).toBe("AVAILABLE");
    row = await requestRow(result.requestId);
    expect(row).toMatchObject({ geocodingStatus: "MANUAL", serviceAreaId: circleId });
    const [manual] = await attempts(result.requestId);
    expect(manual).toMatchObject({
      outcome: "MANUAL_CONFIRMED",
      performedByUserId: dispatcher.actor.userId,
    });

    // A decided result cannot be decided again; only the latest attempt counts.
    await expectDomainError(
      reviewGeocodingCandidate(dispatcher, {
        serviceRequestId: result.requestId,
        attemptId: review?.id,
        decision: "REJECT",
      }),
      "CONFLICT",
    );
  });

  it("lets staff reject an uncertain match (no coordinates, UNKNOWN)", async () => {
    const geocoder = new TestGeocoder();
    geocoder.match(insideCircle, { postalCode: "99999" });
    const result = await submit(geocoder);
    const [review] = await attempts(result.requestId);
    const dispatcher = await contextForRole(db, "DISPATCHER");
    await reviewGeocodingCandidate(dispatcher, {
      serviceRequestId: result.requestId,
      attemptId: review?.id,
      decision: "REJECT",
    });
    expect(await requestRow(result.requestId)).toMatchObject({
      geocodingStatus: "FAILED",
      serviceAreaStatus: "UNKNOWN",
      latitude: null,
    });
  });

  it("stays PENDING/UNKNOWN when the provider is down, throws, or is not configured", async () => {
    const down = new TestGeocoder();
    down.queue.push({ status: "UNAVAILABLE", provider: down.id, reason: "TIMEOUT" });
    const r1 = await submit(down);
    expect(await requestRow(r1.requestId)).toMatchObject({
      geocodingStatus: "PENDING",
      serviceAreaStatus: "UNKNOWN",
    });

    const throwing = new TestGeocoder();
    throwing.queue.push(new Error("boom"));
    const r2 = await submit(throwing);
    expect(r2.geocodingFailed).toBe(false);
    const [attempt] = await attempts(r2.requestId);
    expect(attempt).toMatchObject({ outcome: "UNAVAILABLE", reasons: ["PROVIDER_ERROR"] });

    const r3 = await submit(null);
    expect(r3.serviceAreaStatus).toBe("UNKNOWN");
    expect(await attempts(r3.requestId)).toHaveLength(0);
  });

  it("enforces the global provider budget (rate limit)", async () => {
    const geocoder = new TestGeocoder();
    geocoder.match(insideCircle);
    geocoder.match(insideCircle);
    await submit(geocoder, {}, 1);
    const second = await submit(geocoder, {}, 1);
    expect(geocoder.calls).toBe(1);
    const [attempt] = await attempts(second.requestId);
    expect(attempt).toMatchObject({ outcome: "UNAVAILABLE", reasons: ["RATE_LIMITED"] });
  });

  it("re-runs geocoding and corrects addresses with audit (field names only)", async () => {
    const geocoder = new TestGeocoder();
    geocoder.queue.push({ status: "UNAVAILABLE", provider: geocoder.id, reason: "TIMEOUT" });
    const result = await submit(geocoder);
    const dispatcher = await contextForRole(db, "DISPATCHER");
    const deps: GeocodingDeps = { provider: geocoder, maxRequestsPerMinute: 100 };

    geocoder.match(outsideAll);
    expect(
      (await rerunRequestGeocoding(dispatcher, { serviceRequestId: result.requestId }, deps))
        .serviceAvailability,
    ).toBe("NOT_AVAILABLE");

    geocoder.match(insideCircle, { street: "Neue Straße", houseNumber: "1" });
    const corrected = await correctRequestAddress(
      dispatcher,
      {
        serviceRequestId: result.requestId,
        street: "Neue Straße",
        houseNumber: "1",
        postalCode: "12345",
        city: "Teststadt",
      },
      deps,
    );
    expect(corrected.serviceAvailability).toBe("AVAILABLE");
    const [changed] = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, result.requestId),
          eq(schema.auditLog.action, "service_request.address_changed"),
        ),
      );
    expect(changed?.after).toMatchObject({ changedFields: ["street", "houseNumber"] });
    expect(JSON.stringify(changed)).not.toContain("Neue Straße");
    expect(changed?.before).toMatchObject({ serviceAreaStatus: "NOT_AVAILABLE" });
  });

  it("keeps the geocoding history append-only", async () => {
    const geocoder = new TestGeocoder();
    geocoder.match(insideCircle);
    const result = await submit(geocoder);
    await expect(
      db.execute(
        sql`UPDATE geocoding_attempt SET latitude = 0 WHERE service_request_id = ${result.requestId}`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM geocoding_attempt WHERE service_request_id = ${result.requestId}`),
    ).rejects.toThrow();
  });

  it("rejects forged coordinates, service areas and statuses in every input", async () => {
    const forged = [
      { latitude: 1, longitude: 1 },
      { serviceAreaId: circleId },
      { serviceAreaStatus: "AVAILABLE" },
      { geocodingStatus: "MANUAL" },
    ];
    for (const overrides of forged) {
      await expectDomainError(submit(null, overrides), "VALIDATION_FAILED");
    }
    const dispatcher = await contextForRole(db, "DISPATCHER");
    const deps: GeocodingDeps = { provider: null, maxRequestsPerMinute: 1 };
    const stored = await submit(null);
    await expectDomainError(
      correctRequestAddress(
        dispatcher,
        {
          serviceRequestId: stored.requestId,
          street: "A",
          houseNumber: "1",
          postalCode: "12345",
          city: "B",
          latitude: 1,
        },
        deps,
      ),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      reviewGeocodingCandidate(dispatcher, {
        serviceRequestId: stored.requestId,
        attemptId: randomUUID(),
        decision: "CONFIRM",
        latitude: 1,
      }),
      "VALIDATION_FAILED",
    );
  });

  it("requires lead:update for staff geocoding actions", async () => {
    const stored = await submit(null);
    const deps: GeocodingDeps = { provider: null, maxRequestsPerMinute: 1 };
    const dispatcher = await contextForRole(db, "DISPATCHER");
    const { customerId } = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Testdaten" },
      TEST_CRM_CONFIG,
    );
    const [partner] = await db
      .insert(schema.partner)
      .values({
        legalName: "Partner (Testdaten)",
        status: "ACTIVE",
        verifiedAt: new Date(),
        verifiedByUserId: "test-verifier",
        baseLatitude: -45,
        baseLongitude: 170,
        serviceRadiusM: 1000,
      })
      .returning({ id: schema.partner.id });
    const contexts = [
      await contextForRole(db, "CUSTOMER", { customerId }),
      await contextForRole(db, "PARTNER", { partnerId: partner?.id ?? "" }),
      await contextForRole(db, "STAFF"),
      await contextForRole(db, "FINANCE"),
    ];
    for (const ctx of contexts) {
      await expectDomainError(
        rerunRequestGeocoding(ctx, { serviceRequestId: stored.requestId }, deps),
        "FORBIDDEN",
      );
    }
  });
});
