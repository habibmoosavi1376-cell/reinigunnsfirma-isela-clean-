import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvitation, createInvitation, loadActor } from "@isela/auth";
import { createServiceArea, setServiceAreaActive } from "@isela/catalog";
import {
  addCustomerAddress,
  createProperty,
  createPropertyFromLead,
  getCustomerDetail,
  inviteLeadContact,
  linkLeadToCustomer,
  listCustomers,
  registerCustomer,
  setPrimaryAddress,
  submitServiceRequest,
  updateCustomerAddress,
  updateProperty,
  type LeadInvitationDeps,
} from "@isela/crm";
import { and, count, eq, isNull, schema } from "@isela/database";
import { systemClock } from "@isela/shared";
import { expectDomainError, expectPgError } from "../support/assertions.ts";
import {
  CapturingEmailSender,
  TEST_CRM_CONFIG,
  TestClock,
  contextForRole,
  createUser,
  extractUrl,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

type Ctx = Awaited<ReturnType<typeof contextForRole>>;
let dispatcher: Ctx;
let admin: Ctx;
let finance: Ctx;

let counter = 0;
async function submitLead(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return submitServiceRequest(
    {
      customerType: "PRIVATE",
      fullName: "Testdaten Kunde",
      email: uniqueEmail("crm"),
      street: "Musterweg",
      houseNumber: String(counter),
      postalCode: "12345",
      city: "Teststadt",
      serviceCategoryKey: "apartment-cleaning",
      propertyType: "APARTMENT",
      frequency: "WEEKLY",
      privacyNoticeAcknowledged: true,
      privacyNoticeVersion: "test-v1",
      ...overrides,
    },
    {
      db,
      clock: systemClock,
      config: TEST_CRM_CONFIG,
      requester: null,
      clientKey: `198.51.100.${String(counter % 250)}-crm`,
      rateLimitPerHour: 500,
    },
  );
}

async function addressesOf(customerId: string) {
  return db
    .select()
    .from(schema.customerAddress)
    .where(
      and(
        eq(schema.customerAddress.customerId, customerId),
        isNull(schema.customerAddress.archivedAt),
      ),
    );
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityId, entityId));
  return rows.map((row) => row.action);
}

async function linkedCustomer(email?: string) {
  const lead = await submitLead(email === undefined ? {} : { email });
  const linked = await linkLeadToCustomer(dispatcher, { leadId: lead.leadId }, TEST_CRM_CONFIG);
  return { leadId: lead.leadId, customerId: linked.customerId };
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  finance = await contextForRole(db, "FINANCE");
});

