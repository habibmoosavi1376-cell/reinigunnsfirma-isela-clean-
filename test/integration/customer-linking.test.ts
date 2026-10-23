import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadActor } from "@isela/auth";
import {
  assessLandingPage,
  createServiceArea,
  listPublishedLandingPageSlugs,
  publishLandingPage,
  setServiceAreaActive,
} from "@isela/catalog";
import {
  getEffectiveConsent,
  getLeadDetail,
  linkAccountToCustomer,
  linkLeadToCustomer,
  listCustomerServiceRequests,
  registerCustomer,
  submitServiceRequest,
  withdrawLeadContactConsent,
} from "@isela/crm";
import { and, count, eq, schema, sql } from "@isela/database";
import { systemClock } from "@isela/shared";
import { expectDomainError } from "../support/assertions.ts";
import {
  TEST_CRM_CONFIG,
  contextForRole,
  createUser,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

type Ctx = Awaited<ReturnType<typeof contextForRole>>;
let dispatcher: Ctx;
let admin: Ctx;

let counter = 0;
async function submitLead(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return submitServiceRequest(
    {
      customerType: "PRIVATE",
      fullName: "Testdaten Kundin",
      email: uniqueEmail("link"),
      street: "Testweg",
      houseNumber: "2",
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
      clientKey: `192.0.2.${String(counter)}-link`,
      rateLimitPerHour: 50,
    },
  );
}

async function customerCount() {
  const [row] = await db.select({ n: count() }).from(schema.customer);
  return row?.n ?? 0;
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
});

describe("lead → customer linking with duplicate detection", () => {
  it("creates a customer once and resolves spelling variants to the same record", async () => {
    const email = uniqueEmail("dup");
    const first = await submitLead({ email });
    const created = await linkLeadToCustomer(dispatcher, { leadId: first.leadId }, TEST_CRM_CONFIG);
    expect(created.outcome).toBe("CREATED");

    const before = await customerCount();
    const second = await submitLead({ email: email.toUpperCase() });
    const matched = await linkLeadToCustomer(
      dispatcher,
      { leadId: second.leadId },
      TEST_CRM_CONFIG,
    );
    expect(matched).toMatchObject({
      outcome: "EXISTING_CUSTOMER",
      customerId: created.customerId,
      matchedBy: "EMAIL",
    });
    expect(await customerCount()).toBe(before);

    expect(
      await linkLeadToCustomer(dispatcher, { leadId: second.leadId }, TEST_CRM_CONFIG),
    ).toEqual({
      outcome: "ALREADY_LINKED",
      customerId: created.customerId,
    });
  });

  it("matches by tax id and payment reference despite formatting differences", async () => {
    const tax = `DE${String(Date.now()).slice(-9)}`;
    const iban = `DE89 3704 0044 ${String(Date.now()).slice(-4)} 0130 00`;
    const a = await submitLead({
      customerType: "BUSINESS",
      companyName: "Muster GmbH (Testdaten)",
    });
    const created = await linkLeadToCustomer(
      dispatcher,
      { leadId: a.leadId, taxId: tax, paymentReference: iban },
      TEST_CRM_CONFIG,
    );
    expect(created.outcome).toBe("CREATED");

    const b = await submitLead({ customerType: "BUSINESS", companyName: "Muster G.m.b.H." });
    expect(
      await linkLeadToCustomer(
        dispatcher,
        { leadId: b.leadId, taxId: `${tax.slice(0, 2)} ${tax.slice(2, 5)}.${tax.slice(5)}` },
        TEST_CRM_CONFIG,
      ),
    ).toMatchObject({
      outcome: "EXISTING_CUSTOMER",
      customerId: created.customerId,
      matchedBy: "TAX_ID",
    });

    const c = await submitLead({ customerType: "BUSINESS", companyName: "Andere Schreibweise" });
    expect(
      await linkLeadToCustomer(
        dispatcher,
        { leadId: c.leadId, paymentReference: iban.replace(/\s/g, "").toLowerCase() },
        TEST_CRM_CONFIG,
      ),
    ).toMatchObject({
      outcome: "EXISTING_CUSTOMER",
      customerId: created.customerId,
      matchedBy: "PAYMENT_REFERENCE",
    });
  });

  it("refuses identities that belong to different customers (manual review)", async () => {
    const emailOfX = uniqueEmail("owner-x");
    const leadX = await submitLead({ email: emailOfX });
    const x = await linkLeadToCustomer(dispatcher, { leadId: leadX.leadId }, TEST_CRM_CONFIG);
    const taxOfY = `TY${randomUUID().slice(0, 10)}`;
    const y = await registerCustomer(
      dispatcher,
      { kind: "BUSINESS", displayName: "Y", companyName: "Y GmbH (Testdaten)", taxId: taxOfY },
      TEST_CRM_CONFIG,
    );
    expect(y.customerId).not.toBe(x.customerId);

    const before = await customerCount();
    const mixed = await submitLead({
      email: emailOfX,
      customerType: "BUSINESS",
      companyName: "Z GmbH",
    });
    await expectDomainError(
      linkLeadToCustomer(dispatcher, { leadId: mixed.leadId, taxId: taxOfY }, TEST_CRM_CONFIG),
      "CONFLICT",
    );
    // Nothing was created or linked (transaction rolled back).
    expect(await customerCount()).toBe(before);
    const [row] = await db
      .select({ customerId: schema.serviceRequest.customerId })
      .from(schema.serviceRequest)
      .where(eq(schema.serviceRequest.id, mixed.requestId));
    expect(row?.customerId).toBeNull();
  });

  it("never accepts a customer id, user id or status from the caller", async () => {
    const lead = await submitLead();
    for (const forged of [{ customerId: randomUUID() }, { userId: "u" }, { status: "WON" }]) {
      await expectDomainError(
        linkLeadToCustomer(dispatcher, { leadId: lead.leadId, ...forged }, TEST_CRM_CONFIG),
        "VALIDATION_FAILED",
      );
      await expectDomainError(
        linkAccountToCustomer(admin, { leadId: lead.leadId, ...forged }, TEST_CRM_CONFIG),
        "VALIDATION_FAILED",
      );
    }
  });

  it("requires customer:create; roles without it cannot link", async () => {
    const lead = await submitLead();
    await expectDomainError(
      linkLeadToCustomer(
        await contextForRole(db, "STAFF"),
        { leadId: lead.leadId },
        TEST_CRM_CONFIG,
      ),
      "FORBIDDEN",
    );
    await expectDomainError(
      linkLeadToCustomer(
        await contextForRole(db, "FINANCE"),
        { leadId: lead.leadId },
        TEST_CRM_CONFIG,
      ),
      "FORBIDDEN",
    );
  });
});

