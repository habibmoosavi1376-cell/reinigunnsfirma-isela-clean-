import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getLeadDetail,
  listLeads,
  registerCustomer,
  submitServiceRequest,
  transitionLead,
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

type Ctx = Awaited<ReturnType<typeof contextForRole>>;
let dispatcher: Ctx;
let admin: Ctx;
const marker = `Mark${randomUUID().slice(0, 8)}`;
let leadA: { leadId: string; requestId: string };
let leadB: { leadId: string; requestId: string };
let emailA: string;

let counter = 0;
function submit(overrides: Record<string, unknown>) {
  counter += 1;
  return submitServiceRequest(
    {
      customerType: "PRIVATE",
      fullName: "Testdaten Person",
      email: uniqueEmail("crm"),
      street: "Testweg",
      houseNumber: "1",
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
      clientKey: `198.18.0.${String(counter)}-crm`,
      rateLimitPerHour: 50,
    },
  );
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  emailA = uniqueEmail("crm-a");
  leadA = await submit({
    fullName: `Erika ${marker}`,
    email: emailA,
    message: "<script>alert(1)</script>",
    marketingConsent: true,
    marketingConsentTextVersion: "mk-test",
  });
  leadB = await submit({
    customerType: "PROPERTY_MANAGEMENT",
    companyName: `HV ${marker} GmbH`,
    fullName: "Max Testdaten",
    serviceCategoryKey: "office-cleaning",
    propertyType: "OFFICE",
    numberOfProperties: 12,
  });
});

describe("lead list (filters, search, pagination)", () => {
  it("finds leads by name, company, e-mail and id – without e-mail/phone in the list", async () => {
    const byName = await listLeads(dispatcher, { q: marker });
    expect(byName.items.map((i) => i.id).sort()).toEqual([leadA.leadId, leadB.leadId].sort());
    expect((await listLeads(dispatcher, { q: emailA })).items.map((i) => i.id)).toEqual([
      leadA.leadId,
    ]);
    expect((await listLeads(dispatcher, { q: leadB.leadId })).items.map((i) => i.id)).toEqual([
      leadB.leadId,
    ]);
    expect(JSON.stringify(byName.items)).not.toContain("@example.test");
    expect(byName.items.find((i) => i.id === leadA.leadId)?.contactName).toBe(`Erika ${marker}`);
  });

  it("filters by status, customer type, service, source and period", async () => {
    const pm = await listLeads(dispatcher, { q: marker, customerType: "PROPERTY_MANAGEMENT" });
    expect(pm.items.map((i) => i.id)).toEqual([leadB.leadId]);
    const office = await listLeads(dispatcher, {
      q: marker,
      serviceCategoryKey: "office-cleaning",
    });
    expect(office.items.map((i) => i.id)).toEqual([leadB.leadId]);
    expect(
      (await listLeads(dispatcher, { q: marker, sourceKey: "internal-website-form" })).total,
    ).toBe(2);
    expect((await listLeads(dispatcher, { q: marker, status: ["WON"] })).total).toBe(0);
    expect((await listLeads(dispatcher, { q: marker, availability: "UNKNOWN" })).total).toBe(2);
    expect((await listLeads(dispatcher, { q: marker, serviceAreaId: randomUUID() })).total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (await listLeads(dispatcher, { q: marker, createdFrom: today, createdTo: today })).total,
    ).toBe(2);
    expect((await listLeads(dispatcher, { q: marker, createdTo: "2000-01-01" })).total).toBe(0);
  });

  it("treats SQL and LIKE metacharacters as plain text", async () => {
    // None of these strings occur literally in any lead, so each must match nothing.
    for (const q of [
      "' OR '1'='1",
      "%%%",
      "___",
      "\\\\",
      `${marker}%' --`,
      "'; DROP TABLE lead; --",
    ]) {
      expect((await listLeads(dispatcher, { q })).total, q).toBe(0);
    }
    // A wildcard inside the search text is literal: "Erika%Mark" does not match "Erika Mark…".
    expect((await listLeads(dispatcher, { q: `Erika%${marker}` })).total).toBe(0);
    const [row] = await db
      .select({ id: schema.lead.id })
      .from(schema.lead)
      .where(eq(schema.lead.id, leadA.leadId));
    expect(row?.id).toBe(leadA.leadId);
  });

  it("bounds pagination", async () => {
    await expectDomainError(listLeads(dispatcher, { pageSize: 51 }), "VALIDATION_FAILED");
    await expectDomainError(listLeads(dispatcher, { page: 0 }), "VALIDATION_FAILED");
    await expectDomainError(listLeads(dispatcher, { page: 10_001 }), "VALIDATION_FAILED");
    const beyond = await listLeads(dispatcher, { q: marker, page: 9999, pageSize: 50 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(2);
    const first = await listLeads(dispatcher, { q: marker, pageSize: 1 });
    const second = await listLeads(dispatcher, { q: marker, pageSize: 1, page: 2 });
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  });
});

describe("lead detail", () => {
  it("shows request, contact, consent, history; audit only with audit:read", async () => {
    const detail = await getLeadDetail(dispatcher, { leadId: leadA.leadId });
    expect(detail.request?.message).toBe("<script>alert(1)</script>");
    expect(detail.contacts?.[0]?.email).toBe(emailA);
    expect(detail.consents?.map((c) => c.status)).toEqual(["GRANTED"]);
    expect(detail.audit).toBeNull();
    expect(detail.allowedTransitions).toContain("QUOTE_REQUEST");

    const asAdmin = await getLeadDetail(admin, { leadId: leadA.leadId });
    expect(asAdmin.audit?.map((a) => a.action)).toEqual(
      expect.arrayContaining(["lead.created", "service_request.submitted"]),
    );
    const pm = await getLeadDetail(dispatcher, { leadId: leadB.leadId });
    expect(pm.request).toMatchObject({
      customerType: "PROPERTY_MANAGEMENT",
      numberOfProperties: 12,
    });
  });

  it("returns NOT_FOUND for unknown ids and VALIDATION_FAILED for malformed ids", async () => {
    await expectDomainError(getLeadDetail(dispatcher, { leadId: randomUUID() }), "NOT_FOUND");
    await expectDomainError(getLeadDetail(dispatcher, { leadId: "1 OR 1=1" }), "VALIDATION_FAILED");
  });
});

describe("RBAC and IDOR for the back office", () => {
  it("denies lead data to CUSTOMER, STAFF, PARTNER and FINANCE; anonymous is UNAUTHENTICATED", async () => {
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
        baseLatitude: 0,
        baseLongitude: 0,
        serviceRadiusM: 1000,
      })
      .returning({ id: schema.partner.id });
    const denied = [
      await contextForRole(db, "CUSTOMER", { customerId }),
      await contextForRole(db, "STAFF"),
      await contextForRole(db, "PARTNER", { partnerId: partner?.id ?? "" }),
      await contextForRole(db, "FINANCE"),
    ];
    for (const ctx of denied) {
      await expectDomainError(listLeads(ctx, {}), "FORBIDDEN");
      await expectDomainError(getLeadDetail(ctx, { leadId: leadA.leadId }), "FORBIDDEN");
      await expectDomainError(
        transitionLead(ctx, { leadId: leadA.leadId, to: "RESEARCHING" }),
        "FORBIDDEN",
      );
    }
    await expectDomainError(listLeads(anonymousContext(db), {}), "UNAUTHENTICATED");
  });

  it("blocks ADMIN without MFA and allows SUPER_ADMIN", async () => {
    await expectDomainError(
      listLeads(await contextForRole(db, "ADMIN", { mfa: false }), {}),
      "MFA_REQUIRED",
    );
    expect((await listLeads(await contextForRole(db, "SUPER_ADMIN"), { q: marker })).total).toBe(2);
  });
});