describe("lead → customer → customer address", () => {
  it("creates the service address from the request once and marks it primary", async () => {
    const email = uniqueEmail("addr");
    const { leadId, customerId } = await linkedCustomer(email);
    const addresses = await addressesOf(customerId);
    expect(addresses).toHaveLength(1);
    const [address] = addresses;
    expect(address).toMatchObject({
      addressType: "SERVICE",
      isPrimary: true,
      source: "CUSTOMER_INPUT",
      // Coordinates are only copied from trusted geocoding results – none here.
      latitude: null,
      geocodingStatus: "PENDING",
    });
    const [request] = await db
      .select({ customerAddressId: schema.serviceRequest.customerAddressId })
      .from(schema.serviceRequest)
      .where(eq(schema.serviceRequest.leadId, leadId));
    expect(request?.customerAddressId).toBe(address?.id);
    expect(await auditActions(address?.id ?? "")).toContain("customer_address.created");
    expect(await auditActions(leadId)).toEqual(
      expect.arrayContaining(["lead.customer_linked", "lead.address_linked"]),
    );

    // Same person, same address (different spelling) → address is reused, no duplicate.
    const again = await submitLead({
      email: email.toUpperCase(),
      street: "musterweg ",
      houseNumber: address?.houseNumber ?? "",
    });
    const second = await linkLeadToCustomer(dispatcher, { leadId: again.leadId }, TEST_CRM_CONFIG);
    expect(second.customerId).toBe(customerId);
    expect(await addressesOf(customerId)).toHaveLength(1);

    // Same person, a further site → second (non-primary) address of the same customer.
    const other = await submitLead({ email, street: "Anderer Weg", houseNumber: "99" });
    await linkLeadToCustomer(dispatcher, { leadId: other.leadId }, TEST_CRM_CONFIG);
    const after = await addressesOf(customerId);
    expect(after).toHaveLength(2);
    expect(after.filter((a) => a.isPrimary)).toHaveLength(1);
  });

  it("never lets two concurrent requests create two customers for one identity", async () => {
    const email = uniqueEmail("race");
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        registerCustomer(
          dispatcher,
          { kind: "PRIVATE", displayName: "Parallel Testdaten", email },
          TEST_CRM_CONFIG,
        ),
      ),
    );
    expect(new Set(results.map((r) => r.customerId)).size).toBe(1);
    expect(results.filter((r) => r.outcome === "CREATED")).toHaveLength(1);

    const leadEmail = uniqueEmail("race-lead");
    const leads = await Promise.all([
      submitLead({ email: leadEmail }),
      submitLead({ email: leadEmail }),
    ]);
    const linked = await Promise.all(
      leads.map((lead) => linkLeadToCustomer(dispatcher, { leadId: lead.leadId }, TEST_CRM_CONFIG)),
    );
    expect(linked[0]?.customerId).toBe(linked[1]?.customerId);
  });

  it("keeps the payment history: a blocked customer cannot be bypassed with a new request", async () => {
    const email = uniqueEmail("blocked");
    const { customerId } = await linkedCustomer(email);
    await db
      .update(schema.customer)
      .set({ status: "BLOCKED" })
      .where(eq(schema.customer.id, customerId));
    const [before] = await db.select({ n: count() }).from(schema.customer);

    const retry = await submitLead({ email: email.replace("@", "@") });
    const linked = await linkLeadToCustomer(dispatcher, { leadId: retry.leadId }, TEST_CRM_CONFIG);
    expect(linked.customerId).toBe(customerId);
    const [after] = await db.select({ n: count() }).from(schema.customer);
    expect(after?.n).toBe(before?.n);

    const detail = await getCustomerDetail(finance, { customerId });
    expect(detail.customer.status).toBe("BLOCKED");
    expect(detail.payment.terms).toBe("PREPAYMENT");
    expect(detail.payment.reasons).toEqual(
      expect.arrayContaining(["CUSTOMER_BLOCKED", "NEW_CUSTOMER"]),
    );
  });

  it("rejects forged ownership when a request is re-pointed to a foreign address (DB trigger)", async () => {
    const a = await linkedCustomer();
    const b = await linkedCustomer();
    const [foreign] = await addressesOf(b.customerId);
    await expectPgError(
      db
        .update(schema.serviceRequest)
        .set({ customerAddressId: foreign?.id ?? "" })
        .where(eq(schema.serviceRequest.leadId, a.leadId)),
      "23503",
    );
  });
});

