import { afterAll, describe, expect, it } from "vitest";
import {
  acceptInvitation,
  bootstrapSuperAdmin,
  createAuth,
  createInvitation,
  loadActor,
  revokeAllSessions,
  type ServiceContext,
} from "@isela/auth";
import { and, eq, schema } from "@isela/database";
import { systemClock } from "@isela/shared";
import { expectDomainError } from "../support/assertions.ts";
import { call, cookiesFrom, createTestAuth, jsonOf, totp } from "../support/auth-client.ts";
import {
  CapturingEmailSender,
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

const PASSWORD = "correct horse battery staple";

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (row === undefined) throw new Error("user not found");
  return row.id;
}

/** Signs up, verifies the e-mail through the real link and signs in. Returns the session cookie. */
async function registerVerifiedUser(
  testAuth: ReturnType<typeof createTestAuth>,
  email: string,
  ip?: string,
) {
  const at = ip === undefined ? {} : { ip };
  const signUp = await call(testAuth.auth, "/sign-up/email", {
    body: { email, password: PASSWORD, name: "Test" },
    ...at,
  });
  expect(signUp.status).toBe(200);
  const verifyUrl = extractUrl(testAuth.emails.lastFor(email, "auth.verify-email"));
  const verify = await call(testAuth.auth, verifyUrl.toString(), { method: "GET", ...at });
  expect(verify.status).toBeLessThan(400);
  const signIn = await call(testAuth.auth, "/sign-in/email", {
    body: { email, password: PASSWORD },
    ...at,
  });
  expect(signIn.status).toBe(200);
  return { cookie: cookiesFrom(signIn), userId: await userIdByEmail(email) };
}

describe("configuration", () => {
  it("refuses to start without an e-mail sender (no fake delivery)", () => {
    expect(() =>
      createAuth({
        db,
        secret: "x".repeat(40),
        baseURL: "http://localhost:3000",
        emailSender: undefined,
      }),
    ).toThrow(/e-mail sender/i);
  });

  it("refuses a short secret", () => {
    expect(() =>
      createAuth({
        db,
        secret: "short",
        baseURL: "http://localhost:3000",
        emailSender: new CapturingEmailSender(),
      }),
    ).toThrow(/AUTH_SECRET/);
  });
});

describe("sign-up, e-mail verification and sessions", () => {
  const testAuth = createTestAuth(db);

  it("requires e-mail verification before a session is created", async () => {
    const email = uniqueEmail("verify");
    const signUp = await call(testAuth.auth, "/sign-up/email", {
      body: { email, password: PASSWORD, name: "T" },
    });
    expect(signUp.status).toBe(200);
    expect(cookiesFrom(signUp)).not.toContain("session_token");

    const early = await call(testAuth.auth, "/sign-in/email", {
      body: { email, password: PASSWORD },
    });
    expect(early.status).toBe(403);

    const verifyUrl = extractUrl(testAuth.emails.lastFor(email, "auth.verify-email"));
    await call(testAuth.auth, verifyUrl.toString(), { method: "GET" });
    const signIn = await call(testAuth.auth, "/sign-in/email", {
      body: { email, password: PASSWORD },
    });
    expect(signIn.status).toBe(200);

    const session = await testAuth.auth.api.getSession({
      headers: new Headers({ cookie: cookiesFrom(signIn) }),
    });
    expect(session?.user.email).toBe(email);
    const stored = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.userId, session?.user.id ?? ""));
    expect(stored.length).toBe(1);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const response = await call(testAuth.auth, "/sign-up/email", {
      body: { email: uniqueEmail("short"), password: "short-pw", name: "T" },
    });
    expect(response.status).toBe(400);
  });

  it("revokes sessions immediately", async () => {
    const { cookie, userId } = await registerVerifiedUser(testAuth, uniqueEmail("revoke"));
    const selfCtx: ServiceContext = { db, actor: await loadActor(db, userId), clock: systemClock };
    expect(await revokeAllSessions(selfCtx, { userId })).toBe(1);
    const session = await testAuth.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session).toBeNull();
  });

  it("only lets privileged users revoke other users' sessions", async () => {
    const victim = await registerVerifiedUser(testAuth, uniqueEmail("victim"));
    const dispatcher = await contextForRole(db, "DISPATCHER");
    await expectDomainError(revokeAllSessions(dispatcher, { userId: victim.userId }), "FORBIDDEN");
    const admin = await contextForRole(db, "ADMIN");
    expect(await revokeAllSessions(admin, { userId: victim.userId })).toBe(1);
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "auth.sessions_revoked"),
          eq(schema.auditLog.entityId, victim.userId),
        ),
      );
    expect(audit.length).toBe(1);
  });
});