describe("account ↔ customer linking", () => {
  it("links only a verified account whose e-mail is an identity of the customer (audited)", async () => {
    const email = uniqueEmail("acct");
    const lead = await submitLead({ email });
    await expectDomainError(
      linkAccountToCustomer(admin, { leadId: lead.leadId }, TEST_CRM_CONFIG),
      "INVALID_STATE_TRANSITION",
    );
    const { customerId } = await linkLeadToCustomer(
      dispatcher,
      { leadId: lead.leadId },
      TEST_CRM_CONFIG,
    );

    await expectDomainError(
      linkAccountToCustomer(admin, { leadId: lead.leadId }, TEST_CRM_CONFIG),
      "NOT_FOUND",
    );
    const unverified = await createUser(db, { email, emailVerified: false });
    await expectDomainError(
      linkAccountToCustomer(admin, { leadId: lead.leadId }, TEST_CRM_CONFIG),
      "NOT_FOUND",
    );
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, unverified));

    // DISPATCHER may prepare leads but not grant account access.
    await expectDomainError(
      linkAccountToCustomer(dispatcher, { leadId: lead.leadId }, TEST_CRM_CONFIG),
      "FORBIDDEN",
    );
    await expectDomainError(
      linkAccountToCustomer(
        await contextForRole(db, "ADMIN", { mfa: false }),
        { leadId: lead.leadId },
        TEST_CRM_CONFIG,
      ),
      "MFA_REQUIRED",
    );

    expect(await linkAccountToCustomer(admin, { leadId: lead.leadId }, TEST_CRM_CONFIG)).toEqual({
      outcome: "LINKED",
      customerId,
      userId: unverified,
    });
    expect(
      await linkAccountToCustomer(admin, { leadId: lead.leadId }, TEST_CRM_CONFIG),
    ).toMatchObject({ outcome: "ALREADY_LINKED" });

    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, customerId),
          eq(schema.auditLog.action, "customer.account_linked"),
        ),
      );
    expect(audit?.actorId).toBe(admin.actor.userId);
    expect(JSON.stringify(audit)).not.toContain(email);

    // The linked account sees only its own requests (Customer ↔ Lead IDOR).
    const customerActor = await loadActor(db, unverified);
    const customerCtx = { db, actor: customerActor, clock: systemClock };
    expect(
      (await listCustomerServiceRequests(customerCtx, { customerId })).map((r) => r.id),
    ).toContain(lead.requestId);
    const other = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Andere" },
      TEST_CRM_CONFIG,
    );
    await expectDomainError(
      listCustomerServiceRequests(customerCtx, { customerId: other.customerId }),
      "FORBIDDEN",
    );
    await expectDomainError(getLeadDetail(customerCtx, { leadId: lead.leadId }), "FORBIDDEN");
  });

  it("keeps the existing customer (and its history) when a returning person opens a new account", async () => {
    const email = uniqueEmail("returning");
    const existing = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Bestandskundin (Testdaten)", email },
      TEST_CRM_CONFIG,
    );
    await db
      .update(schema.customer)
      .set({ status: "BLOCKED" })
      .where(eq(schema.customer.id, existing.customerId));

    const newAccount = await createUser(db, { email, emailVerified: true });
    const lead = await submitLead({ email });
    const linked = await linkLeadToCustomer(dispatcher, { leadId: lead.leadId }, TEST_CRM_CONFIG);
    expect(linked).toMatchObject({ outcome: "EXISTING_CUSTOMER", customerId: existing.customerId });
    expect(
      await linkAccountToCustomer(admin, { leadId: lead.leadId }, TEST_CRM_CONFIG),
    ).toMatchObject({ outcome: "LINKED", userId: newAccount });
    const [customer] = await db
      .select({ status: schema.customer.status })
      .from(schema.customer)
      .where(eq(schema.customer.id, existing.customerId));
    expect(customer?.status).toBe("BLOCKED");
  });

  it("allows at most one customer per account", async () => {
    const email = uniqueEmail("single");
    const userId = await createUser(db, { email, emailVerified: true });
    const other = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Anderer Kunde" },
      TEST_CRM_CONFIG,
    );
    await db
      .insert(schema.userRole)
      .values({ userId, roleKey: "CUSTOMER", customerId: other.customerId });
    const lead = await submitLead({ email });
    await linkLeadToCustomer(dispatcher, { leadId: lead.leadId }, TEST_CRM_CONFIG);
    await expectDomainError(
      linkAccountToCustomer(admin, { leadId: lead.leadId }, TEST_CRM_CONFIG),
      "CONFLICT",
    );
    // The database enforces the same rule.
    const second = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Dritter" },
      TEST_CRM_CONFIG,
    );
    await expect(
      db
        .insert(schema.userRole)
        .values({ userId, roleKey: "CUSTOMER", customerId: second.customerId }),
    ).rejects.toThrow();
  });

  it("refuses accounts whose e-mail is not an identity of the matched customer", async () => {
    const tax = `PV${randomUUID().slice(0, 10)}`;
    const owner = await registerCustomer(
      dispatcher,
      { kind: "BUSINESS", displayName: "Firma", companyName: "Firma GmbH", taxId: tax },
      TEST_CRM_CONFIG,
    );
    const email = uniqueEmail("foreign");
    await createUser(db, { email, emailVerified: true });
    const lead = await submitLead({ email, customerType: "BUSINESS", companyName: "Firma GmbH" });
    const linked = await linkLeadToCustomer(
      dispatcher,
      { leadId: lead.leadId, taxId: tax },
      TEST_CRM_CONFIG,
    );
    // The lead matched the company via tax id, but the new e-mail becomes no identity of it.
    expect(linked.customerId).toBe(owner.customerId);
    await expectDomainError(
      linkAccountToCustomer(admin, { leadId: lead.leadId }, TEST_CRM_CONFIG),
      "POLICY_VIOLATION",
    );
  });
});

