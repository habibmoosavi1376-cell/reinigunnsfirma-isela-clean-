import { healthResponse } from "@/lib/server/health";

/** Liveness: the process answers. No dependencies are checked. */
export function GET(): Response {
  return healthResponse("ok");
}