describe("status changes via the state machine", () => {
  it("records user, time, previous/new status, reason and audit", async () => {
    await transitionLead(dispatcher, { leadId: leadB.leadId, to: "RESEARCHING" });
    await transitionLead(dispatcher, {
      leadId: leadB.leadId,
      to: "LOST",
      reason: "Kein Bedarf mehr (Testdaten)",
    });
    const detail = await getLeadDetail(admin, { leadId: leadB.leadId });
    expect(detail.lead.status).toBe("LOST");
    expect(detail.history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual([
      "RESEARCHING>LOST",
      "DISCOVERED>RESEARCHING",
    ]);
    expect(detail.history[0]?.reason).toBe("Kein Bedarf mehr (Testdaten)");
    expect(detail.history[0]?.actorName).toBe("Test User");
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, leadB.leadId),
          eq(schema.auditLog.action, "lead.status_changed"),
        ),
      );
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actorId === dispatcher.actor.userId)).toBe(true);
  });

  it("rejects forged statuses and direct field writes", async () => {
    await expectDomainError(
      transitionLead(dispatcher, { leadId: leadA.leadId, to: "WON" }),
      "INVALID_STATE_TRANSITION",
    );
    await expectDomainError(
      transitionLead(dispatcher, { leadId: leadA.leadId, to: "HACKED" }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      transitionLead(dispatcher, {
        leadId: leadA.leadId,
        to: "RESEARCHING",
        ownerUserId: admin.actor.userId,
      }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      transitionLead(dispatcher, { leadId: leadB.leadId, to: "FOLLOW_UP" }),
      "VALIDATION_FAILED",
    );
  });
});