describe("consent in the back office", () => {
  it("records a withdrawal as a new immutable record and keeps the history", async () => {
    const lead = await submitLead({
      marketingConsent: true,
      marketingConsentTextVersion: "mk-test-2",
    });
    const detail = await getLeadDetail(dispatcher, { leadId: lead.leadId });
    const contactId = detail.contacts?.[0]?.id ?? "";
    await withdrawLeadContactConsent(dispatcher, { contactId, purpose: "MARKETING_EMAIL" });
    expect(
      await getEffectiveConsent(dispatcher, {
        subject: { subjectType: "LEAD_CONTACT", subjectId: contactId },
        purpose: "MARKETING_EMAIL",
      }),
    ).toBe("WITHDRAWN");
    const after = await getLeadDetail(dispatcher, { leadId: lead.leadId });
    expect(after.consents?.map((c) => c.status)).toEqual(["WITHDRAWN", "GRANTED"]);
    expect(after.consents?.[0]).toMatchObject({
      source: "STAFF_RECORDED",
      textVersion: "mk-test-2",
    });
    expect(after.contacts?.[0]?.consentStatus).toBe("WITHDRAWN");
    await expectDomainError(
      withdrawLeadContactConsent(dispatcher, { contactId, purpose: "MARKETING_EMAIL" }),
      "INVALID_STATE_TRANSITION",
    );
    await expect(
      db.execute(sql`UPDATE consent SET status = 'GRANTED' WHERE subject_id = ${contactId}`),
    ).rejects.toThrow();
  });

  it("does not let unauthorised roles read or change consent data", async () => {
    const lead = await submitLead({
      marketingConsent: true,
      marketingConsentTextVersion: "mk-test-3",
    });
    const contactId =
      (await getLeadDetail(dispatcher, { leadId: lead.leadId })).contacts?.[0]?.id ?? "";
    await expectDomainError(
      withdrawLeadContactConsent(await contextForRole(db, "STAFF"), {
        contactId,
        purpose: "MARKETING_EMAIL",
      }),
      "FORBIDDEN",
    );
    await expectDomainError(
      getEffectiveConsent(await contextForRole(db, "STAFF"), {
        subject: { subjectType: "LEAD_CONTACT", subjectId: contactId },
        purpose: "MARKETING_EMAIL",
      }),
      "FORBIDDEN",
    );
  });
});

