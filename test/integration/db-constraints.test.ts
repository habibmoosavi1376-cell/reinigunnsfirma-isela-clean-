import { afterAll, describe, expect, it } from "vitest";
import { eq, schema, sql } from "@isela/database";
import { expectPgError } from "../support/assertions.ts";
import { createUser, openTestDatabase } from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const INTEGRITY_VIOLATION = "23000";
const EXCLUSION_VIOLATION = "23P01";

async function createCustomer(): Promise<string> {
  const [row] = await db
    .insert(schema.customer)
    .values({ kind: "PRIVATE", displayName: "Constraint Test" })
    .returning({ id: schema.customer.id });
  if (row === undefined) throw new Error("insert failed");
  return row.id;
}

describe("migrations", () => {
  it("applied all three migrations and the required extensions", async () => {
    const migrations = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(migrations.rows[0]?.count).toBe("3");
    const extensions = await db.execute<{ extname: string }>(
      sql`SELECT extname FROM pg_extension ORDER BY extname`,
    );
    expect(extensions.rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(["btree_gist", "postgis"]),
    );
  });
});

describe("service_area constraints", () => {
  it("rejects a circle without radius", async () => {
    await expectPgError(
      db.execute(
        sql`INSERT INTO service_area (key, name, kind, center) VALUES ('c1', 'c1', 'CIRCLE', ST_SetSRID(ST_MakePoint(7, 51), 4326)::geography)`,
      ),
      CHECK_VIOLATION,
    );
  });

  it("rejects a polygon area with a centre", async () => {
    await expectPgError(
      db.execute(sql`INSERT INTO service_area (key, name, kind, center, boundary) VALUES ('p1', 'p1', 'POLYGON', ST_SetSRID(ST_MakePoint(7, 51), 4326)::geography,
        ST_Multi(ST_GeomFromText('POLYGON((7 51, 7.1 51, 7.1 51.1, 7 51.1, 7 51))', 4326))::geography)`),
      CHECK_VIOLATION,
    );
  });
});

describe("lead_source constraints", () => {
  it("rejects enabling an external provider without terms review", async () => {
    await expectPgError(
      db.insert(schema.leadSource).values({
        key: "external-unreviewed",
        name: "x",
        providerKind: "BUSINESS_SEARCH",
        legalBasis: "GDPR_ART6_1F_LEGITIMATE_INTEREST",
        allowedUse: "x",
        retentionDays: 30,
        rateLimitPerMinute: 1,
        enabled: true,
      }),
      CHECK_VIOLATION,
    );
  });

  it("allows storing an external provider disabled", async () => {
    await db.insert(schema.leadSource).values({
      key: "external-disabled",
      name: "x",
      providerKind: "BUSINESS_SEARCH",
      legalBasis: "GDPR_ART6_1F_LEGITIMATE_INTEREST",
      retentionDays: 30,
      rateLimitPerMinute: 1,
      enabled: false,
    });
  });
});

describe("append-only tables", () => {
  it("blocks UPDATE, DELETE and TRUNCATE on audit_log", async () => {
    await db.insert(schema.auditLog).values({
      actorType: "SYSTEM",
      action: "test.append_only",
      entityType: "test",
      entityId: "1",
    });
    await expectPgError(db.execute(sql`UPDATE audit_log SET action = 'x'`), INTEGRITY_VIOLATION);
    await expectPgError(db.execute(sql`DELETE FROM audit_log`), INTEGRITY_VIOLATION);
    await expectPgError(db.execute(sql`TRUNCATE audit_log`), INTEGRITY_VIOLATION);
  });

  it("blocks modification of consent evidence", async () => {
    const customerId = await createCustomer();
    await db.insert(schema.consent).values({
      subjectType: "CUSTOMER",
      subjectId: customerId,
      purpose: "MARKETING_EMAIL",
      legalBasis: "GDPR_ART6_1A",
      status: "GRANTED",
      grantedAt: new Date(),
      source: "WEBSITE_FORM",
      textVersion: "v1",
    });
    await expectPgError(
      db
        .update(schema.consent)
        .set({ status: "WITHDRAWN" })
        .where(eq(schema.consent.subjectId, customerId)),
      INTEGRITY_VIOLATION,
    );
  });

  it("rejects cookie consent with a GDPR-only legal basis", async () => {
    const customerId = await createCustomer();
    await expectPgError(
      db.insert(schema.consent).values({
        subjectType: "CUSTOMER",
        subjectId: customerId,
        purpose: "COOKIES_ANALYTICS",
        legalBasis: "GDPR_ART6_1A",
        status: "GRANTED",
        grantedAt: new Date(),
        source: "COOKIE_BANNER",
        textVersion: "v1",
      }),
      CHECK_VIOLATION,
    );
  });
});

describe("settings versioning", () => {
  it("prevents overlapping validity periods for the same key and scope", async () => {
    const base = {
      key: "overlap.test",
      scopeType: "GLOBAL" as const,
      value: {},
      changeReason: "test",
      createdByUserId: "test",
    };
    await db
      .insert(schema.setting)
      .values({ ...base, version: 1, effectiveFrom: new Date("2030-01-01T00:00:00Z") });
    await expectPgError(
      db
        .insert(schema.setting)
        .values({ ...base, version: 2, effectiveFrom: new Date("2030-06-01T00:00:00Z") }),
      EXCLUSION_VIOLATION,
    );
  });

  it("requires scope ids exactly for non-global scopes", async () => {
    await expectPgError(
      db.insert(schema.setting).values({
        key: "scope.test",
        scopeType: "CUSTOMER",
        version: 1,
        value: {},
        effectiveFrom: new Date(),
        changeReason: "test",
        createdByUserId: "test",
      }),
      CHECK_VIOLATION,
    );
  });
});

