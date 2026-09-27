import { afterAll, describe, expect, it } from "vitest";
import {
  getLeadOverview,
  listCustomerServiceRequests,
  registerCustomer,
  submitServiceRequest,
  type ServiceRequestInput,
} from "@isela/crm";
import { and, eq, schema } from "@isela/database";
import { systemClock } from "@isela/shared";
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

let clientCounter = 0;
function deps(overrides: Partial<Parameters<typeof submitServiceRequest>[1]> = {}) {
  clientCounter += 1;
  return {
    db,
    clock: systemClock,
    config: TEST_CRM_CONFIG,
    requester: null,
    clientKey: `198.51.100.${clientCounter}`,
    rateLimitPerHour: 5,
    ...overrides,
  };
}

function request(
  overrides: Record<string, unknown> = {},
): ServiceRequestInput & Record<string, unknown> {
  return {
    customerType: "PRIVATE",
    fullName: "Erika Muster",
    email: uniqueEmail("request"),
    street: "Musterweg",
    houseNumber: "3",
    postalCode: "12345",
    city: "Musterstadt",
    serviceCategoryKey: "apartment-cleaning",
    propertyType: "APARTMENT",
    frequency: "WEEKLY",
    privacyNoticeAcknowledged: true,
    privacyNoticeVersion: "test-v1",
    ...overrides,
  };
}

describe("public service request", () => {
  it("creates lead, contact and request without consent, audited as SYSTEM without personal data", async () => {
    const input = request({ message: "Bitte Fenster mitreinigen." });
    const result = await submitServiceRequest(input, deps());
    expect(result.serviceAreaStatus).toBe("UNKNOWN");

    const [lead] = await db.select().from(schema.lead).where(eq(schema.lead.id, result.leadId));
    expect(lead?.status).toBe("DISCOVERED");
    const contacts = await db
      .select()
      .from(schema.leadContact)
      .where(eq(schema.leadContact.leadId, result.leadId));
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.legalBasis).toBe("GDPR_ART6_1B_CONTRACT");
    const consents = await db
      .select()
      .from(schema.consent)
      .where(eq(schema.consent.subjectId, contacts[0]?.id ?? ""));
    expect(consents).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, result.requestId),
          eq(schema.auditLog.action, "service_request.submitted"),
        ),
      );
    expect(audit?.actorType).toBe("SYSTEM");
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(input.email);
    expect(auditText).not.toContain("Erika");
    expect(auditText).not.toContain("Musterweg");
  });

  it("stores marketing consent only when given, as immutable evidence", async () => {
    const result = await submitServiceRequest(
      request({ marketingConsent: true, marketingConsentTextVersion: "mk-v1" }),
      deps(),
    );
    const [contact] = await db
      .select()
      .from(schema.leadContact)
      .where(eq(schema.leadContact.leadId, result.leadId));
    const consents = await db
      .select()
      .from(schema.consent)
      .where(eq(schema.consent.subjectId, contact?.id ?? ""));
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      purpose: "MARKETING_EMAIL",
      legalBasis: "GDPR_ART6_1A",
      status: "GRANTED",
      textVersion: "mk-v1",
    });
  });

  it("rejects missing privacy acknowledgement and stores nothing", async () => {
    const email = uniqueEmail("noack");
    await expectDomainError(
      submitServiceRequest(request({ email, privacyNoticeAcknowledged: false }), deps()),
      "VALIDATION_FAILED",
    );
    const contacts = await db
      .select()
      .from(schema.leadContact)
      .where(eq(schema.leadContact.email, email));
    expect(contacts).toHaveLength(0);
  });

  it.each([
    ["mass assignment: status", { status: "WON" }],
    ["mass assignment: customerId", { customerId: "11111111-1111-4111-8111-111111111111" }],
    ["mass assignment: price", { price: 0 }],
    ["oversized message", { message: "x".repeat(2001) }],
    ["malformed e-mail", { email: "no-at-sign" }],
    ["unknown service", { serviceCategoryKey: "does-not-exist" }],
    ["invalid consent", { marketingConsent: true }],
  ])("rejects %s", async (_label, override) => {
    await expectDomainError(submitServiceRequest(request(override), deps()), "VALIDATION_FAILED");
  });

  it("rate-limits per client and per e-mail address", async () => {
    const client = deps({ clientKey: "203.0.113.200", rateLimitPerHour: 2 });
    await submitServiceRequest(request(), client);
    await submitServiceRequest(request(), client);
    await expectDomainError(submitServiceRequest(request(), client), "RATE_LIMITED");

    const email = uniqueEmail("flood");
    for (let i = 0; i < 3; i++) {
      await submitServiceRequest(request({ email }), deps());
    }
    await expectDomainError(submitServiceRequest(request({ email }), deps()), "RATE_LIMITED");
    const keys = await db.select({ key: schema.publicRateLimit.key }).from(schema.publicRateLimit);
    expect(keys.every((k) => !k.key.includes("@") && !k.key.includes("203.0.113"))).toBe(true);
  });

  it("links requests of signed-in customers and isolates them per customer", async () => {
    const dispatcher = await contextForRole(db, "DISPATCHER");
    const a = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Kunde A" },
      TEST_CRM_CONFIG,
    );
    const b = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Kunde B" },
      TEST_CRM_CONFIG,
    );
    const customerA = await contextForRole(db, "CUSTOMER", { customerId: a.customerId });
    const customerB = await contextForRole(db, "CUSTOMER", { customerId: b.customerId });

    await submitServiceRequest(request(), deps({ requester: customerA.actor }));
    expect(await listCustomerServiceRequests(customerA, { customerId: a.customerId })).toHaveLength(
      1,
    );
    expect(await listCustomerServiceRequests(customerB, { customerId: b.customerId })).toHaveLength(
      0,
    );
    await expectDomainError(
      listCustomerServiceRequests(customerB, { customerId: a.customerId }),
      "FORBIDDEN",
    );
    await expectDomainError(
      listCustomerServiceRequests(anonymousContext(db), { customerId: a.customerId }),
      "UNAUTHENTICATED",
    );
  });
});

describe("lead overview (admin dashboard data)", () => {
  it("requires lead:read", async () => {
    const dispatcher = await contextForRole(db, "DISPATCHER");
    const overview = await getLeadOverview(dispatcher);
    expect(overview.latestRequests.length).toBeGreaterThan(0);
    const customer = await contextForRole(db, "CUSTOMER", {
      customerId: (
        await registerCustomer(dispatcher, { kind: "PRIVATE", displayName: "C" }, TEST_CRM_CONFIG)
      ).customerId,
    });
    await expectDomainError(getLeadOverview(customer), "FORBIDDEN");
    await expectDomainError(getLeadOverview(await contextForRole(db, "STAFF")), "FORBIDDEN");
    await expectDomainError(getLeadOverview(anonymousContext(db)), "UNAUTHENTICATED");
  });
});
