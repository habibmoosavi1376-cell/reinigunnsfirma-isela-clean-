import { createHmac, randomBytes, randomInt } from "node:crypto";
import { createAuth, type Auth } from "@isela/auth";
import type { Database } from "@isela/database";
import type { Clock } from "@isela/shared";
import { CapturingEmailSender } from "./fixtures.ts";

export const TEST_BASE_URL = "http://localhost:3000";

export interface TestAuth {
  readonly auth: Auth;
  readonly emails: CapturingEmailSender;
}

export function createTestAuth(db: Database, clock?: Clock): TestAuth {
  const emails = new CapturingEmailSender();
  const auth = createAuth({
    db,
    secret: randomBytes(32).toString("hex"),
    baseURL: TEST_BASE_URL,
    trustedOrigins: [TEST_BASE_URL],
    emailSender: emails,
    secureCookies: false,
    ...(clock === undefined ? {} : { clock }),
  });
  return { auth, emails };
}

export interface CallOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly cookie?: string;
  readonly ip?: string;
}

/** Sends a real HTTP request through the Better Auth handler. */
export async function call(auth: Auth, path: string, options: CallOptions = {}): Promise<Response> {
  // Without an explicit IP every request gets its own address, so per-IP rate limits of one
  // test cannot leak into another. Rate-limit tests pass a fixed IP.
  const ip = options.ip ?? `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
  const headers = new Headers({ origin: TEST_BASE_URL, "x-forwarded-for": ip });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  const url = path.startsWith("http") ? path : `${TEST_BASE_URL}/api/auth${path}`;
  const init: RequestInit = { method: options.method ?? "POST", headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return auth.handler(new Request(url, init));
}

/** Collects `name=value` pairs from Set-Cookie headers into a Cookie header value. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => c !== "" && !c.endsWith("="))
    .join("; ");
}

export async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) – test helper to complete a real MFA enrolment. */
export function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32Secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("invalid base32");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac("sha1", bytes).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}
