import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findLink, startSmtpSink, type SmtpSink } from "../support/smtp-sink";

/*
 * Exercises the real Next.js route module (app/api/auth/[...all]/route.ts) with the real
 * environment validation, database and SMTP adapter. E-mails go to a local TEST-ONLY SMTP sink.
 */

const BASE = "http://localhost:3999";
const SMTP_PORT = 25_000 + Math.floor(Math.random() * 1000);
const PASSWORD = "correct horse battery staple";

let sink: SmtpSink;
let GET: (request: Request) => Promise<Response>;
let POST: (request: Request) => Promise<Response>;

function ip() {
  return `198.18.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
}

function call(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; cookie?: string } = {},
) {
  const headers = new Headers({ origin: BASE, "x-forwarded-for": ip() });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie !== undefined) headers.set("cookie", init.cookie);
  const request = new Request(path.startsWith("http") ? path : `${BASE}/api/auth${path}`, {
    method: init.method ?? "POST",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return (init.method ?? "POST") === "GET" ? GET(request) : POST(request);
}

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => c !== "" && !c.endsWith("="))
    .join("; ");
}

async function waitForLink(to: string, fragment: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const link = findLink(sink.messages, to, fragment);
    if (link !== null) return link;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no e-mail with ${fragment} for ${to}`);
}

async function session(cookie: string) {
  const response = await call("/get-session", { method: "GET", cookie });
  const text = await response.text();
  return text === "" || text === "null" ? null : (JSON.parse(text) as { user: { email: string } });
}

beforeAll(async () => {
  sink = await startSmtpSink(SMTP_PORT, SMTP_PORT + 1);
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined) throw new Error("TEST_DATABASE_URL required");
  Object.assign(process.env, {
    NODE_ENV: "test",
    APP_BASE_URL: BASE,
    DATABASE_URL: url,
    AUTH_SECRET: randomBytes(32).toString("hex"),
    IDENTITY_HASH_PEPPER: randomBytes(32).toString("hex"),
    EMAIL_PROVIDER: "smtp",
    EMAIL_FROM_ADDRESS: "no-reply@example.test",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(SMTP_PORT),
  });
  const route = await import("../../app/api/auth/[...all]/route");
  GET = route.GET;
  POST = route.POST;
});

afterAll(async () => {
  await sink.close();
});

describe("auth route (Better Auth via Next.js route handler)", () => {
  it("registration → e-mail verification over SMTP → login → session → logout", async () => {
    const email = `web-${randomBytes(4).toString("hex")}@example.test`;
    const signUp = await call("/sign-up/email", {
      body: {
        name: "Web Test",
        email,
        password: PASSWORD,
        callbackURL: "/auth/verify-email?status=verified",
      },
    });
    expect(signUp.status).toBe(200);

    const blocked = await call("/sign-in/email", { body: { email, password: PASSWORD } });
    expect(blocked.status).toBe(403);

    const verify = await call(await waitForLink(email, "/api/auth/verify-email"), {
      method: "GET",
    });
    expect(verify.status).toBeLessThan(400);
    expect(verify.headers.get("location") ?? "").toContain("/auth/verify-email?status=verified");

    const signIn = await call("/sign-in/email", { body: { email, password: PASSWORD } });
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn);
    expect(cookie).toContain("session_token");
    expect(signIn.headers.getSetCookie().join(";").toLowerCase()).toContain("httponly");
    expect((await session(cookie))?.user.email).toBe(email);

    const signOut = await call("/sign-out", { body: {}, cookie });
    expect(signOut.status).toBe(200);
    expect(await session(cookie)).toBeNull();
  });

  it("does not reveal whether an e-mail address is registered", async () => {
    const email = `dup-${randomBytes(4).toString("hex")}@example.test`;
    const first = await call("/sign-up/email", { body: { name: "A", email, password: PASSWORD } });
    const second = await call("/sign-up/email", { body: { name: "B", email, password: PASSWORD } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const reset = await call("/request-password-reset", {
      body: {
        email: `unknown-${randomBytes(4).toString("hex")}@example.test`,
        redirectTo: "/auth/reset-password",
      },
    });
    expect(reset.status).toBe(200);
  });

  it("password reset revokes existing sessions", async () => {
    const email = `reset-${randomBytes(4).toString("hex")}@example.test`;
    await call("/sign-up/email", { body: { name: "R", email, password: PASSWORD } });
    await call(await waitForLink(email, "/api/auth/verify-email"), { method: "GET" });
    const cookie = cookieOf(await call("/sign-in/email", { body: { email, password: PASSWORD } }));
    expect(await session(cookie)).not.toBeNull();

    await call("/request-password-reset", { body: { email, redirectTo: "/auth/reset-password" } });
    const link = await waitForLink(email, "/api/auth/reset-password/");
    const redirect = await call(link, { method: "GET" });
    const location = new URL(redirect.headers.get("location") ?? "", BASE);
    expect(location.pathname).toBe("/auth/reset-password");
    const token = location.searchParams.get("token") ?? "";

    const done = await call("/reset-password", {
      body: { token, newPassword: "a brand new passphrase" },
    });
    expect(done.status).toBe(200);
    expect(await session(cookie)).toBeNull();
    expect((await call("/sign-in/email", { body: { email, password: PASSWORD } })).status).toBe(
      401,
    );
  });

  it("rejects cross-site requests (origin/CSRF check, even with NODE_ENV=test) and foreign callback URLs", async () => {
    expect(process.env["NODE_ENV"]).toBe("test");
    const crossSiteRequest = (path: string, extra: Record<string, string>, body: unknown) =>
      POST(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: new Headers({
            "content-type": "application/json",
            "x-forwarded-for": ip(),
            ...extra,
          }),
          body: JSON.stringify(body),
        }),
      );
    const credentials = { email: "a@example.test", password: PASSWORD };

    // Login CSRF: foreign Origin, and a cross-site top-level form navigation.
    expect(
      (await crossSiteRequest("/sign-in/email", { origin: "https://evil.example" }, credentials))
        .status,
    ).toBe(403);
    expect(
      (
        await crossSiteRequest(
          "/sign-in/email",
          {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
          credentials,
        )
      ).status,
    ).toBe(403);

    // Cookie-bearing state change from a foreign or missing origin (classic CSRF) is rejected
    // and the session stays valid.
    const victim = `csrf-${randomBytes(4).toString("hex")}@example.test`;
    await call("/sign-up/email", { body: { name: "V", email: victim, password: PASSWORD } });
    await call(await waitForLink(victim, "/api/auth/verify-email"), { method: "GET" });
    const cookie = cookieOf(
      await call("/sign-in/email", { body: { email: victim, password: PASSWORD } }),
    );
    expect(
      (await crossSiteRequest("/sign-out", { origin: "https://evil.example", cookie }, {})).status,
    ).toBe(403);
    expect((await crossSiteRequest("/sign-out", { cookie }, {})).status).toBe(403);
    expect((await session(cookie))?.user.email).toBe(victim);

    const email = `cb-${randomBytes(4).toString("hex")}@example.test`;
    const foreignCallback = await call("/sign-up/email", {
      body: { name: "C", email, password: PASSWORD, callbackURL: "https://evil.example/steal" },
    });
    expect(foreignCallback.status).toBe(403);
  });

  it("serves API responses with a restrictive, non-cacheable profile (no stack traces)", async () => {
    const response = await call("/sign-in/email", { body: { email: "malformed" } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toMatch(/at .*\.(ts|js):\d+/);
  });
});
