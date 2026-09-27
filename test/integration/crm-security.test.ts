import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addCustomerAddress,
  createProperty,
  getCustomer,
  listProperties,
  registerCustomer,
  updateCustomer,
} from "@isela/crm";
import { and, eq, schema } from "@isela/database";
import { expectDomainError } from "../support/assertions.ts";
import {
  TEST_CRM_CONFIG,
  anonymousContext,
  contextForRole,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

type Ctx = Awaited<ReturnType<typeof contextForRole>>;
let dispatcher: Ctx;
let customerA: string;
let customerB: string;
let addressA: string;
let addressB: string;
let customerAUser: Ctx;

const address = (customerId: string, extra: Record<string, unknown> = {}) => ({
  customerId,
  addressType: "SERVICE",
  street: "Musterstraße",
  houseNumber: "1",
  postalCode: "45879",
  city: "Musterstadt",
  ...extra,
});

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  const a = await registerCustomer(
    dispatcher,
    { kind: "PRIVATE", displayName: "Kunde A", email: uniqueEmail("a") },
    TEST_CRM_CONFIG,
  );
  const b = await registerCustomer(
    dispatcher,
    { kind: "BUSINESS", displayName: "Kunde B", companyName: "B GmbH", email: uniqueEmail("b") },
    TEST_CRM_CONFIG,
  );
  customerA = a.customerId;
  customerB = b.customerId;
  addressA = (await addCustomerAddress(dispatcher, address(customerA), TEST_CRM_CONFIG)).addressId;
  addressB = (
    await addCustomerAddress(
      dispatcher,
      address(customerB, { street: "Andere Straße" }),
      TEST_CRM_CONFIG,
    )
  ).addressId;
  customerAUser = await contextForRole(db, "CUSTOMER", { customerId: customerA });
});

describe("authorization", () => {
  it("rejects unauthenticated access", async () => {
    await expectDomainError(
      getCustomer(anonymousContext(db), { customerId: customerA }),
      "UNAUTHENTICATED",
    );
  });

  it("lets a customer read its own record but not another customer's (IDOR)", async () => {
    expect((await getCustomer(customerAUser, { customerId: customerA })).displayName).toBe(
      "Kunde A",
    );
    await expectDomainError(getCustomer(customerAUser, { customerId: customerB }), "FORBIDDEN");
    await expectDomainError(listProperties(customerAUser, { customerId: customerB }), "FORBIDDEN");
    await expectDomainError(
      createProperty(customerAUser, {
        customerId: customerB,
        addressId: addressB,
        name: "x",
        propertyType: "HOUSE",
      }),
      "FORBIDDEN",
    );
    await expectDomainError(
      addCustomerAddress(customerAUser, address(customerB), TEST_CRM_CONFIG),
      "FORBIDDEN",
    );
  });

  it("does not let a customer attach another customer's address to its own property", async () => {
    await expectDomainError(
      createProperty(customerAUser, {
        customerId: customerA,
        addressId: addressB,
        name: "x",
        propertyType: "HOUSE",
      }),
      "NOT_FOUND",
    );
  });

  it("lets a customer manage its own properties", async () => {
    const propertyId = await createProperty(customerAUser, {
      customerId: customerA,
      addressId: addressA,
      name: "Wohnung",
      propertyType: "APARTMENT",
      areaSqm: 72.5,
    });
    const properties = await listProperties(customerAUser, { customerId: customerA });
    expect(properties.map((p) => p.id)).toContain(propertyId);
  });

  it("denies staff and partners access to customer data", async () => {
    const staff = await contextForRole(db, "STAFF");
    await expectDomainError(getCustomer(staff, { customerId: customerA }), "FORBIDDEN");
    const partnerCtx = await contextForRole(db, "CUSTOMER", { customerId: customerB });
    await expectDomainError(
      updateCustomer(partnerCtx, { customerId: customerA, displayName: "Hijack" }),
      "FORBIDDEN",
    );
  });

  it("denies customers the creation of customers", async () => {
    await expectDomainError(
      registerCustomer(customerAUser, { kind: "PRIVATE", displayName: "x" }, TEST_CRM_CONFIG),
      "FORBIDDEN",
    );
  });
});

