import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/*
 * E2E tests against the real production build (`next start`), a dedicated, freshly migrated
 * E2E database and a local TEST-ONLY SMTP sink. Nothing here talks to external services.
 *
 * Required: E2E_DATABASE_URL (database name must contain "e2e"), `pnpm --filter @isela/web build`.
 * Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE to use a preinstalled Chromium.
 */

const port = process.env["E2E_PORT"] ?? "3100";
const smtpPort = process.env["E2E_SMTP_PORT"] ?? "2525";
const smtpHttpPort = process.env["E2E_SMTP_HTTP_PORT"] ?? "2526";
const databaseUrl = process.env["E2E_DATABASE_URL"] ?? "";
const isMainProcess = process.env["TEST_WORKER_INDEX"] === undefined;

if (isMainProcess) {
  if (databaseUrl === "") throw new Error("E2E_DATABASE_URL is required for E2E tests");
  // Reset + migrate + seed the dedicated E2E database before the server starts.
  execFileSync(process.execPath, ["e2e/support/prepare-database.ts"], {
    stdio: "inherit",
    env: process.env,
  });
}

const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    locale: "de-DE",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
      },
    },
  ],
  webServer: [
    {
      command: "node e2e/support/start-sink.ts",
      url: `http://127.0.0.1:${smtpHttpPort}/messages`,
      reuseExistingServer: false,
      env: { E2E_SMTP_PORT: smtpPort, E2E_SMTP_HTTP_PORT: smtpHttpPort },
    },
    {
      command: `pnpm exec next start -p ${port}`,
      url: `http://localhost:${port}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "production",
        APP_BASE_URL: `http://localhost:${port}`,
        DATABASE_URL: databaseUrl,
        // Random per run; never real secrets.
        AUTH_SECRET: randomBytes(32).toString("hex"),
        IDENTITY_HASH_PEPPER: randomBytes(32).toString("hex"),
        EMAIL_PROVIDER: "smtp",
        EMAIL_FROM_ADDRESS: "no-reply@example.test",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: smtpPort,
        SMTP_SECURE: "false",
        // E2E-Testdaten — clearly not real company data.
        BUSINESS_LEGAL_NAME: "E2E-Testdaten GmbH",
        BUSINESS_REPRESENTATIVE: "E2E-Testdaten",
        BUSINESS_STREET: "Teststraße 1",
        BUSINESS_POSTAL_CODE: "00000",
        BUSINESS_CITY: "Teststadt",
        BUSINESS_EMAIL: "impressum@example.test",
      },
    },
  ],
});
