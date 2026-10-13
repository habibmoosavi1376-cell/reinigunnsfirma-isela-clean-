import { eq, schema, sql, type DbExecutor } from "@isela/database";
import { normalizeEmail, z } from "@isela/validation";

/** Account lockout policy with enforced lower bounds (cannot be configured away). */
export const lockoutPolicySchema = z.strictObject({
  maxFailedAttempts: z.number().int().min(3).max(10),
  windowMinutes: z.number().int().min(5).max(60),
  lockMinutes: z.number().int().min(5).max(1440),
});

export type LockoutPolicy = z.infer<typeof lockoutPolicySchema>;

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  maxFailedAttempts: 5,
  windowMinutes: 15,
  lockMinutes: 15,
};

/** Returns the lock expiry if the account is currently locked, otherwise `null`. */
export async function getActiveLock(
  db: DbExecutor,
  email: string,
  now: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({ lockedUntil: schema.accountLockout.lockedUntil })
    .from(schema.accountLockout)
    .where(eq(schema.accountLockout.emailNormalized, normalizeEmail(email)))
    .limit(1);
  if (row?.lockedUntil != null && row.lockedUntil.getTime() > now.getTime()) {
    return row.lockedUntil;
  }
  return null;
}

/**
 * Records a failed sign-in atomically. Counting is keyed by the normalised e-mail address
 * whether or not an account exists, so lockout behaviour does not reveal registered users.
 */
export async function recordFailedSignIn(
  db: DbExecutor,
  email: string,
  now: Date,
  policy: LockoutPolicy,
): Promise<void> {
  const windowStart = new Date(now.getTime() - policy.windowMinutes * 60_000);
  const lockUntil = new Date(now.getTime() + policy.lockMinutes * 60_000);
  const t = schema.accountLockout;
  await db
    .insert(t)
    .values({
      emailNormalized: normalizeEmail(email),
      failedAttempts: 1,
      windowStartedAt: now,
      lockedUntil: policy.maxFailedAttempts <= 1 ? lockUntil : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: t.emailNormalized,
      set: {
        failedAttempts: sql`CASE WHEN ${t.windowStartedAt} < ${windowStart} THEN 1 ELSE ${t.failedAttempts} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${t.windowStartedAt} < ${windowStart} THEN ${now} ELSE ${t.windowStartedAt} END`,
        lockedUntil: sql`CASE
          WHEN ${t.windowStartedAt} >= ${windowStart} AND ${t.failedAttempts} + 1 >= ${policy.maxFailedAttempts}
          THEN ${lockUntil}::timestamptz
          ELSE ${t.lockedUntil} END`,
        updatedAt: now,
      },
    });
}

export async function clearFailedSignIns(db: DbExecutor, email: string): Promise<void> {
  await db
    .delete(schema.accountLockout)
    .where(eq(schema.accountLockout.emailNormalized, normalizeEmail(email)));
}