describe("landing pages are published only with real service, location, availability and content", () => {
  it("checks every condition in PostGIS and removes pages when an area is deactivated", async () => {
    const [category] = await db
      .select()
      .from(schema.serviceCategory)
      .where(eq(schema.serviceCategory.key, "office-cleaning"));
    const [city] = await db
      .insert(schema.city)
      .values({
        name: "Teststadt (Testdaten)",
        stateCode: "XX",
        centroid: sql`ST_SetSRID(ST_MakePoint(-60.5, -30.5), 4326)::geography`,
      })
      .returning({ id: schema.city.id });
    const [farCity] = await db
      .insert(schema.city)
      .values({
        name: "Fernstadt (Testdaten)",
        stateCode: "XX",
        centroid: sql`ST_SetSRID(ST_MakePoint(-10, -10), 4326)::geography`,
      })
      .returning({ id: schema.city.id });
    const areaId = await createServiceArea(admin, {
      kind: "CIRCLE",
      key: `lp-${randomUUID().slice(0, 6)}`,
      name: "Landingpage-Testgebiet",
      center: { latitude: -30.5, longitude: -60.5 },
      radiusM: 10_000,
    });
    const slug = `${category?.urlSlug ?? "x"}-teststadt-${randomUUID().slice(0, 4)}`;
    const [page] = await db
      .insert(schema.landingPage)
      .values({
        serviceCategoryId: category?.id ?? "",
        cityId: city?.id ?? "",
        serviceAreaId: areaId,
        slug,
      })
      .returning({ id: schema.landingPage.id });
    const pageId = page?.id ?? "";

    const initial = await assessLandingPage(dispatcher, { landingPageId: pageId });
    expect(initial.blockers).toEqual(
      expect.arrayContaining([
        "NO_ACTIVE_SERVICE",
        "SERVICE_AREA_INACTIVE",
        "CONTENT_MISSING",
        "CONTENT_NOT_REVIEWED",
      ]),
    );
    await expectDomainError(
      publishLandingPage(admin, { landingPageId: pageId }),
      "POLICY_VIOLATION",
    );
    await expect(
      db
        .update(schema.landingPage)
        .set({ status: "PUBLISHED" })
        .where(eq(schema.landingPage.id, pageId)),
    ).rejects.toThrow();

    await db.insert(schema.service).values({
      categoryId: category?.id ?? "",
      key: `svc-${randomUUID().slice(0, 6)}`,
      name: "Testleistung",
      unit: "HOUR",
    });
    await setServiceAreaActive(admin, { serviceAreaId: areaId, active: true });
    await db
      .update(schema.landingPage)
      .set({
        content: { headline: "Testinhalt" },
        contentReviewedAt: new Date(),
        contentReviewedByUserId: admin.actor.userId,
      })
      .where(eq(schema.landingPage.id, pageId));
    expect((await assessLandingPage(dispatcher, { landingPageId: pageId })).publishable).toBe(true);
    await expectDomainError(publishLandingPage(dispatcher, { landingPageId: pageId }), "FORBIDDEN");
    await publishLandingPage(admin, { landingPageId: pageId });
    expect(await listPublishedLandingPageSlugs(db)).toContain(slug);

    await setServiceAreaActive(admin, { serviceAreaId: areaId, active: false });
    expect(await listPublishedLandingPageSlugs(db)).not.toContain(slug);

    // A city outside the area can never be published for it.
    const [farPage] = await db
      .insert(schema.landingPage)
      .values({
        serviceCategoryId: category?.id ?? "",
        cityId: farCity?.id ?? "",
        serviceAreaId: areaId,
        slug: `${slug}-fern`,
      })
      .returning({ id: schema.landingPage.id });
    expect(
      (await assessLandingPage(dispatcher, { landingPageId: farPage?.id ?? "" })).blockers,
    ).toContain("CITY_OUTSIDE_SERVICE_AREA");
  });
});
