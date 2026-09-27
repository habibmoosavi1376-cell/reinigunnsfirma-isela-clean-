import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC_ENV_KEYS, SERVER_ENV_KEYS, isLoopbackHost, parseServerEnv } from "@isela/config";
import { isDomainError } from "@isela/shared";

const SECRET = "a".repeat(20) + "SeCrEt-Value-123456789";

const valid: Record<string, string> = {
  NODE_ENV: "development",
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://user@localhost:5432/isela",
  AUTH_SECRET: SECRET,
  IDENTITY_HASH_PEPPER: "p".repeat(40),
  EMAIL_PROVIDER: "smtp",
  EMAIL_FROM_ADDRESS: "no-reply@example.test",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
};

const production: Record<string, string> = {
  ...valid,
  NODE_ENV: "production",
  APP_BASE_URL: "https://www.example.test",
  BUSINESS_LEGAL_NAME: "Test GmbH",
  BUSINESS_REPRESENTATIVE: "Test Person",
  BUSINESS_STREET: "Teststraße 1",
  BUSINESS_POSTAL_CODE: "00000",
  BUSINESS_CITY: "Teststadt",
  BUSINESS_EMAIL: "kontakt@example.test",
};

function errorOf(source: Record<string, string | undefined>): {
  message: string;
  variables: string[];
} {
  try {
    parseServerEnv(source);
  } catch (error) {
    if (isDomainError(error, "CONFIGURATION_ERROR")) {
      return {
        message: error.message,
        variables: (error.details?.["variables"] ?? []) as string[],
      };
    }
    throw error;
  }
  throw new Error("expected CONFIGURATION_ERROR");
}

describe("server environment", () => {
  it("accepts a complete development configuration and applies safe defaults", () => {
    const env = parseServerEnv(valid);
    expect(env.APP_TIMEZONE).toBe("Europe/Berlin");
    expect(env.AUTH_TRUSTED_ORIGINS).toEqual([]);
    expect(env.PUBLIC_REQUEST_RATE_LIMIT_PER_HOUR).toBe(5);
  });

  it.each([
    "DATABASE_URL",
    "AUTH_SECRET",
    "IDENTITY_HASH_PEPPER",
    "EMAIL_PROVIDER",
    "SMTP_HOST",
    "APP_BASE_URL",
  ])("fails without %s (no silent default for critical values)", (key) => {
    const { variables } = errorOf({ ...valid, [key]: undefined });
    expect(variables).toContain(key);
  });

  it("never echoes secret values in error messages", () => {
    const { message } = errorOf({
      ...valid,
      DATABASE_URL: "mysql://nope",
      AUTH_SECRET: "short-secret-value",
    });
    expect(message).not.toContain("short-secret-value");
    expect(message).not.toContain("mysql://nope");
  });

  it("rejects short and placeholder secrets", () => {
    expect(errorOf({ ...valid, AUTH_SECRET: "too-short" }).variables).toContain("AUTH_SECRET");
    expect(errorOf({ ...valid, AUTH_SECRET: "x".repeat(40) }).variables).toContain("AUTH_SECRET");
  });

  it("requires https and complete legal notice data in production", () => {
    expect(() => parseServerEnv(production)).not.toThrow();
    expect(errorOf({ ...production, APP_BASE_URL: "http://www.example.test" }).variables).toContain(
      "APP_BASE_URL",
    );
    expect(errorOf({ ...production, BUSINESS_LEGAL_NAME: undefined }).variables).toContain(
      "BUSINESS_LEGAL_NAME",
    );
  });

  it("allows plain http only for loopback hosts in production (local E2E)", () => {
    expect(() =>
      parseServerEnv({ ...production, APP_BASE_URL: "http://localhost:3100" }),
    ).not.toThrow();
    expect(() =>
      parseServerEnv({ ...production, APP_BASE_URL: "http://127.0.0.1:3100" }),
    ).not.toThrow();
  });

  it("rejects providers that are not implemented (no fake payments, geocoding or storage)", () => {
    expect(errorOf({ ...valid, PAYMENT_PROVIDER: "stripe" }).variables).toContain(
      "PAYMENT_PROVIDER",
    );
    expect(errorOf({ ...valid, GEOCODING_PROVIDER: "any" }).variables).toContain(
      "GEOCODING_PROVIDER",
    );
    expect(errorOf({ ...valid, STORAGE_ENDPOINT: "https://s3.example.test" }).variables).toContain(
      "STORAGE_ENDPOINT",
    );
  });

  it("requires SMTP credentials in pairs in production", () => {
    expect(errorOf({ ...production, SMTP_USER: "user" }).variables).toContain("SMTP_USER");
  });

  it("never exposes server variables to the browser", () => {
    expect(SERVER_ENV_KEYS.length).toBeGreaterThan(10);
    expect(SERVER_ENV_KEYS.filter((key) => key.startsWith("NEXT_PUBLIC_"))).toEqual([]);
    expect(PUBLIC_ENV_KEYS.every((key) => key.startsWith("NEXT_PUBLIC_"))).toBe(true);
  });
});

describe("isLoopbackHost (TLS exemptions only for traffic that never leaves the machine)", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "[::1]", "::1"])(
    "treats %s as loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(["smtp.example.com", "127.0.0.2", "10.0.0.1", "localhost.example.com", "0.0.0.0", ""])(
    "does not treat %s as loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe(".env.example", () => {
  const TEST_ONLY_KEYS = [
    "TEST_DATABASE_URL",
    "E2E_DATABASE_URL",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
  ];
  const entries = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => {
      const [key = "", ...rest] = line.split("=");
      return { key, value: rest.join("=") };
    });

  it("documents exactly the validated server variables (plus test-only keys)", () => {
    const keys = entries.map((entry) => entry.key).sort();
    expect(keys).toEqual([...SERVER_ENV_KEYS, ...TEST_ONLY_KEYS].sort());
  });

  it("contains no secret values", () => {
    for (const key of [
      "AUTH_SECRET",
      "IDENTITY_HASH_PEPPER",
      "DATABASE_URL",
      "SMTP_PASSWORD",
      "SMTP_USER",
    ]) {
      expect(entries.find((entry) => entry.key === key)?.value, key).toBe("");
    }
  });
});
