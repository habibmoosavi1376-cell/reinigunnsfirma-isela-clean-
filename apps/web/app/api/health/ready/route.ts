import { checkReadiness, healthResponse } from "@/lib/server/health";
import { getServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

/** Readiness: the database answers within the time limit (503 otherwise). */
export async function GET(): Promise<Response> {
  return healthResponse(await checkReadiness(getServices().database.db));
}
