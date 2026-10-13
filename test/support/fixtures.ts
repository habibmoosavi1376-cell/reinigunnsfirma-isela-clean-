import { randomBytes, randomUUID } from "node:crypto";
import { loadActor, type Actor, type Role, type ServiceContext } from "@isela/auth";
import { createDatabase, schema, type Database, type DatabaseHandle } from "@isela/database";
import type { EmailMessage, EmailSender } from "@isela/notifications";
import { systemClock, type Clock } from "@isela/shared";
import { requireTestDatabaseUrl } from "./env.ts";

/** Test double for the e-mail port. Lives only in test code – never in production paths. */
export class CapturingEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  lastFor(to: string, purpose: string): EmailMessage {
    const found = [...this.messages].reverse().find((m) => m.to === to && m.purpose === purpose);
    if (found === undefined) {
      throw new Error(`No e-mail with purpose ${purpose} captured for ${to}`);
    }
    return found;
  }
}

/** Extracts the first URL from an e-mail body. */
export function extractUrl(message: EmailMessage): URL {
  const match = /https?:\/\/\S+/.exec(message.text);
  if (match === null) {
    throw new Error("No URL in e-mail");
  }
  return new URL(match[0]);
}

/** A mutable clock for time-dependent tests. */
export class TestClock implements Clock {
  private current: Date;

  constructor(start = new Date()) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Test-only pepper. Production peppers come from the secret store. */
export const TEST_CRM_CONFIG = { identityPepper: "test-only-identity-pepper-0123456789abcdef" };

export function openTestDatabase(): DatabaseHandle {
  return createDatabase(requireTestDatabaseUrl(), {
    maxConnections: 5,
    applicationName: "isela-test",
  });
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}@example.test`;
}

export interface TestUserOptions {
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly mfa?: boolean;
}

/** Inserts a user row directly (for service tests that do not exercise Better Auth). */
export async function createUser(db: Database, options: TestUserOptions = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.user).values({
    id,
    name: "Test User",
    email: options.email ?? uniqueEmail(),
    emailVerified: options.emailVerified ?? true,
    twoFactorEnabled: options.mfa ?? false,
  });
  return id;
}

export interface GrantOptions {
  readonly customerId?: string;
  readonly partnerId?: string;
  readonly isScopeAdmin?: boolean;
}

export async function grantRole(
  db: Database,
  userId: string,
  role: Role,
  options: GrantOptions = {},
): Promise<void> {
  await db.insert(schema.userRole).values({
    userId,
    roleKey: role,
    customerId: options.customerId ?? null,
    partnerId: options.partnerId ?? null,
    isScopeAdmin: options.isScopeAdmin ?? false,
  });
}

/** Creates a user with one role and returns a service context for it. */
export async function contextForRole(
  db: Database,
  role: Role,
  options: GrantOptions & TestUserOptions = {},
  clock: Clock = systemClock,
): Promise<ServiceContext & { actor: Actor }> {
  const mfa = options.mfa ?? (role === "SUPER_ADMIN" || role === "ADMIN" || role === "FINANCE");
  const userId = await createUser(db, { ...options, mfa });
  await grantRole(db, userId, role, options);
  const actor = await loadActor(db, userId);
  if (actor === null) {
    throw new Error("actor not found");
  }
  return { db, actor, clock, correlationId: `test-${randomUUID()}` };
}

export function anonymousContext(db: Database, clock: Clock = systemClock): ServiceContext {
  return { db, actor: null, clock };
}
