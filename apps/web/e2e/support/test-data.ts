import { createHash, createHmac, randomBytes } from "node:crypto";
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
    ) => Promise<{ status: () => number; headers: () => Record<string, string> }>;
    get: (url: string) => Promise<{ status: () => number }>;
  },
  email: string,
  password: string,
): Promise<void> {
  const signUp = () =>
    request.post("/api/auth/sign-up/email", {
      data: {
        name: "E2E-Testdaten Konto",
        email,
        password,
        callbackURL: "/auth/verify-email?status=verified",
      },
      headers: { origin: E2E_BASE_URL },
    });
  let response = await signUp();
  if (response.status() === 429) {
    // The sign-up rate limit is NOT relaxed for tests: wait for the window the server names.
    const retryAfter = Number(response.headers()["x-retry-after"] ?? "60");
    await new Promise((resolve) => setTimeout(resolve, (Math.min(retryAfter, 90) + 1) * 1000));
    response = await signUp();
  }
  if (response.status() !== 200) throw new Error(`sign-up failed: ${String(response.status())}`);
  await request.get(await waitForMailLink(email, "/api/auth/verify-email"));
}

/** Grants a global staff role (TEST DATA ONLY; stands in for the invitation flow). */
export async function grantGlobalRole(
  email: string,
  role: "DISPATCHER" | "ADMIN" | "FINANCE",
): Promise<void> {
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

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) – TEST-ONLY authenticator for the E2E MFA flow. */
export function totpCode(base32Secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32Secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("invalid base32 secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", bytes).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

/**
 * Enrols TOTP for the signed-in session through the real Better Auth endpoints (the same
 * calls the security page makes), so privileged roles are tested with genuine MFA.
 */
export async function enableTotp(
  request: {
    post: (
      url: string,
      options: { data: unknown; headers: Record<string, string> },
    ) => Promise<{ status: () => number; json: () => Promise<unknown> }>;
  },
  password: string,
): Promise<void> {
  const headers = { origin: E2E_BASE_URL };
  const enable = await request.post("/api/auth/two-factor/enable", { data: { password }, headers });
  if (enable.status() !== 200) throw new Error(`2FA enable failed: ${String(enable.status())}`);
  const { totpURI } = (await enable.json()) as { totpURI: string };
  const secret = new URL(totpURI).searchParams.get("secret") ?? "";
  const verify = await request.post("/api/auth/two-factor/verify-totp", {
    data: { code: totpCode(secret) },
    headers,
  });
  if (verify.status() !== 200) throw new Error(`2FA verify failed: ${String(verify.status())}`);
}

export interface OperationsFixture {
  readonly propertyName: string;
  readonly employeeName: string;
}

/**
 * TEST DATA for the day-5 flow: an active service area, a geocoded service address and a
 * property of the customer, and a qualified employee with working hours in that area.
 * Coordinates stand in for trusted geocoding (no provider runs in E2E).
 */
export async function createOperationsFixture(
  customerId: string,
  marker: string,
  qualification: string,
): Promise<OperationsFixture> {
  const point = { latitude: 60.17, longitude: 24.94 };
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const area = await client.query<{ id: string }>(
        `INSERT INTO service_area (key, name, kind, center, radius_m, active, priority)
         VALUES ($1, 'E2E-Testgebiet', 'CIRCLE',
                 ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, 20000, true, 1)
         RETURNING id`,
        [`e2e-area-${randomBytes(4).toString("hex")}`, point.latitude, point.longitude],
      );
      const address = await client.query<{ id: string }>(
        `INSERT INTO customer_address
           (customer_id, address_type, street, house_number, postal_code, city, country,
            latitude, longitude, geocoding_status, geocoded_at, source, is_primary)
         VALUES ($1, 'SERVICE', 'E2E-Testweg', '5', '00000', 'Teststadt', 'DE',
                 $2, $3, 'MANUAL', now(), 'STAFF_INPUT', true)
         RETURNING id`,
        [customerId, point.latitude, point.longitude],
      );
      const propertyName = `${marker} Wohnung`;
      await client.query(
        `INSERT INTO property (customer_id, address_id, name, property_type)
         VALUES ($1, $2, $3, 'APARTMENT')`,
        [customerId, address.rows[0]?.id, propertyName],
      );
      const employeeName = `${marker} Mitarbeiterin`;
      const employee = await client.query<{ id: string }>(
        `INSERT INTO employee (display_name, qualifications, max_jobs_per_day)
         VALUES ($1, ARRAY[$2]::text[], 4) RETURNING id`,
        [employeeName, qualification],
      );
      const employeeId = employee.rows[0]?.id;
      await client.query(
        "INSERT INTO employee_service_area (employee_id, service_area_id) VALUES ($1, $2)",
        [employeeId, area.rows[0]?.id],
      );
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        await client.query(
          `INSERT INTO employee_working_window (employee_id, weekday, start_minute, end_minute)
           VALUES ($1, $2, 420, 1200)`,
          [employeeId, weekday],
        );
      }
      await client.query("COMMIT");
      return { propertyName, employeeName };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/**
 * TEST-DATA billing configuration (`billing.config`), inserted once per E2E database. The
 * values are test values that stand in for the owner decision (production default:
 * CONFIG_REQUIRED). Existing versions are never touched.
 */
export async function configureTestBilling(): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO setting (key, scope_type, scope_id, version, value, effective_from,
                            change_reason, created_by_user_id)
       SELECT 'billing.config', 'GLOBAL', NULL, 1,
              '{"invoiceNumberPrefix":"E2E","paymentTermDays":14,"prepaymentDueDays":7}'::jsonb,
              now() - interval '1 day', 'E2E-Testdaten', 'e2e-test-data'
       WHERE NOT EXISTS (SELECT 1 FROM setting WHERE key = 'billing.config')`,
    );
  });
}

/** A TEST-DATA customer record without an account (no sign-up is spent). */
export async function createTestCustomer(displayName: string): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO customer (kind, display_name) VALUES ('PRIVATE', $1) RETURNING id`,
      [displayName],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error("customer not created");
    return id;
  });
}
