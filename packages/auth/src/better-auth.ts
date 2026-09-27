import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { schema, type Database } from "@isela/database";
import { requireEmailSender, type EmailSender } from "@isela/notifications";
import { DomainError, systemClock, type Clock } from "@isela/shared";
import {
  DEFAULT_LOCKOUT_POLICY,
  clearFailedSignIns,
  getActiveLock,
  lockoutPolicySchema,
  recordFailedSignIn,
  type LockoutPolicy,
} from "./lockout.ts";

export interface AuthOptions {
  readonly db: Database;
  /** Random secret of at least 32 characters (AUTH_SECRET). */
  readonly secret: string;
  readonly baseURL: string;
  readonly trustedOrigins?: readonly string[];
  /** Real e-mail sender. There is no default: without it authentication does not start. */
  readonly emailSender: EmailSender | undefined;
  readonly lockout?: LockoutPolicy;
  /** Headers used to determine the client IP for rate limiting (set per deployment). */
  readonly ipAddressHeaders?: readonly string[];
  /** Addresses of trusted reverse proxies; required when forwarded headers are chained. */
  readonly trustedProxies?: readonly string[];
  readonly secureCookies?: boolean;
  readonly clock?: Clock;
}

const SEVEN_DAYS_SECONDS = 60 * 60 * 24 * 7;
const ONE_DAY_SECONDS = 60 * 60 * 24;

function signInEmailFrom(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "email" in body) {
    return typeof body.email === "string" ? body.email : null;
  }
  return null;
}

/**
 * Creates the Better Auth instance (docs/DOMAIN_MODEL.md §10.2):
 * e-mail verification required, password reset revokes sessions, database-backed sessions
 * without cookie cache (revocation is immediate), database rate limiting, per-account
 * lockout and TOTP-based MFA.
 */
export function createAuth(options: AuthOptions) {
  const emailSender = requireEmailSender(options.emailSender);
  if (options.secret.length < 32) {
    throw new DomainError("CONFIGURATION_ERROR", "AUTH_SECRET must be at least 32 characters");
  }
  const lockout = lockoutPolicySchema.parse(options.lockout ?? DEFAULT_LOCKOUT_POLICY);
  const clock = options.clock ?? systemClock;
  const db = options.db;

  return betterAuth({
    appName: "ISELA CLEAN",
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [...(options.trustedOrigins ?? [])],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
        rateLimit: schema.rateLimit,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await emailSender.send({
          to: user.email,
          subject: "ISELA CLEAN – Passwort zurücksetzen",
          text: `Über folgenden Link können Sie Ihr Passwort zurücksetzen (30 Minuten gültig): ${url}`,
          purpose: "auth.reset-password",
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await emailSender.send({
          to: user.email,
          subject: "ISELA CLEAN – E-Mail-Adresse bestätigen",
          text: `Bitte bestätigen Sie Ihre E-Mail-Adresse (1 Stunde gültig): ${url}`,
          purpose: "auth.verify-email",
        });
      },
    },
    session: {
      expiresIn: SEVEN_DAYS_SECONDS,
      updateAge: ONE_DAY_SECONDS,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 300, max: 3 },
        "/send-verification-email": { window: 300, max: 3 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
      },
    },
    advanced: {
      // Better Auth silently disables origin/CSRF checks when NODE_ENV=test or TEST is set.
      // Security must never depend on environment flags, so both are pinned explicitly.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: options.secureCookies ?? true,
      ipAddress: {
        ipAddressHeaders: [...(options.ipAddressHeaders ?? ["x-forwarded-for"])],
        ...(options.trustedProxies === undefined
          ? {}
          : { trustedProxies: [...options.trustedProxies] }),
      },
    },
    plugins: [twoFactor({ issuer: "ISELA CLEAN" })],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = signInEmailFrom(ctx.body);
        if (email === null) return;
        const lockedUntil = await getActiveLock(db, email, clock.now());
        if (lockedUntil !== null) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Account temporarily locked",
            code: "ACCOUNT_LOCKED",
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = signInEmailFrom(ctx.body);
        if (email === null) return;
        const returned = ctx.context.returned;
        if (isAPIError(returned)) {
          if (returned.statusCode === 401) {
            await recordFailedSignIn(db, email, clock.now(), lockout);
          }
          return;
        }
        await clearFailedSignIns(db, email);
      }),
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
