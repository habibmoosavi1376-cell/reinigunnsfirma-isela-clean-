import "server-only";
import { createAuth, type Auth } from "@isela/auth";
import { isLoopbackHost, type ServerEnv } from "@isela/config";
import type { CrmConfig, GeocodingDeps } from "@isela/crm";
import { createGeoapifyProvider, type GeocodingProvider } from "@isela/geocoding";
import { createDatabase, type DatabaseHandle } from "@isela/database";
import { createSmtpEmailSender, type EmailSender } from "@isela/notifications";
import { systemClock, type Clock } from "@isela/shared";

/** Everything the web app needs from the domain packages, wired from the validated env. */
export interface WebServices {
  readonly env: ServerEnv;
  readonly database: DatabaseHandle;
  readonly auth: Auth;
  readonly emailSender: EmailSender;
  readonly crmConfig: CrmConfig;
  readonly clock: Clock;
  readonly geocoding: GeocodingDeps;
}

export interface CompositionOverrides {
  /** Test code only: capture e-mails instead of sending them over SMTP. */
  readonly emailSender?: EmailSender;
  readonly clock?: Clock;
  readonly database?: DatabaseHandle;
  /** Test code only: a geocoding test double (production uses the configured provider). */
  readonly geocodingProvider?: GeocodingProvider | null;
}

export function createWebServices(
  env: ServerEnv,
  overrides: CompositionOverrides = {},
): WebServices {
  const production = env.NODE_ENV === "production";
  const database =
    overrides.database ?? createDatabase(env.DATABASE_URL, { applicationName: "isela-web" });
  const emailSender =
    overrides.emailSender ??
    createSmtpEmailSender({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.EMAIL_FROM_ADDRESS,
      // STARTTLS is mandatory in production, except for a relay on the same host (loopback),
      // where the connection never leaves the machine.
      requireTls: production && !isLoopbackHost(env.SMTP_HOST),
    });
  const clock = overrides.clock ?? systemClock;
  const auth = createAuth({
    db: database.db,
    secret: env.AUTH_SECRET,
    baseURL: env.APP_BASE_URL,
    trustedOrigins: [new URL(env.APP_BASE_URL).origin, ...env.AUTH_TRUSTED_ORIGINS],
    emailSender,
    secureCookies: production && env.APP_BASE_URL.startsWith("https://"),
    ...(env.AUTH_IP_ADDRESS_HEADERS.length > 0
      ? { ipAddressHeaders: env.AUTH_IP_ADDRESS_HEADERS }
      : {}),
    ...(env.AUTH_TRUSTED_PROXIES.length > 0 ? { trustedProxies: env.AUTH_TRUSTED_PROXIES } : {}),
    clock,
  });
  const geocodingProvider =
    overrides.geocodingProvider !== undefined
      ? overrides.geocodingProvider
      : env.GEOCODING_PROVIDER === "geoapify" && env.GEOCODING_API_KEY !== undefined
        ? createGeoapifyProvider({
            apiKey: env.GEOCODING_API_KEY,
            timeoutMs: env.GEOCODING_TIMEOUT_MS,
          })
        : null;
  return {
    env,
    database,
    auth,
    emailSender,
    crmConfig: { identityPepper: env.IDENTITY_HASH_PEPPER },
    clock,
    geocoding: {
      provider: geocodingProvider,
      maxRequestsPerMinute: env.GEOCODING_MAX_REQUESTS_PER_MINUTE,
    },
  };
}