describe("login throttling and account lockout", () => {
  it("locks an account after repeated failures and unlocks after the lock period", async () => {
    const clock = new TestClock();
    const testAuth = createTestAuth(db, clock);
    const email = uniqueEmail("lock");
    await registerVerifiedUser(testAuth, email, "198.51.100.30");

    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await call(testAuth.auth, "/sign-in/email", {
        body: { email, password: "wrong password 123" },
        ip: `198.51.100.${40 + attempt}`,
      });
      expect(failed.status).toBe(401);
    }
    const locked = await call(testAuth.auth, "/sign-in/email", {
      body: { email, password: PASSWORD },
      ip: "198.51.100.60",
    });
    expect(locked.status).toBe(429);
    expect(JSON.stringify(await jsonOf(locked))).toContain("ACCOUNT_LOCKED");

    clock.advance(16 * 60 * 1000);
    const unlocked = await call(testAuth.auth, "/sign-in/email", {
      body: { email, password: PASSWORD },
      ip: "198.51.100.61",
    });
    expect(unlocked.status).toBe(200);
    const rows = await db
      .select()
      .from(schema.accountLockout)
      .where(eq(schema.accountLockout.emailNormalized, email));
    expect(rows.length).toBe(0);
  });

  it("locks unknown e-mail addresses the same way (no account enumeration)", async () => {
    const testAuth = createTestAuth(db);
    const email = uniqueEmail("ghost");
    for (let attempt = 0; attempt < 5; attempt++) {
      await call(testAuth.auth, "/sign-in/email", {
        body: { email, password: "whatever 12345" },
        ip: `198.51.100.${70 + attempt}`,
      });
    }
    const locked = await call(testAuth.auth, "/sign-in/email", {
      body: { email, password: "whatever 12345" },
      ip: "198.51.100.80",
    });
    expect(locked.status).toBe(429);
  });

  it("rate-limits sign-in attempts per IP address", async () => {
    const testAuth = createTestAuth(db);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await call(testAuth.auth, "/sign-in/email", {
        body: { email: uniqueEmail("rl"), password: "whatever 12345" },
        ip: "192.0.2.99",
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("password reset", () => {
  it("resets the password via e-mail token and revokes existing sessions", async () => {
    const testAuth = createTestAuth(db);
    const email = uniqueEmail("reset");
    const { cookie } = await registerVerifiedUser(testAuth, email, "198.51.100.90");

    const request = await call(testAuth.auth, "/request-password-reset", {
      body: { email, redirectTo: "/reset" },
      ip: "198.51.100.91",
    });
    expect(request.status).toBe(200);
    const resetUrl = extractUrl(testAuth.emails.lastFor(email, "auth.reset-password"));
    const token = resetUrl.pathname.split("/").pop() ?? "";
    expect(token.length).toBeGreaterThan(10);

    const newPassword = "an entirely new passphrase";
    const reset = await call(testAuth.auth, "/reset-password", {
      body: { token, newPassword },
      ip: "198.51.100.92",
    });
    expect(reset.status).toBe(200);

    expect(await testAuth.auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    const oldPassword = await call(testAuth.auth, "/sign-in/email", {
      body: { email, password: PASSWORD },
      ip: "198.51.100.93",
    });
    expect(oldPassword.status).toBe(401);
    const newLogin = await call(testAuth.auth, "/sign-in/email", {
      body: { email, password: newPassword },
      ip: "198.51.100.94",
    });
    expect(newLogin.status).toBe(200);

    const reuse = await call(testAuth.auth, "/reset-password", {
      body: { token, newPassword: "yet another passphrase" },
      ip: "198.51.100.95",
    });
    expect(reuse.status).toBe(400);
  });
});

describe("admin MFA", () => {
  it("blocks an ADMIN without MFA and allows access after real TOTP enrolment", async () => {
    const testAuth = createTestAuth(db);
    const email = uniqueEmail("admin");
    const { cookie, userId } = await registerVerifiedUser(testAuth, email, "198.51.100.110");
    await db.insert(schema.userRole).values({ userId, roleKey: "ADMIN" });

    const before = await loadActor(db, userId);
    const ctxBefore: ServiceContext = { db, actor: before, clock: systemClock };
    await expectDomainError(
      revokeAllSessions(ctxBefore, { userId: "someone-else" }),
      "MFA_REQUIRED",
    );

    const enable = await call(testAuth.auth, "/two-factor/enable", {
      body: { password: PASSWORD },
      cookie,
      ip: "198.51.100.111",
    });
    expect(enable.status).toBe(200);
    const { totpURI } = (await jsonOf(enable)) as { totpURI: string };
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    const verify = await call(testAuth.auth, "/two-factor/verify-totp", {
      body: { code: totp(secret) },
      cookie,
      ip: "198.51.100.112",
    });
    expect(verify.status).toBe(200);

    const after = await loadActor(db, userId);
    expect(after?.mfaEnabled).toBe(true);
    const ctxAfter: ServiceContext = { db, actor: after, clock: systemClock };
    expect(await revokeAllSessions(ctxAfter, { userId: "no-sessions-user" })).toBe(0);
  });
});

describe("invitations", () => {
  const emails = new CapturingEmailSender();
  const deps = {
    emailSender: emails,
    acceptUrl: (token: string) => `http://localhost:3000/invitation?token=${token}`,
  };
  const tokenFor = (email: string) =>
    extractUrl(emails.lastFor(email, "auth.invitation")).searchParams.get("token") ?? "";

  it("lets an invited user with the matching verified e-mail accept exactly once", async () => {
    const admin = await contextForRole(db, "ADMIN");
    const email = uniqueEmail("invitee");
    const { invitationId } = await createInvitation(admin, { email, role: "DISPATCHER" }, deps);
    const token = tokenFor(email);

    const [stored] = await db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, invitationId));
    expect(stored?.tokenHash).not.toBe(token);

    const other = await createUser(db, { email: uniqueEmail("other") });
    await expectDomainError(
      acceptInvitation({ db, actor: await loadActor(db, other), clock: systemClock }, { token }),
      "NOT_FOUND",
    );

    const invitee = await createUser(db, { email });
    const inviteeCtx = { db, actor: await loadActor(db, invitee), clock: systemClock };
    await acceptInvitation(inviteeCtx, { token });
    expect((await loadActor(db, invitee))?.roles.map((r) => r.role)).toEqual(["DISPATCHER"]);
    await expectDomainError(acceptInvitation(inviteeCtx, { token }), "NOT_FOUND");
  });

  it("rejects unverified e-mail addresses and expired invitations", async () => {
    const admin = await contextForRole(db, "ADMIN");
    const email = uniqueEmail("unverified");
    await createInvitation(admin, { email, role: "STAFF" }, deps);
    const token = tokenFor(email);
    const unverified = await createUser(db, { email, emailVerified: false });
    await expectDomainError(
      acceptInvitation(
        { db, actor: await loadActor(db, unverified), clock: systemClock },
        { token },
      ),
      "NOT_FOUND",
    );

    const later = new TestClock(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    const expiredEmail = uniqueEmail("expired");
    await createInvitation(admin, { email: expiredEmail, role: "STAFF" }, deps);
    const expiredUser = await createUser(db, { email: expiredEmail });
    await expectDomainError(
      acceptInvitation(
        { db, actor: await loadActor(db, expiredUser), clock: later },
        { token: tokenFor(expiredEmail) },
      ),
      "NOT_FOUND",
    );
  });

  it("prevents privilege escalation through invitations", async () => {
    const admin = await contextForRole(db, "ADMIN");
    await expectDomainError(
      createInvitation(admin, { email: uniqueEmail(), role: "SUPER_ADMIN" }, deps),
      "FORBIDDEN",
    );
    const dispatcher = await contextForRole(db, "DISPATCHER");
    await expectDomainError(
      createInvitation(dispatcher, { email: uniqueEmail(), role: "STAFF" }, deps),
      "FORBIDDEN",
    );
    await expectDomainError(
      createInvitation(admin, { email: uniqueEmail(), role: "STAFF", isAdmin: true }, deps),
      "VALIDATION_FAILED",
    );
  });
});

describe("bootstrap", () => {
  it("grants SUPER_ADMIN only once", async () => {
    const existing = await db
      .select({ id: schema.userRole.id })
      .from(schema.userRole)
      .where(eq(schema.userRole.roleKey, "SUPER_ADMIN"))
      .limit(1);
    const first = await createUser(db);
    if (existing.length === 0) {
      await bootstrapSuperAdmin(db, first);
    }
    const second = await createUser(db);
    await expectDomainError(bootstrapSuperAdmin(db, second), "CONFLICT");
  });
});
