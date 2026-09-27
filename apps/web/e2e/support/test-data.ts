import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { findLink, type SinkMessage } from "../../tests/support/smtp-sink.ts";

/*
 * TEST-ONLY helpers. Everything created here is explicitly marked as E2E test data and only
 * ever written to the dedicated E2E database (see prepare-database.ts).
 */

export const E2E_BASE_URL = `http://localhost:${process.env["E2E_PORT"] ?? "3100"}`;
const SINK_URL = `http://127.0.0.1:${process.env["E2E_SMTP_HTTP_PORT"] ?? "2526"}/messages`;

export function uniqueTestEmail(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}@example.test`;
}

export async function waitForMailLink(to: string, fragment: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const messages = (await (await fetch(SINK_URL)).json()) as SinkMessage[];
    const link = findLink(messages, to, fragment);
    if (link !== null) return link;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no e-mail containing ${fragment} for ${to}`);
}

async function withClient<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env["E2E_DATABASE_URL"] });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Stands in for the (not yet built) back-office step that links a verified account to a
 * customer record: creates a customer marked as test data and grants the scoped CUSTOMER role.
 */
export async function grantCustomerRole(email: string, displayName: string): Promise<string> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const user = await client.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [
        email,
      ]);
      const userId = user.rows[0]?.id;
      if (userId === undefined) throw new Error("user not found");
      const customer = await client.query<{ id: string }>(
        "INSERT INTO customer (kind, display_name) VALUES ('PRIVATE', $1) RETURNING id",
        [displayName],
      );
      const customerId = customer.rows[0]?.id ?? "";
      await client.query(
        "INSERT INTO user_role (user_id, role_key, customer_id) VALUES ($1, 'CUSTOMER', $2)",
        [userId, customerId],
      );
      await client.query("COMMIT");
      return customerId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function countServiceRequestsFor(email: string): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM service_request r
         JOIN lead_contact c ON c.lead_id = r.lead_id
        WHERE c.email = $1`,
      [email],
    );
    return Number(result.rows[0]?.n ?? "0");
  });
}

/**
 * Creates a verified account through the real auth API (sign-up + e-mail link from the local
 * TEST-ONLY SMTP sink). Returns nothing; sign in via the UI afterwards.
 */
export async function createVerifiedAccount(
  request: {
    post: (
      url: string,
      options: { data: unknown; headers: Record<string, string> },
    ) => Promise<{ status: () => number }>;
    get: (url: string) => Promise<{ status: () => number }>;
  },
  email: string,
  password: string,
): Promise<void> {
  const response = await request.post("/api/auth/sign-up/email", {
    data: {
      name: "E2E-Testdaten Konto",
      email,
      password,
      callbackURL: "/auth/verify-email?status=verified",
    },
    headers: { origin: E2E_BASE_URL },
  });
  if (response.status() !== 200) throw new Error(`sign-up failed: ${String(response.status())}`);
  await request.get(await waitForMailLink(email, "/api/auth/verify-email"));
}

/** Grants a global staff role (TEST DATA ONLY; stands in for the invitation flow). */
export async function grantGlobalRole(email: string, role: "DISPATCHER"): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO user_role (user_id, role_key) SELECT id, $2 FROM "user" WHERE email = $1`,
      [email, role],
    );
  });
}

/**
 * Creates a TEST-DATA customer and an open CUSTOMER invitation for `email` directly in the E2E
 * database (stands in for an admin with MFA sending it). Only the SHA-256 hash of the token is
 * stored, exactly like the production flow; the plain token is returned to the test.
 */
export async function createTestInvitation(email: string, displayName: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  // The inviting staff member is a plain TEST-DATA user row without credentials: it never signs
  // in, so no sign-up is spent on it (the sign-up rate limit stays untouched).
  const inviterId = `e2e-inviter-${randomBytes(6).toString("hex")}`;
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'E2E-Testdaten Einladende', $2, true)`,
        [inviterId, uniqueTestEmail("e2e-inviter")],
      );
      const customer = await client.query<{ id: string }>(
        "INSERT INTO customer (kind, display_name) VALUES ('PRIVATE', $1) RETURNING id",
        [displayName],
      );
      await client.query(
        `INSERT INTO invitation
           (email_normalized, token_hash, role_key, customer_id, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'CUSTOMER', $3, $4, now() + interval '1 day')`,
        [email.toLowerCase(), tokenHash, customer.rows[0]?.id, inviterId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  return token;
}
