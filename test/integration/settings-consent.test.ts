import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEffectiveConsent, recordConsent, registerCustomer } from "@isela/crm";
import { and, eq, schema } from "@isela/database";
import { DEFAULT_PAYMENT_POLICY } from "@isela/payment-risk";
import { GLOBAL_SCOPE, getEffectiveSetting, updateSetting } from "@isela/settings";
import { expectDomainError } from "../support/assertions.ts";
import {
  TEST_CRM_CONFIG,
  TestClock,
  contextForRole,
  openTestDatabase,
} from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

type Ctx = Awaited<ReturnType<typeof contextForRole>>;

describe("payment policy settings", () => {
  const clock = new TestClock(new Date("2031-01-01T00:00:00Z"));
  let finance: Ctx;

  beforeAll(async () => {
    finance = await contextForRole(db, "FINANCE", {}, clock);
  });

  it("falls back to the documented default", async () => {
    const effective = await getEffectiveSetting(db, "payment.policy", GLOBAL_SCOPE, clock.now());
    expect(effective).toMatchObject({ source: "DEFAULT", value: DEFAULT_PAYMENT_POLICY });
  });

  it("stores a valid change as a new audited version", async () => {
    const value = { ...DEFAULT_PAYMENT_POLICY, minSuccessfulPaidOrders: 4 };
    const result = await updateSetting(finance, {
      key: "payment.policy",
      scopeType: "GLOBAL",
      value,
      changeReason: "4 Aufträge laut Freigabe",
    });
    expect(result.version).toBe(1);
    const effective = await getEffectiveSetting(db, "payment.policy", GLOBAL_SCOPE, clock.now());
    expect(effective.value.minSuccessfulPaidOrders).toBe(4);
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "setting.version_created"));
    expect(audit.length).toBeGreaterThan(0);
  });

  it("rejects unsafe policies and stores nothing", async () => {
    clock.advance(60_000);
    const before = await db
      .select()
      .from(schema.setting)
      .where(eq(schema.setting.key, "payment.policy"));
    for (const unsafe of [
      { minSuccessfulPaidOrders: 2 },
      { maxOpenOverdueInvoices: 1 },
      { revertToPrepaymentOnOverdue: false },
      { partialPaymentCountsAsPaid: true },
    ]) {
      await expectDomainError(
        updateSetting(finance, {
          key: "payment.policy",
          scopeType: "GLOBAL",
          value: { ...DEFAULT_PAYMENT_POLICY, ...unsafe },
          changeReason: "unsicher",
        }),
        "VALIDATION_FAILED",
      );
    }
    const after = await db
      .select()
      .from(schema.setting)
      .where(eq(schema.setting.key, "payment.policy"));
    expect(after.length).toBe(before.length);
  });

  it("closes the previous version when a new one starts", async () => {
    clock.advance(60_000);
    const start = new Date(clock.now().getTime() + 24 * 60 * 60 * 1000);
    await updateSetting(finance, {
      key: "payment.policy",
      scopeType: "GLOBAL",
      value: { ...DEFAULT_PAYMENT_POLICY, minSuccessfulPaidOrders: 3 },
      effectiveFrom: start.toISOString(),
      changeReason: "zurück auf 3",
    });
    expect(
      (await getEffectiveSetting(db, "payment.policy", GLOBAL_SCOPE, clock.now())).value
        .minSuccessfulPaidOrders,
    ).toBe(4);
    expect(
      (await getEffectiveSetting(db, "payment.policy", GLOBAL_SCOPE, new Date(start.getTime() + 1)))
        .value.minSuccessfulPaidOrders,
    ).toBe(3);
  });

  it("rejects retroactive changes, foreign scopes and unauthorized roles", async () => {
    await expectDomainError(
      updateSetting(finance, {
        key: "payment.policy",
        scopeType: "GLOBAL",
        value: DEFAULT_PAYMENT_POLICY,
        effectiveFrom: "2020-01-01T00:00:00Z",
        changeReason: "rückwirkend",
      }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      updateSetting(finance, {
        key: "payment.policy",
        scopeType: "CUSTOMER",
        scopeId: "11111111-1111-4111-8111-111111111111",
        value: DEFAULT_PAYMENT_POLICY,
        changeReason: "scope",
      }),
      "VALIDATION_FAILED",
    );
    const admin = await contextForRole(db, "ADMIN", {}, clock);
    await expectDomainError(
      updateSetting(admin, {
        key: "payment.policy",
        scopeType: "GLOBAL",
        value: DEFAULT_PAYMENT_POLICY,
        changeReason: "admin",
      }),
      "FORBIDDEN",
    );
    const financeWithoutMfa = await contextForRole(db, "FINANCE", { mfa: false }, clock);
    await expectDomainError(
      updateSetting(financeWithoutMfa, {
        key: "payment.policy",
        scopeType: "GLOBAL",
        value: DEFAULT_PAYMENT_POLICY,
        changeReason: "no mfa",
      }),
      "MFA_REQUIRED",
    );
    await expectDomainError(
      updateSetting(finance, {
        key: "unknown.key",
        scopeType: "GLOBAL",
        value: {},
        changeReason: "x",
      }),
      "VALIDATION_FAILED",
    );
  });
});