describe("customer data constraints", () => {
  it("derives the geography point from latitude/longitude", async () => {
    const customerId = await createCustomer();
    const [row] = await db
      .insert(schema.customerAddress)
      .values({
        customerId,
        addressType: "SERVICE",
        street: "Teststraße",
        houseNumber: "1",
        postalCode: "12345",
        city: "Teststadt",
        latitude: 51.5,
        longitude: 7.1,
        geocodingStatus: "MANUAL",
        geocodedAt: new Date(),
        source: "STAFF_INPUT",
      })
      .returning({ id: schema.customerAddress.id });
    const result = await db.execute<{ lat: number; lng: number }>(
      sql`SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM customer_address WHERE id = ${row?.id}`,
    );
    expect(Number(result.rows[0]?.lat)).toBeCloseTo(51.5, 6);
    expect(Number(result.rows[0]?.lng)).toBeCloseTo(7.1, 6);
  });

  it("rejects half-set coordinates and inconsistent geocoding status", async () => {
    const customerId = await createCustomer();
    const base = {
      customerId,
      addressType: "SERVICE" as const,
      street: "Teststraße",
      houseNumber: "1",
      postalCode: "12345",
      city: "Teststadt",
      source: "STAFF_INPUT" as const,
    };
    await expectPgError(
      db.insert(schema.customerAddress).values({ ...base, latitude: 51.5 }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      db.insert(schema.customerAddress).values({ ...base, geocodingStatus: "SUCCEEDED" }),
      CHECK_VIOLATION,
    );
  });

  it("rejects a property that references another customer's address", async () => {
    const owner = await createCustomer();
    const other = await createCustomer();
    const [address] = await db
      .insert(schema.customerAddress)
      .values({
        customerId: owner,
        addressType: "SERVICE",
        street: "A",
        houseNumber: "1",
        postalCode: "12345",
        city: "X",
        source: "STAFF_INPUT",
      })
      .returning({ id: schema.customerAddress.id });
    await expectPgError(
      db.insert(schema.property).values({
        customerId: other,
        addressId: address?.id ?? "",
        name: "p",
        propertyType: "HOUSE",
      }),
      FK_VIOLATION,
    );
  });

  it("enforces unique e-mail identities system-wide", async () => {
    const a = await createCustomer();
    const b = await createCustomer();
    await db
      .insert(schema.customerIdentity)
      .values({ customerId: a, kind: "EMAIL", valueHash: "same-hash" });
    await expectPgError(
      db
        .insert(schema.customerIdentity)
        .values({ customerId: b, kind: "EMAIL", valueHash: "same-hash" }),
      UNIQUE_VIOLATION,
    );
    // Signals (phone) may be shared.
    await db
      .insert(schema.customerIdentity)
      .values({ customerId: a, kind: "PHONE", valueHash: "shared-phone" });
    await db
      .insert(schema.customerIdentity)
      .values({ customerId: b, kind: "PHONE", valueHash: "shared-phone" });
  });

  it("prevents deleting a customer that still has addresses (no cascades on business data)", async () => {
    const customerId = await createCustomer();
    await db.insert(schema.customerAddress).values({
      customerId,
      addressType: "BILLING",
      street: "A",
      houseNumber: "1",
      postalCode: "12345",
      city: "X",
      source: "STAFF_INPUT",
    });
    await expectPgError(
      db.delete(schema.customer).where(eq(schema.customer.id, customerId)),
      FK_VIOLATION,
    );
  });
});

describe("RBAC constraints", () => {
  it("rejects a CUSTOMER role without customer scope and a global role with scope", async () => {
    const userId = await createUser(db);
    const customerId = await createCustomer();
    await expectPgError(
      db.insert(schema.userRole).values({ userId, roleKey: "CUSTOMER" }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      db.insert(schema.userRole).values({ userId, roleKey: "ADMIN", customerId }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      db.insert(schema.userRole).values({ userId, roleKey: "DISPATCHER", isScopeAdmin: true }),
      CHECK_VIOLATION,
    );
  });

  it("rejects unknown role keys", async () => {
    const userId = await createUser(db);
    await expectPgError(
      db.insert(schema.userRole).values({ userId, roleKey: "ROOT" }),
      FK_VIOLATION,
    );
  });

  it("mirrors the code-defined RBAC catalogue", async () => {
    const roles = await db.select({ key: schema.role.key }).from(schema.role);
    expect(roles.map((r) => r.key).sort()).toEqual([
      "ADMIN",
      "CUSTOMER",
      "DISPATCHER",
      "FINANCE",
      "PARTNER",
      "STAFF",
      "SUPER_ADMIN",
    ]);
    const financePolicy = await db
      .select()
      .from(schema.rolePermission)
      .where(eq(schema.rolePermission.permissionKey, "payment_policy:manage"));
    expect(financePolicy.map((r) => r.roleKey).sort()).toEqual(["FINANCE", "SUPER_ADMIN"]);
  });
});
