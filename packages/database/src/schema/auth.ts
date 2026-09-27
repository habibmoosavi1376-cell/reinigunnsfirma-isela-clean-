import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.ts";
import { customer, partner } from "./crm.ts";

/*
 * Tables required by Better Auth 1.7.x (verified with `getAuthTables` for the plugins in
 * use: email/password, twoFactor, database rate limiting). Property names must match the
 * Better Auth field names; column names follow the project's snake_case convention.
 */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("two_factor_user_id_idx").on(t.userId)],
);

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/* ------------------------------------------------------------------------------------
 * RBAC. The permission matrix is defined in code (packages/auth) and synchronised into
 * these tables; assignments reference roles by key.
 * ---------------------------------------------------------------------------------- */

export const role = pgTable("role", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
  createdAt: createdAt(),
});

export const permission = pgTable("permission", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
  createdAt: createdAt(),
});

export const rolePermission = pgTable(
  "role_permission",
  {
    roleKey: text("role_key")
      .notNull()
      .references(() => role.key, { onDelete: "restrict" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permission.key, { onDelete: "restrict" }),
    scope: text("scope", { enum: ["GLOBAL", "OWN"] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roleKey, t.permissionKey] }),
    check("role_permission_scope_chk", sql`${t.scope} IN ('GLOBAL', 'OWN')`),
  ],
);

/** Scoped roles must carry exactly the matching scope reference. */
const scopeCheck = (roleKey: unknown, customerId: unknown, partnerId: unknown) => sql`(
  (${roleKey} = 'CUSTOMER' AND ${customerId} IS NOT NULL AND ${partnerId} IS NULL) OR
  (${roleKey} = 'PARTNER' AND ${partnerId} IS NOT NULL AND ${customerId} IS NULL) OR
  (${roleKey} NOT IN ('CUSTOMER', 'PARTNER') AND ${customerId} IS NULL AND ${partnerId} IS NULL)
)`;

export const userRole = pgTable(
  "user_role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleKey: text("role_key")
      .notNull()
      .references(() => role.key, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customer.id, { onDelete: "restrict" }),
    partnerId: uuid("partner_id").references(() => partner.id, { onDelete: "restrict" }),
    isScopeAdmin: boolean("is_scope_admin").notNull().default(false),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("user_role_assignment_uq")
      .on(t.userId, t.roleKey, t.customerId, t.partnerId)
      .nullsNotDistinct(),
    // An account is linked to at most one customer record (docs/DOMAIN_MODEL.md §10).
    uniqueIndex("user_role_one_customer_per_user_uq")
      .on(t.userId)
      .where(sql`${t.roleKey} = 'CUSTOMER'`),
    index("user_role_user_id_idx").on(t.userId),
    check("user_role_scope_chk", scopeCheck(t.roleKey, t.customerId, t.partnerId)),
    check(
      "user_role_scope_admin_chk",
      sql`${t.isScopeAdmin} = false OR ${t.roleKey} IN ('CUSTOMER', 'PARTNER')`,
    ),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailNormalized: text("email_normalized").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    roleKey: text("role_key")
      .notNull()
      .references(() => role.key, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customer.id, { onDelete: "restrict" }),
    partnerId: uuid("partner_id").references(() => partner.id, { onDelete: "restrict" }),
    isScopeAdmin: boolean("is_scope_admin").notNull().default(false),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("invitation_email_idx").on(t.emailNormalized),
    check("invitation_scope_chk", scopeCheck(t.roleKey, t.customerId, t.partnerId)),
    check(
      "invitation_accepted_chk",
      sql`(${t.acceptedAt} IS NULL) = (${t.acceptedByUserId} IS NULL)`,
    ),
  ],
);

/** Per-account lockout after repeated failed sign-ins (in addition to per-IP rate limits). */
export const accountLockout = pgTable("account_lockout", {
  emailNormalized: text("email_normalized").primaryKey(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "date" }).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
  updatedAt: updatedAt(),
});