describe("addresses", () => {
  it("switches the primary address and audits it", async () => {
    const { customerId } = await linkedCustomer();
    const added = await addCustomerAddress(
      dispatcher,
      {
        customerId,
        addressType: "BILLING",
        street: "Rechnungsstraße",
        houseNumber: "1",
        postalCode: "54321",
        city: "Teststadt",
      },
      TEST_CRM_CONFIG,
    );
    await setPrimaryAddress(dispatcher, { addressId: added.addressId });
    const primaries = (await addressesOf(customerId)).filter((a) => a.isPrimary);
    expect(primaries.map((a) => a.id)).toEqual([added.addressId]);
    expect(await auditActions(added.addressId)).toContain("customer_address.primary_changed");
  });

  it("resets coordinates when the location changes and validates the postal code per country", async () => {
    const { customerId } = await linkedCustomer();
    const added = await addCustomerAddress(
      dispatcher,
      {
        customerId,
        addressType: "SERVICE",
        street: "Kartenweg",
        houseNumber: "7",
        postalCode: "12345",
        city: "Teststadt",
        latitude: -31.2,
        longitude: -61.3,
      },
      TEST_CRM_CONFIG,
    );
    await updateCustomerAddress(dispatcher, { addressId: added.addressId, houseNumber: "8" });
    const [row] = await db
      .select()
      .from(schema.customerAddress)
      .where(eq(schema.customerAddress.id, added.addressId));
    expect(row).toMatchObject({ houseNumber: "8", latitude: null, geocodingStatus: "PENDING" });
    await expectDomainError(
      updateCustomerAddress(dispatcher, { addressId: added.addressId, postalCode: "ABC" }),
      "VALIDATION_FAILED",
    );
    // Coordinates can never be written through the update API (mass assignment).
    await expectDomainError(
      updateCustomerAddress(dispatcher, { addressId: added.addressId, latitude: 1 }),
      "VALIDATION_FAILED",
    );
  });

  it("does not let a customer change another customer's address (IDOR)", async () => {
    const a = await linkedCustomer();
    const b = await linkedCustomer();
    const customerA = await contextForRole(db, "CUSTOMER", { customerId: a.customerId });
    const [foreign] = await addressesOf(b.customerId);
    await expectDomainError(
      updateCustomerAddress(customerA, { addressId: foreign?.id ?? "", street: "Fremd" }),
      "FORBIDDEN",
    );
    await expectDomainError(
      setPrimaryAddress(customerA, { addressId: foreign?.id ?? "" }),
      "FORBIDDEN",
    );
  });
});

