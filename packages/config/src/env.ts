import { DomainError } from "@isela/shared";
import { z } from "zod";

/*
 * Typed server environment, grouped by concern. Rules:
 * - Security-critical values have NO defaults; a missing value stops the application.
 * - Error messages list variable names only, never values.
 * - Server-only variables never use the NEXT_PUBLIC_ prefix (enforced in tests), so Next.js
 *   never inlines them into client bundles.
 * - Features without an implemented provider (payment, geocoding, storage) reject
 *   configuration instead of pretending to work.
 */

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const csv = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() !== ""
      ? value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "")
      : [],
  z.array(z.string().min(1)),
);
const booleanFlag = z.preprocess(
  (value) => (value === undefined || value === "" ? undefined : value === "true" || value === "1"),
  z.boolean().optional(),
);
const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters`)
    .refine(
      (value) => !/^(change-?me|secret|password|x+)$/i.test(value),
      `${name} is a placeholder`,
    );

export const applicationEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.url({ protocol: /^https?$/ }),
  APP_TIMEZONE: z.string().default("Europe/Berlin"),
  APP_DEFAULT_LOCALE: z.string().default("de-DE"),
  APP_DEFAULT_CURRENCY: z.string().length(3).default("EUR"),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "DATABASE_URL must be a postgres URL",
  }),
});

export const authEnvSchema = z.object({
  AUTH_SECRET: secret("AUTH_SECRET"),
  AUTH_TRUSTED_ORIGINS: csv,
  AUTH_IP_ADDRESS_HEADERS: csv,
  AUTH_TRUSTED_PROXIES: csv,
});

export const securityEnvSchema = z.object({
  IDENTITY_HASH_PEPPER: secret("IDENTITY_HASH_PEPPER"),
  PUBLIC_REQUEST_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),
});

export const emailEnvSchema = z.object({
  EMAIL_PROVIDER: z.literal("smtp", { error: 'EMAIL_PROVIDER must be "smtp"' }),
  EMAIL_FROM_ADDRESS: z.email(),
  SMTP_HOST: z.string().trim().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_SECURE: booleanFlag,
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
});

/**
 * Geocoding (address → coordinates). Supported: "geoapify" (EU, see
 * docs/PHASE_1_DAY_3_REPORT.md §2). Unset = geocoding disabled: requests keep
 * geocoding_status PENDING and service availability UNKNOWN – there is no fake geocoding.
 */
export const geoEnvSchema = z.object({
  GEOCODING_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(["geoapify"], { error: 'GEOCODING_PROVIDER must be "geoapify" or empty' }).optional(),
  ),
  GEOCODING_API_KEY: z.preprocess(emptyToUndefined, z.string().trim().min(16).max(200).optional()),
  GEOCODING_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(4000),
  GEOCODING_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(60),
});

/** No payment provider is integrated yet – configuring one is rejected (no fake payments). */
export const paymentEnvSchema = z.object({
  PAYMENT_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.undefined({ error: "PAYMENT_PROVIDER is not supported yet" }),
  ),
});

/** No object storage is integrated yet. */
export const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.preprocess(
    emptyToUndefined,
    z.undefined({ error: "STORAGE_ENDPOINT is not supported yet" }),
  ),
});

export const observabilityEnvSchema = z.object({
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/** Legal notice (Impressum) data. Required in production; never invented. */
export const legalEnvSchema = z.object({
  BUSINESS_LEGAL_NAME: optionalString,
  BUSINESS_REPRESENTATIVE: optionalString,
  BUSINESS_STREET: optionalString,
  BUSINESS_POSTAL_CODE: optionalString,
  BUSINESS_CITY: optionalString,
  BUSINESS_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
  BUSINESS_PHONE: optionalString,
  BUSINESS_VAT_ID: optionalString,
});

const LEGAL_REQUIRED_IN_PRODUCTION = [
  "BUSINESS_LEGAL_NAME",
  "BUSINESS_REPRESENTATIVE",
  "BUSINESS_STREET",
  "BUSINESS_POSTAL_CODE",
  "BUSINESS_CITY",
  "BUSINESS_EMAIL",
] as const;

/** Loopback hosts never leave the machine (local E2E runs, an SMTP relay sidecar). */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

export const serverEnvSchema = applicationEnvSchema
  .extend(databaseEnvSchema.shape)
  .extend(authEnvSchema.shape)
  .extend(securityEnvSchema.shape)
  .extend(emailEnvSchema.shape)
  .extend(geoEnvSchema.shape)
  .extend(paymentEnvSchema.shape)
  .extend(storageEnvSchema.shape)
  .extend(observabilityEnvSchema.shape)
  .extend(legalEnvSchema.shape)
  .superRefine((env, ctx) => {
    if ((env.GEOCODING_PROVIDER === undefined) !== (env.GEOCODING_API_KEY === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["GEOCODING_API_KEY"],
        message: "GEOCODING_PROVIDER and GEOCODING_API_KEY must be set together",
      });
    }
    if (env.NODE_ENV !== "production") return;
    // Loopback hosts are exempt so that production builds can be tested locally/in CI (E2E);
    // a real deployment is never served from a loopback address.
    const loopback = isLoopbackHost(new URL(env.APP_BASE_URL).hostname);
    if (!env.APP_BASE_URL.startsWith("https://") && !loopback) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_BASE_URL"],
        message: "APP_BASE_URL must use https in production",
      });
    }
    for (const key of LEGAL_REQUIRED_IN_PRODUCTION) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required in production (Impressum)`,
        });
      }
    }
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_USER"],
        message: "SMTP_USER and SMTP_PASSWORD must be set together",
      });
    }
  });

export type ServerEnv = z.output<typeof serverEnvSchema>;

/**
 * Validates the server environment. Throws a CONFIGURATION_ERROR listing the affected
 * variable names (never their values).
 */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new DomainError(
      "CONFIGURATION_ERROR",
      `Invalid server environment:\n  - ${problems.join("\n  - ")}`,
      {
        variables: [...new Set(result.error.issues.map((issue) => issue.path.join(".")))],
      },
    );
  }
  return result.data;
}

/** All server variable names – none may be exposed to the browser. */
export const SERVER_ENV_KEYS: readonly string[] = Object.keys(serverEnvSchema.shape);

/** Variables that may be exposed to the browser (must use the NEXT_PUBLIC_ prefix). Currently none. */
export const PUBLIC_ENV_KEYS: readonly string[] = [];
