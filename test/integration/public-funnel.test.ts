import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getPublicServicePage,
  listPublicServicePages,
  updateServiceCategory,
} from "@isela/catalog";
import {
  getLeadDetail,
  submitCallbackRequest,
  submitServiceRequest,
  transitionLead,
} from "@isela/crm";
import { count, eq, schema } from "@isela/database";
import { DEFAULT_OPERATIONS_CONFIG, createBookingFromQuote } from "@isela/operations";
import { getConversionReport, type ConversionReport } from "@isela/reporting";
import { systemClock } from "@isela/shared";
import { expectDomainError } from "../support/assertions.ts";
import {
  TEST_CRM_CONFIG,
  anonymousContext,
  contextForRole,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";
import {
  PAYMENT_POLICY,
  acceptedQuote,
  activeServiceArea,
  futureSlot,
  geocodedCustomer,
  payPrepayment,
  testService,
  type StaffCtx,
} from "../support/operations.ts";

/*
 * Day 7: public conversion funnel – idempotent form submissions, callback requests, public
 * service pages and the conversion report. All records are test data.
 */

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

// Remote test coordinates (no overlap with other test areas; test data only).
const CENTER = { latitude: -45.87, longitude: 170.5 };
const OPTIONS = { paymentPolicy: PAYMENT_POLICY, config: DEFAULT_OPERATIONS_CONFIG };

let dispatcher: StaffCtx;
let admin: StaffCtx;
let finance: StaffCtx;
let clientCounter = 0;

function token(): string {
  return randomBytes(24).toString("base64url");
}

function deps(rateLimitPerHour = 50) {
  clientCounter += 1;
  return {
    db,
    clock: systemClock,
    config: TEST_CRM_CONFIG,
    requester: null,
    clientKey: `203.0.113.${String(clientCounter)}-d7`,
    rateLimitPerHour,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    customerType: "PRIVATE",
    fullName: "Anfrage Testdaten",
    email: uniqueEmail("d7-request"),
    street: "Testweg",
    houseNumber: "7",
    postalCode: "12345",
    city: "Teststadt",
    serviceCategoryKey: "apartment-cleaning",
    propertyType: "APARTMENT",
    frequency: "ONCE",
    privacyNoticeAcknowledged: true,
    privacyNoticeVersion: "test-v1",
    ...overrides,
  };
}

let phoneCounter = 1000;
function callback(overrides: Record<string, unknown> = {}) {
  phoneCounter += 1;
  return {
    customerType: "BUSINESS",
    fullName: "Rückruf Testdaten",
    phone: `+49 30 555${String(phoneCounter)}`,
    privacyNoticeAcknowledged: true,
    privacyNoticeVersion: "test-v1",
    ...overrides,
  };
}

async function leadCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(schema.lead);
  return row?.n ?? 0;
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  finance = await contextForRole(db, "FINANCE");
});