describe("lead → property and property register", () => {
  it("creates one property from the request and is idempotent", async () => {
    const { leadId, customerId } = await linkedCustomer();
    const created = await createPropertyFromLead(dispatcher, { leadId });
    expect(created.outcome).toBe("CREATED");
    expect(await createPropertyFromLead(dispatcher, { leadId })).toEqual({
      outcome: "ALREADY_CREATED",
      propertyId: created.propertyId,
    });
    const [property] = await db
      .select()
      .from(schema.property)
      .where(eq(schema.property.id, created.propertyId));
    expect(property).toMatchObject({
      customerId,
      propertyType: "APARTMENT",
      serviceFrequency: "WEEKLY",
      active: true,
    });
    expect(await auditActions(created.propertyId)).toContain("property.created");
    expect(await auditActions(leadId)).toContain("lead.property_linked");
  });

  it("requires a linked customer before a property can be created", async () => {
    const lead = await submitLead();
    await expectDomainError(
      createPropertyFromLead(dispatcher, { leadId: lead.leadId }),
      "INVALID_STATE_TRANSITION",
    );
    await expectDomainError(createPropertyFromLead(finance, { leadId: lead.leadId }), "FORBIDDEN");
  });

  it("manages several properties with different addresses and intervals for one customer", async () => {
    const { customerId } = await linkedCustomer();
    const second = await addCustomerAddress(
      dispatcher,
      {
        customerId,
        addressType: "SERVICE",
        street: "Objektstraße",
        houseNumber: "12",
        postalCode: "12345",
        city: "Teststadt",
      },
      TEST_CRM_CONFIG,
    );
    const [first] = await addressesOf(customerId);
    const office = await createProperty(dispatcher, {
      customerId,
      addressId: first?.id ?? "",
      name: "Büro Testdaten",
      propertyType: "OFFICE",
      serviceFrequency: "WEEKLY",
      rooms: 6,
      bathrooms: 2,
    });
    const stairwell = await createProperty(dispatcher, {
      customerId,
      addressId: second.addressId,
      name: "Treppenhaus Testdaten",
      propertyType: "STAIRWELL",
      serviceFrequency: "BIWEEKLY",
    });
    await updateProperty(dispatcher, { propertyId: stairwell, active: false });
    const detail = await getCustomerDetail(dispatcher, { customerId });
    expect(detail.properties?.map((p) => [p.id, p.active])).toEqual([
      [office, true],
      [stairwell, false],
    ]);
    expect(await auditActions(stairwell)).toEqual(
      expect.arrayContaining(["property.created", "property.updated"]),
    );
  });

  it("rejects foreign addresses, foreign properties and mass assignment", async () => {
    const a = await linkedCustomer();
    const b = await linkedCustomer();
    const [addressA] = await addressesOf(a.customerId);
    const [addressB] = await addressesOf(b.customerId);
    await expectDomainError(
      createProperty(dispatcher, {
        customerId: a.customerId,
        addressId: addressB?.id ?? "",
        name: "Fremdadresse",
        propertyType: "OFFICE",
      }),
      "NOT_FOUND",
    );
    const propertyA = await createProperty(dispatcher, {
      customerId: a.customerId,
      addressId: addressA?.id ?? "",
      name: "Objekt A",
      propertyType: "OFFICE",
    });
    await expectDomainError(
      updateProperty(dispatcher, { propertyId: propertyA, addressId: addressB?.id ?? "" }),
      "NOT_FOUND",
    );
    await expectDomainError(
      updateProperty(dispatcher, { propertyId: propertyA, customerId: b.customerId }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      createProperty(dispatcher, {
        customerId: a.customerId,
        addressId: addressA?.id ?? "",
        name: "Mass assignment",
        propertyType: "OFFICE",
        archivedAt: new Date().toISOString(),
      }),
      "VALIDATION_FAILED",
    );
    const customerB = await contextForRole(db, "CUSTOMER", { customerId: b.customerId });
    await expectDomainError(
      updateProperty(customerB, { propertyId: propertyA, name: "Übernommen" }),
      "FORBIDDEN",
    );
    await expectDomainError(
      createProperty(customerB, {
        customerId: a.customerId,
        addressId: addressA?.id ?? "",
        name: "Fremdkunde",
        propertyType: "OFFICE",
      }),
      "FORBIDDEN",
    );
  });
});

describe("customer CRM read models", () => {
  it("lists customers with counts and finds them by e-mail hash, name and id", async () => {
    const email = uniqueEmail("list");
    const marker = `Listentest ${randomUUID().slice(0, 8)}`;
    const lead = await submitLead({ email, fullName: marker });
    const { customerId } = await linkLeadToCustomer(
      dispatcher,
      { leadId: lead.leadId },
      TEST_CRM_CONFIG,
    );
    await createPropertyFromLead(dispatcher, { leadId: lead.leadId });

    const byEmail = await listCustomers(dispatcher, { q: email.toUpperCase() }, TEST_CRM_CONFIG);
    expect(byEmail.items.map((c) => c.id)).toEqual([customerId]);
    expect(byEmail.items[0]).toMatchObject({
      leadCount: 1,
      openLeadCount: 1,
      propertyCount: 1,
      openQuoteCount: 0,
      primaryLocation: "12345 Teststadt",
    });
    const byName = await listCustomers(dispatcher, { q: marker }, TEST_CRM_CONFIG);
    expect(byName.items.map((c) => c.id)).toEqual([customerId]);
    const byId = await listCustomers(dispatcher, { q: customerId }, TEST_CRM_CONFIG);
    expect(byId.total).toBe(1);
  });

  it("treats LIKE wildcards literally and bounds pagination", async () => {
    const wildcard = await listCustomers(dispatcher, { q: "%" }, TEST_CRM_CONFIG);
    const all = await listCustomers(dispatcher, {}, TEST_CRM_CONFIG);
    expect(all.total).toBeGreaterThan(0);
    expect(wildcard.total).toBeLessThan(all.total);
    await expectDomainError(
      listCustomers(dispatcher, { pageSize: 51 }, TEST_CRM_CONFIG),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      listCustomers(dispatcher, { q: "x", orderBy: "id; DROP TABLE customer" }, TEST_CRM_CONFIG),
      "VALIDATION_FAILED",
    );
  });

  it("filters by service area geometry, not by city names", async () => {
    const { customerId } = await linkedCustomer();
    await addCustomerAddress(
      dispatcher,
      {
        customerId,
        addressType: "SERVICE",
        street: "Geoweg",
        houseNumber: "1",
        postalCode: "12345",
        city: "Teststadt",
        latitude: -33.4,
        longitude: -63.6,
      },
      TEST_CRM_CONFIG,
    );
    const areaId = await createServiceArea(admin, {
      kind: "CIRCLE",
      key: `crm-${randomUUID().slice(0, 8)}`,
      name: "CRM-Testgebiet",
      center: { latitude: -33.4, longitude: -63.6 },
      radiusM: 2_000,
    });
    await setServiceAreaActive(admin, { serviceAreaId: areaId, active: true });
    const inArea = await listCustomers(dispatcher, { serviceAreaId: areaId }, TEST_CRM_CONFIG);
    expect(inArea.items.map((c) => c.id)).toEqual([customerId]);
    const detail = await getCustomerDetail(dispatcher, { customerId });
    expect(detail.addresses.map((a) => a.inServiceArea).sort()).toEqual(["IN_AREA", "UNKNOWN"]);
    await setServiceAreaActive(admin, { serviceAreaId: areaId, active: false });
  });

  it("enforces staff-only access and field-level visibility", async () => {
    const { customerId } = await linkedCustomer();
    const customer = await contextForRole(db, "CUSTOMER", { customerId });
    const staff = await contextForRole(db, "STAFF");
    const [partnerRow] = await db
      .insert(schema.partner)
      .values({
        legalName: "Partner (Testdaten)",
        status: "ACTIVE",
        verifiedAt: new Date(),
        verifiedByUserId: "test-verifier",
        baseLatitude: 0,
        baseLongitude: 0,
        serviceRadiusM: 1000,
      })
      .returning({ id: schema.partner.id });
    const partner = await contextForRole(db, "PARTNER", { partnerId: partnerRow?.id ?? "" });
    for (const ctx of [customer, staff, partner]) {
      await expectDomainError(listCustomers(ctx, {}, TEST_CRM_CONFIG), "FORBIDDEN");
      await expectDomainError(getCustomerDetail(ctx, { customerId }), "FORBIDDEN");
    }
    await expectDomainError(
      getCustomerDetail(dispatcher, { customerId: randomUUID() }),
      "NOT_FOUND",
    );

    const forFinance = await getCustomerDetail(finance, { customerId });
    expect(forFinance.contacts).toBeNull();
    expect(forFinance.properties).toBeNull();
    expect(forFinance.quotes).toEqual([]);
    expect(forFinance.audit).not.toBeNull();
    expect(forFinance.payment).toMatchObject({
      terms: "PREPAYMENT",
      historySource: "NO_ORDER_DATA",
    });
    const forDispatcher = await getCustomerDetail(dispatcher, { customerId });
    expect(forDispatcher.contacts?.length).toBe(1);
    expect(forDispatcher.audit).toBeNull();
    expect(forDispatcher.customer.identityKinds).toContain("EMAIL");
    // Identity values are never exposed, only the kinds.
    expect(JSON.stringify(forDispatcher.customer)).not.toContain("@");
  });
});

describe("customer invitation from a lead", () => {
  const emailSender = new CapturingEmailSender();
  const deps = (clock = systemClock): LeadInvitationDeps => ({
    config: TEST_CRM_CONFIG,
    invite: (ctx, input) =>
      createInvitation({ ...ctx, clock }, input, {
        emailSender,
        acceptUrl: (token) => `https://app.example.test/account/invitation?token=${token}`,
      }),
  });

  async function accountFor(email: string, clock = systemClock) {
    const userId = await createUser(db, { email });
    const actor = await loadActor(db, userId);
    if (actor === null) throw new Error("actor missing");
    return { db, actor, clock };
  }

  it("sends a one-time, hashed, expiring token and revokes older invitations", async () => {
    const email = uniqueEmail("invite");
    const { leadId, customerId } = await linkedCustomer(email);
    const first = await inviteLeadContact(admin, { leadId }, deps());
    const firstToken = extractUrl(emailSender.lastFor(email, "auth.invitation")).searchParams.get(
      "token",
    );
    const second = await inviteLeadContact(admin, { leadId }, deps());
    const token = extractUrl(emailSender.lastFor(email, "auth.invitation")).searchParams.get(
      "token",
    );
    expect(token).not.toBe(firstToken);
    expect((token ?? "").length).toBeGreaterThanOrEqual(43);

    const [stored] = await db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, second.invitationId));
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.customerId).toBe(customerId);
    expect(stored?.roleKey).toBe("CUSTOMER");
    expect(second.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
    const [revoked] = await db
      .select({ revokedAt: schema.invitation.revokedAt })
      .from(schema.invitation)
      .where(eq(schema.invitation.id, first.invitationId));
    expect(revoked?.revokedAt).not.toBeNull();
    expect(await auditActions(leadId)).toContain("lead.customer_invited");

    const account = await accountFor(email);
    await expectDomainError(acceptInvitation(account, { token: firstToken ?? "" }), "NOT_FOUND");
    await acceptInvitation(account, { token: token ?? "" });
    // Token reuse is rejected without revealing why.
    await expectDomainError(acceptInvitation(account, { token: token ?? "" }), "NOT_FOUND");
    // The account is now linked, so no further invitation is sent.
    await expectDomainError(inviteLeadContact(admin, { leadId }, deps()), "CONFLICT");
  });

  it("rejects expired tokens", async () => {
    const email = uniqueEmail("expired");
    const { leadId } = await linkedCustomer(email);
    await inviteLeadContact(admin, { leadId }, deps());
    const token = extractUrl(emailSender.lastFor(email, "auth.invitation")).searchParams.get(
      "token",
    );
    const later = new TestClock();
    later.advance(7 * 24 * 3600 * 1000 + 1000);
    await expectDomainError(
      acceptInvitation(await accountFor(email, later), { token: token ?? "" }),
      "NOT_FOUND",
    );
  });

  it("only invites the verified identity of the linked customer, only by authorised staff", async () => {
    const unlinked = await submitLead();
    await expectDomainError(
      inviteLeadContact(admin, { leadId: unlinked.leadId }, deps()),
      "INVALID_STATE_TRANSITION",
    );
    const { leadId } = await linkedCustomer();
    await expectDomainError(inviteLeadContact(dispatcher, { leadId }, deps()), "FORBIDDEN");
    await expectDomainError(inviteLeadContact(finance, { leadId }, deps()), "FORBIDDEN");
    await expectDomainError(
      inviteLeadContact(admin, { leadId, customerId: randomUUID() }, deps()),
      "VALIDATION_FAILED",
    );

    // Lead matched to an existing customer by tax id: its (new) e-mail is not a registered
    // identity of that customer, so no invitation may bind it to the customer.
    const taxId = `DE${String(Date.now()).slice(-9)}`;
    const business = await submitLead({ customerType: "BUSINESS", companyName: "Test GmbH" });
    await linkLeadToCustomer(dispatcher, { leadId: business.leadId, taxId }, TEST_CRM_CONFIG);
    const other = await submitLead({ customerType: "BUSINESS", companyName: "Test GmbH" });
    await linkLeadToCustomer(dispatcher, { leadId: other.leadId, taxId }, TEST_CRM_CONFIG);
    await expectDomainError(
      inviteLeadContact(admin, { leadId: other.leadId }, deps()),
      "POLICY_VIOLATION",
    );
  });

  it("rate-limits invitations per customer", async () => {
    const { leadId } = await linkedCustomer();
    for (let i = 0; i < 3; i += 1) {
      await inviteLeadContact(admin, { leadId }, deps());
    }
    await expectDomainError(inviteLeadContact(admin, { leadId }, deps()), "RATE_LIMITED");
  });
});