describe("mass assignment", () => {
  it("rejects protected fields on customer update, even next to allowed fields", async () => {
    const before = await getCustomer(customerAUser, { customerId: customerA });
    await expectDomainError(
      updateCustomer(customerAUser, {
        customerId: customerA,
        displayName: "Mass Assignment",
        status: "BLOCKED",
      }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      updateCustomer(customerAUser, {
        customerId: customerA,
        displayName: "Mass Assignment",
        duplicateReviewStatus: "NONE",
      }),
      "VALIDATION_FAILED",
    );
    // Nothing may have been written – neither the allowed nor the protected field.
    expect(await getCustomer(customerAUser, { customerId: customerA })).toEqual(before);
  });

  it("rejects protected fields on registration", async () => {
    await expectDomainError(
      registerCustomer(
        dispatcher,
        { kind: "PRIVATE", displayName: "x", status: "BLOCKED" },
        TEST_CRM_CONFIG,
      ),
      "VALIDATION_FAILED",
    );
  });

  it("does not let customers submit coordinates (service-area spoofing)", async () => {
    await expectDomainError(
      addCustomerAddress(
        customerAUser,
        address(customerA, { latitude: 51.5, longitude: 7.1 }),
        TEST_CRM_CONFIG,
      ),
      "VALIDATION_FAILED",
    );
    const { addressId } = await addCustomerAddress(
      customerAUser,
      address(customerA),
      TEST_CRM_CONFIG,
    );
    const [row] = await db
      .select()
      .from(schema.customerAddress)
      .where(eq(schema.customerAddress.id, addressId));
    expect(row?.source).toBe("CUSTOMER_INPUT");
    expect(row?.geocodingStatus).toBe("PENDING");
  });

  it("applies allowed updates and audits them", async () => {
    await updateCustomer(customerAUser, { customerId: customerA, displayName: "Kunde A (neu)" });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "customer.updated"),
          eq(schema.auditLog.entityId, customerA),
        ),
      );
    expect(audit.length).toBe(1);
    expect(audit[0]?.actorId).toBe(customerAUser.actor.userId);
  });
});

describe("duplicate customer history bypass", () => {
  it("resolves a new registration with a known e-mail to the existing customer", async () => {
    const email = uniqueEmail("returning");
    const first = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Erstkonto", email },
      TEST_CRM_CONFIG,
    );
    expect(first.outcome).toBe("CREATED");
    const second = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Neues Konto", email: email.toUpperCase() },
      TEST_CRM_CONFIG,
    );
    expect(second).toEqual({
      outcome: "EXISTING_CUSTOMER",
      customerId: first.customerId,
      matchedBy: "EMAIL",
    });
    const identities = await db
      .select()
      .from(schema.customerIdentity)
      .where(eq(schema.customerIdentity.customerId, first.customerId));
    expect(identities.every((i) => !i.valueHash.includes("@"))).toBe(true);
  });

  it("resolves by tax id and refuses ambiguous identities", async () => {
    const taxA = `DE${String(Date.now()).slice(-9)}`;
    const a = await registerCustomer(
      dispatcher,
      { kind: "BUSINESS", displayName: "Firma", companyName: "Firma", taxId: taxA },
      TEST_CRM_CONFIG,
    );
    const again = await registerCustomer(
      dispatcher,
      {
        kind: "BUSINESS",
        displayName: "Firma 2",
        companyName: "Firma 2",
        taxId: taxA.toLowerCase(),
      },
      TEST_CRM_CONFIG,
    );
    expect(again.customerId).toBe(a.customerId);

    const emailB = uniqueEmail("ambiguous");
    await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "B", email: emailB },
      TEST_CRM_CONFIG,
    );
    await expectDomainError(
      registerCustomer(
        dispatcher,
        { kind: "BUSINESS", displayName: "Mix", companyName: "Mix", email: emailB, taxId: taxA },
        TEST_CRM_CONFIG,
      ),
      "CONFLICT",
    );
  });

  it("flags phone matches for duplicate review (prepayment enforced while pending)", async () => {
    const phone = `0209 ${String(Date.now()).slice(-7)}`;
    await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "P1", phone },
      TEST_CRM_CONFIG,
    );
    const second = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "P2", phone: phone.replace(/^0/, "+49 ") },
      TEST_CRM_CONFIG,
    );
    expect(second).toMatchObject({ outcome: "CREATED", duplicateReviewRequired: true });
    const view = await getCustomer(dispatcher, { customerId: second.customerId });
    expect(view.duplicateReviewStatus).toBe("PENDING");
  });

  it("flags identical billing addresses of different customers", async () => {
    const c1 = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Addr 1" },
      TEST_CRM_CONFIG,
    );
    const c2 = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Addr 2" },
      TEST_CRM_CONFIG,
    );
    const billing = {
      addressType: "BILLING",
      street: "Rechnungsweg",
      houseNumber: `${Date.now() % 1000}`,
      postalCode: "45879",
      city: "Musterstadt",
    };
    const first = await addCustomerAddress(
      dispatcher,
      { customerId: c1.customerId, ...billing },
      TEST_CRM_CONFIG,
    );
    expect(first.duplicateReviewRequired).toBe(false);
    const second = await addCustomerAddress(
      dispatcher,
      { customerId: c2.customerId, ...billing, street: "Rechnungsweg " },
      TEST_CRM_CONFIG,
    );
    expect(second.duplicateReviewRequired).toBe(true);
  });
});