describe("consent", () => {
  it("records immutable consent history and derives the legal basis", async () => {
    const dispatcher = await contextForRole(db, "DISPATCHER");
    const { customerId } = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "Consent" },
      TEST_CRM_CONFIG,
    );
    const customer = await contextForRole(db, "CUSTOMER", { customerId });
    const subject = { subjectType: "CUSTOMER", subjectId: customerId };

    await recordConsent(customer, {
      subject,
      purpose: "REVIEW_REQUEST",
      status: "GRANTED",
      source: "CUSTOMER_PORTAL",
      textVersion: "2026-09",
    });
    expect(await getEffectiveConsent(customer, { subject, purpose: "REVIEW_REQUEST" })).toBe(
      "GRANTED",
    );
    await recordConsent(customer, {
      subject,
      purpose: "REVIEW_REQUEST",
      status: "WITHDRAWN",
      source: "CUSTOMER_PORTAL",
      textVersion: "2026-09",
    });
    expect(await getEffectiveConsent(customer, { subject, purpose: "REVIEW_REQUEST" })).toBe(
      "WITHDRAWN",
    );

    await recordConsent(customer, {
      subject,
      purpose: "COOKIES_ANALYTICS",
      status: "GRANTED",
      source: "COOKIE_BANNER",
      textVersion: "c1",
    });
    const rows = await db
      .select()
      .from(schema.consent)
      .where(and(eq(schema.consent.subjectId, customerId)));
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.purpose === "COOKIES_ANALYTICS")?.legalBasis).toBe("TDDDG_25_1");
    expect(rows.find((r) => r.purpose === "REVIEW_REQUEST")?.legalBasis).toBe("GDPR_ART6_1A");
  });

  it("prevents recording consent for other customers and mislabelled legal bases", async () => {
    const dispatcher = await contextForRole(db, "DISPATCHER");
    const a = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "A" },
      TEST_CRM_CONFIG,
    );
    const b = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "B" },
      TEST_CRM_CONFIG,
    );
    const customerA = await contextForRole(db, "CUSTOMER", { customerId: a.customerId });
    const subjectB = { subjectType: "CUSTOMER", subjectId: b.customerId };
    await expectDomainError(
      recordConsent(customerA, {
        subject: subjectB,
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "CUSTOMER_PORTAL",
        textVersion: "v1",
      }),
      "FORBIDDEN",
    );
    await expectDomainError(
      recordConsent(customerA, {
        subject: { subjectType: "CUSTOMER", subjectId: a.customerId },
        purpose: "MARKETING_EMAIL",
        status: "GRANTED",
        source: "CUSTOMER_PORTAL",
        textVersion: "v1",
        legalBasis: "GDPR_ART6_1F",
      }),
      "VALIDATION_FAILED",
    );
  });
});
