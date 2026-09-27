import { afterAll, describe, expect, it } from "vitest";
import { acceptInvitation, createInvitation, loadActor } from "@isela/auth";
import { registerCustomer } from "@isela/crm";
import { and, eq, schema } from "@isela/database";
import { systemClock } from "@isela/shared";
import { expectDomainError } from "../support/assertions.ts";
import {
  CapturingEmailSender,
  TEST_CRM_CONFIG,
  contextForRole,
  createUser,
  extractUrl,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

describe("invitation acceptance with an existing customer link", () => {
  it("fails loudly instead of silently dropping the role (one customer per account)", async () => {
    const admin = await contextForRole(db, "ADMIN");
    const dispatcher = await contextForRole(db, "DISPATCHER");
    const a = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "A (Testdaten)" },
      TEST_CRM_CONFIG,
    );
    const b = await registerCustomer(
      dispatcher,
      { kind: "PRIVATE", displayName: "B (Testdaten)" },
      TEST_CRM_CONFIG,
    );
    const email = uniqueEmail("invite-conflict");
    const userId = await createUser(db, { email, emailVerified: true });
    await db
      .insert(schema.userRole)
      .values({ userId, roleKey: "CUSTOMER", customerId: a.customerId });

    const sender = new CapturingEmailSender();
    await createInvitation(
      admin,
      { email, role: "CUSTOMER", customerId: b.customerId },
      { emailSender: sender, acceptUrl: (t) => `http://localhost/account/invitation?token=${t}` },
    );
    const token = extractUrl(sender.messages[0]!).searchParams.get("token") ?? "";
    const ctx = { db, actor: await loadActor(db, userId), clock: systemClock };
    await expectDomainError(acceptInvitation(ctx, { token }), "CONFLICT");

    const [invitation] = await db
      .select({ acceptedAt: schema.invitation.acceptedAt })
      .from(schema.invitation)
      .where(eq(schema.invitation.emailNormalized, email));
    expect(invitation?.acceptedAt).toBeNull();
    const roles = await db
      .select({ customerId: schema.userRole.customerId })
      .from(schema.userRole)
      .where(and(eq(schema.userRole.userId, userId), eq(schema.userRole.roleKey, "CUSTOMER")));
    expect(roles.map((r) => r.customerId)).toEqual([a.customerId]);
  });
});
