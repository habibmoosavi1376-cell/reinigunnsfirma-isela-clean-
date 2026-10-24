import { sql, type DbExecutor } from "@isela/database";

/*
 * Health checks (launch readiness). Liveness needs nothing; readiness checks that the
 * database answers within a time limit. Responses carry a status only – no versions, hosts,
 * error messages or counts.
 */

export type ReadinessStatus = "ok" | "unavailable";

export async function checkReadiness(db: DbExecutor, timeoutMs = 2000): Promise<ReadinessStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([db.execute(sql`SELECT 1 AS ok`), timeout]);
    return result === "timeout" ? "unavailable" : "ok";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

export function healthResponse(status: ReadinessStatus): Response {
  return Response.json(
    { status },
    { status: status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
