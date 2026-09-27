import { sql } from "drizzle-orm";
import type { DbExecutor } from "./client.ts";
import { publicRateLimit } from "./schema/index.ts";

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
}

/**
 * Atomically consumes one unit of a fixed-window rate limit. `key` must not contain personal
 * data in clear text (hash IPs and e-mail addresses before calling).
 */
export async function consumeRateLimit(
  db: DbExecutor,
  key: string,
  limit: number,
  windowSeconds: number,
  now: Date,
): Promise<RateLimitResult> {
  const windowStart = new Date(now.getTime() - windowSeconds * 1000);
  const t = publicRateLimit;
  const [row] = await db
    .insert(t)
    .values({ key, windowStartedAt: now, count: 1 })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        count: sql`CASE WHEN ${t.windowStartedAt} <= ${windowStart} THEN 1 ELSE ${t.count} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${t.windowStartedAt} <= ${windowStart} THEN ${now}::timestamptz ELSE ${t.windowStartedAt} END`,
      },
    })
    .returning({ count: t.count });
  const count = row?.count ?? Number.MAX_SAFE_INTEGER;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}
