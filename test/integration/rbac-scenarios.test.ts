import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvitation, isAuthorized } from "@isela/auth";
import { getCustomer, getLeadOverview, registerCustomer } from "@isela/crm";
import { schema } from "@isela/database";
import { getPartner } from "@isela/partners";
import { DEFAULT_PAYMENT_POLICY } from "@isela/payment-risk";
import { updateSetting } from "@isela/settings";
import { expectDomainError } from "../support/assertions.ts";
import {
  CapturingEmailSender,
  TEST_CRM_CONFIG,
  TestClock,
  contextForRole,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";

/*
 * Explicit role scenarios from the Day-2 brief, executed against the real services and
 * database (server-side authorization; nothing depends on UI hiding).
 */

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

const invitationDeps = {
  emailSender: new CapturingEmailSender(),
  acceptUrl: (token: string) => `http://localhost/invitation?token=${token}`,
};
// Only unauthorized settings writes are attempted here (they never reach the database).
const clock = new TestClock();
const policyChange = (reason: string) => ({
  key: "payment.policy",
  scopeType: "GLOBAL",
  value: DEFAULT_PAYMENT_POLICY,
  changeReason: reason,
});

type Ctx = Awaited<ReturnType<typeof contextForRole>>;
let customerA: string;
let customerB: string;
let partnerA: string;
let partnerB: string;
let customerUser: Ctx;

beforeAll(async () => {
  const dispatcher = await contextForRole(db, "DISPATCHER");
  customerA = (
    await registerCustomer(dispatcher, { kind: "PRIVATE", displayName: "A" }, TEST_CRM_CONFIG)
  ).customerId;
  customerB = (
    await registerCustomer(dispatcher, { kind: "PRIVATE", displayName: "B" }, TEST_CRM_CONFIG)
  ).customerId;
  const partners = await db
    .insert(schema.partner)
    .values([
      {
        legalName: "Partner A (Testdaten)",
        status: "ACTIVE",
        verifiedAt: new Date(),
        verifiedByUserId: "test-verifier",
        baseLatitude: 51,
        baseLongitude: 7,
        serviceRadiusM: 10_000,
      },
      {
        legalName: "Partner B (Testdaten)",
        status: "ACTIVE",
        verifiedAt: new Date(),
        verifiedByUserId: "test-verifier",
        baseLatitude: 51.1,
        baseLongitude: 7.1,
        serviceRadiusM: 10_000,
      },
    ])
    .returning({ id: schema.partner.id });
  partnerA = partners[0]?.id ?? "";
  partnerB = partners[1]?.id ?? "";
  customerUser = await contextForRole(db, "CUSTOMER", { customerId: customerA }, clock);
});

describe("CUSTOMER", () => {
  it("cannot see other customers", async () => {
    expect((await getCustomer(customerUser, { customerId: customerA })).id).toBe(customerA);
    await expectDomainError(getCustomer(customerUser, { customerId: customerB }), "FORBIDDEN");
  });

  it("cannot call admin functions", async () => {
    await expectDomainError(getLeadOverview(customerUser), "FORBIDDEN");
    await expectDomainError(updateSetting(customerUser, policyChange("customer")), "FORBIDDEN");
    await expectDomainError(
      createInvitation(customerUser, { email: uniqueEmail(), role: "STAFF" }, invitationDeps),
      "FORBIDDEN",
    );
    await expectDomainError(
      registerCustomer(customerUser, { kind: "PRIVATE", displayName: "x" }, TEST_CRM_CONFIG),
      "FORBIDDEN",
    );
  });
});

describe("STAFF", () => {
  it("cannot take over finance administration", async () => {
    const staff = await contextForRole(db, "STAFF", {}, clock);
    await expectDomainError(updateSetting(staff, policyChange("staff")), "FORBIDDEN");
    await expectDomainError(getCustomer(staff, { customerId: customerA }), "FORBIDDEN");
  });
});

describe("PARTNER", () => {
  it("can read its own partner but not manage other partners", async () => {
    const partnerUser = await contextForRole(db, "PARTNER", {
      partnerId: partnerA,
      isScopeAdmin: true,
    });
    expect((await getPartner(partnerUser, { partnerId: partnerA })).id).toBe(partnerA);
    await expectDomainError(getPartner(partnerUser, { partnerId: partnerB }), "FORBIDDEN");
    await expectDomainError(
      createInvitation(
        partnerUser,
        { email: uniqueEmail(), role: "PARTNER", partnerId: partnerB },
        invitationDeps,
      ),
      "FORBIDDEN",
    );
    await createInvitation(
      partnerUser,
      { email: uniqueEmail(), role: "PARTNER", partnerId: partnerA },
      invitationDeps,
    );
  });
});

describe("FINANCE", () => {
  it("manages the payment policy but cannot grant roles", async () => {
    const finance = await contextForRole(db, "FINANCE", {}, clock);
    // Positive write path is covered in settings-consent.test.ts (no overlapping versions here).
    expect(isAuthorized(finance.actor, "payment_policy:manage")).toBe(true);
    await expectDomainError(
      createInvitation(finance, { email: uniqueEmail(), role: "STAFF" }, invitationDeps),
      "FORBIDDEN",
    );
    await expectDomainError(
      createInvitation(finance, { email: uniqueEmail(), role: "FINANCE" }, invitationDeps),
      "FORBIDDEN",
    );
  });
});

describe("ADMIN", () => {
  it("performs allowed admin actions only", async () => {
    const admin = await contextForRole(db, "ADMIN", {}, clock);
    await createInvitation(admin, { email: uniqueEmail(), role: "DISPATCHER" }, invitationDeps);
    await expect(getLeadOverview(admin)).resolves.toBeDefined();
    await expectDomainError(
      createInvitation(admin, { email: uniqueEmail(), role: "ADMIN" }, invitationDeps),
      "FORBIDDEN",
    );
    await expectDomainError(
      createInvitation(admin, { email: uniqueEmail(), role: "SUPER_ADMIN" }, invitationDeps),
      "FORBIDDEN",
    );
    await expectDomainError(updateSetting(admin, policyChange("admin")), "FORBIDDEN");
  });

  it("is blocked entirely without MFA", async () => {
    const admin = await contextForRole(db, "ADMIN", { mfa: false }, clock);
    await expectDomainError(getLeadOverview(admin), "MFA_REQUIRED");
  });
});

describe("SUPER_ADMIN", () => {
  it("is the only role that can grant ADMIN and SUPER_ADMIN", async () => {
    const owner = await contextForRole(db, "SUPER_ADMIN", {}, clock);
    await createInvitation(owner, { email: uniqueEmail(), role: "ADMIN" }, invitationDeps);
    await createInvitation(owner, { email: uniqueEmail(), role: "SUPER_ADMIN" }, invitationDeps);
    expect(isAuthorized(owner.actor, "payment_policy:manage")).toBe(true);
    await expect(getCustomer(owner, { customerId: customerB })).resolves.toBeDefined();
  });
});