describe("duplicate-safe service requests", () => {
  it("stores a repeated submission of the same form only once", async () => {
    const input = request({ submissionToken: token() });
    const before = await leadCount();
    const first = await submitServiceRequest(input, deps());
    const second = await submitServiceRequest(input, deps());
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({
      duplicate: true,
      requestId: first.requestId,
      leadId: first.leadId,
    });
    expect(await leadCount()).toBe(before + 1);
  });

  it("stores concurrent double submits of one form only once", async () => {
    const input = request({ submissionToken: token() });
    const before = await leadCount();
    const results = await Promise.all([
      submitServiceRequest(input, deps()),
      submitServiceRequest(input, deps()),
      submitServiceRequest(input, deps()),
    ]);
    expect(new Set(results.map((r) => r.requestId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await leadCount()).toBe(before + 1);
  });

  it("does not consume the rate limit for a duplicate", async () => {
    const input = request({ submissionToken: token() });
    const limited = deps(1);
    await submitServiceRequest(input, limited);
    // Same client, limit 1/hour: a NEW form is rejected, the duplicate is still answered.
    await expect(submitServiceRequest(input, limited)).resolves.toMatchObject({ duplicate: true });
    await expectDomainError(
      submitServiceRequest(request({ submissionToken: token() }), limited),
      "RATE_LIMITED",
    );
  });

  it("treats different forms of the same person as separate requests", async () => {
    const email = uniqueEmail("d7-two-forms");
    const a = await submitServiceRequest(request({ email, submissionToken: token() }), deps());
    const b = await submitServiceRequest(request({ email, submissionToken: token() }), deps());
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("stores only a keyed hash of the token", async () => {
    const plain = token();
    const result = await submitServiceRequest(request({ submissionToken: plain }), deps());
    const [row] = await db
      .select({ hash: schema.serviceRequest.submissionKeyHash })
      .from(schema.serviceRequest)
      .where(eq(schema.serviceRequest.id, result.requestId));
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.hash).not.toContain(plain);
  });

  it("rejects malformed tokens", async () => {
    await expectDomainError(
      submitServiceRequest(request({ submissionToken: "short" }), deps()),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      submitServiceRequest(request({ submissionToken: `${"a".repeat(30)}<script>` }), deps()),
      "VALIDATION_FAILED",
    );
  });
});

describe("callback requests", () => {
  it("stores lead, contact (phone only) and callback details without promising a time", async () => {
    const result = await submitCallbackRequest(
      callback({
        serviceCategoryKey: "office-cleaning",
        postalCode: "45879",
        preferredWindow: "MORNING",
        message: "Bitte vormittags anrufen.",
        submissionToken: token(),
      }),
      deps(),
    );
    expect(result.duplicate).toBe(false);
    const detail = await getLeadDetail(dispatcher, { leadId: result.leadId });
    expect(detail.callback).toMatchObject({
      customerType: "BUSINESS",
      serviceName: "Büroreinigung",
      postalCode: "45879",
      preferredWindow: "MORNING",
    });
    expect(detail.request).toBeNull();
    expect(detail.contacts?.[0]).toMatchObject({
      email: null,
      legalBasis: "GDPR_ART6_1B_CONTRACT",
    });
    expect(detail.contacts?.[0]?.phone).toMatch(/^\+49/);

    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, result.callbackRequestId));
    expect(audit?.action).toBe("callback_request.submitted");
    // No contact data in the audit trail.
    expect(JSON.stringify(audit)).not.toMatch(/555|Rückruf Testdaten/);
  });

  it("is idempotent per form", async () => {
    const input = callback({ submissionToken: token() });
    const first = await submitCallbackRequest(input, deps());
    const second = await submitCallbackRequest(input, deps());
    expect(second).toEqual({ ...first, duplicate: true });
  });

  it("validates strictly", async () => {
    await expectDomainError(
      submitCallbackRequest(callback({ phone: "keine nummer" }), deps()),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      submitCallbackRequest(callback({ privacyNoticeAcknowledged: false }), deps()),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      submitCallbackRequest(callback({ serviceCategoryKey: "does-not-exist" }), deps()),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      submitCallbackRequest(callback({ postalCode: "ABC" }), deps()),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      submitCallbackRequest(callback({ message: "x".repeat(501) }), deps()),
      "VALIDATION_FAILED",
    );
    // Mass assignment: unknown fields are rejected, not ignored.
    await expectDomainError(
      submitCallbackRequest(callback({ status: "WON" }), deps()),
      "VALIDATION_FAILED",
    );
  });

  it("limits callbacks per phone number", async () => {
    const phone = "+49 30 5559999";
    for (let i = 0; i < 3; i += 1) {
      await submitCallbackRequest(callback({ phone }), deps());
    }
    await expectDomainError(submitCallbackRequest(callback({ phone }), deps()), "RATE_LIMITED");
  });
});

describe("public service pages", () => {
  it("lists active categories with slug and gates indexing on a real description", async () => {
    const [category] = await db
      .select({ id: schema.serviceCategory.id })
      .from(schema.serviceCategory)
      .where(eq(schema.serviceCategory.key, "window-cleaning"));
    const categoryId = category?.id ?? "";
    await updateServiceCategory(admin, { categoryId, description: "Kurz." });
    expect((await getPublicServicePage(db, "fensterreinigung"))?.indexable).toBe(false);

    const description =
      "Testbeschreibung (Testdaten): Reinigung von Glasflächen, Rahmen und Fensterbänken innen und außen. Der genaue Umfang wird im Angebot festgelegt.";
    await updateServiceCategory(admin, { categoryId, description });
    const page = await getPublicServicePage(db, "fensterreinigung");
    expect(page).toMatchObject({ name: "Fensterreinigung", indexable: true, description });
    // Only public fields – no ids, prices or internal settings.
    expect(Object.keys(page ?? {}).sort()).toEqual(
      ["description", "indexable", "key", "name", "services", "urlSlug"].sort(),
    );
    const pages = await listPublicServicePages(db);
    expect(pages.find((p) => p.urlSlug === "fensterreinigung")?.indexable).toBe(true);
    await updateServiceCategory(admin, { categoryId, description: "" });
  });

  it("returns null for unknown, malformed and inactive pages", async () => {
    expect(await getPublicServicePage(db, "gibt-es-nicht")).toBeNull();
    expect(await getPublicServicePage(db, "../admin")).toBeNull();
    expect(await getPublicServicePage(db, "Fensterreinigung")).toBeNull();
    const [category] = await db
      .select({ id: schema.serviceCategory.id })
      .from(schema.serviceCategory)
      .where(eq(schema.serviceCategory.key, "holiday-rental-cleaning"));
    await updateServiceCategory(admin, { categoryId: category?.id ?? "", active: false });
    expect(await getPublicServicePage(db, "ferienwohnungsreinigung")).toBeNull();
    expect((await listPublicServicePages(db)).map((p) => p.urlSlug)).not.toContain(
      "ferienwohnungsreinigung",
    );
    await updateServiceCategory(admin, { categoryId: category?.id ?? "", active: true });
  });

  it("lists only active services of the category", async () => {
    const { serviceId } = await testService(admin, db);
    const page = await getPublicServicePage(db, "wohnungsreinigung");
    expect(page?.services.map((s) => s.name)).toContain("Testleistung Wohnung");
    expect(serviceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("conversion report", () => {
  const range = () => {
    const now = Date.now();
    return { from: new Date(now - 3_600_000), to: new Date(now + 3_600_000) };
  };
  const value = (report: ConversionReport, key: string) =>
    report.metrics.find((m) => m.key === key)?.value;

  it("requires report:read", async () => {
    await expectDomainError(
      getConversionReport(anonymousContext(db), range(), { environment: "test" }),
      "UNAUTHENTICATED",
    );
    for (const role of ["DISPATCHER", "STAFF"] as const) {
      const ctx = await contextForRole(db, role);
      await expectDomainError(
        getConversionReport(ctx, range(), { environment: "test" }),
        "FORBIDDEN",
      );
    }
  });

  it("validates the range", async () => {
    const now = Date.now();
    await expectDomainError(
      getConversionReport(
        finance,
        { from: new Date(now), to: new Date(now - 1000) },
        { environment: "test" },
      ),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      getConversionReport(
        finance,
        { from: new Date(now - 500 * 86_400_000), to: new Date(now) },
        { environment: "test" },
      ),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      getConversionReport(finance, { ...range(), extra: 1 }, { environment: "test" }),
      "VALIDATION_FAILED",
    );
  });

  it("counts real records, marks unmeasured figures and never invents ratios", async () => {
    const before = await getConversionReport(finance, range(), { environment: "test" });
    expect(before.realData).toBe(false);
    expect(before.metrics.find((m) => m.key === "pageVisits")).toEqual({
      key: "pageVisits",
      value: null,
      source: "NOT_MEASURED",
    });
    expect(value(before, "requestsStarted")).toBeNull();

    const requestToken = token();
    const submitted = await submitServiceRequest(
      request({ submissionToken: requestToken }),
      deps(),
    );
    await submitServiceRequest(request({ submissionToken: requestToken }), deps()); // duplicate
    await submitCallbackRequest(callback(), deps());
    await transitionLead(dispatcher, { leadId: submitted.leadId, to: "QUALIFIED" });

    await activeServiceArea(admin, CENTER);
    const ids = await testService(admin, db);
    const owner = await geocodedCustomer(db, dispatcher, CENTER);
    const quoteId = await acceptedQuote(dispatcher, admin, { ...owner, ...ids });
    const { bookingId } = await createBookingFromQuote(
      dispatcher,
      { quoteId, ...futureSlot(30) },
      OPTIONS,
    );
    await payPrepayment(finance, bookingId);
    const secondQuote = await acceptedQuote(dispatcher, admin, { ...owner, ...ids });
    await createBookingFromQuote(dispatcher, { quoteId: secondQuote, ...futureSlot(31) }, OPTIONS);

    const after = await getConversionReport(finance, range(), { environment: "production" });
    const delta = (key: string) => (value(after, key) ?? 0) - (value(before, key) ?? 0);
    // geocodedCustomer submits one more website request of its own.
    expect(delta("requestsSubmitted")).toBe(2);
    expect(delta("callbacksRequested")).toBe(1);
    expect(delta("qualifiedLeads")).toBe(1);
    expect(delta("quotesSent")).toBe(2);
    expect(delta("quotesAccepted")).toBe(2);
    expect(delta("bookingsCreated")).toBe(2);
    expect(delta("paidBookings")).toBe(1);
    expect(delta("repeatCustomers")).toBe(1);
    expect(after.realData).toBe(true);
    expect(after.metrics.find((m) => m.key === "pageVisits")?.source).toBe("NOT_MEASURED");
  });

  it("returns no ratio when the denominator is zero", async () => {
    const empty = await getConversionReport(
      finance,
      { from: new Date("2001-01-01T00:00:00Z"), to: new Date("2001-01-02T00:00:00Z") },
      { environment: "test" },
    );
    expect(empty.ratios.every((r) => r.value === null)).toBe(true);
    expect(value(empty, "requestsSubmitted")).toBe(0);
  });
});
