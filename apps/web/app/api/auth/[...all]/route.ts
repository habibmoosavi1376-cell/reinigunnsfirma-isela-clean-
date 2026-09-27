import { toNextJsHandler } from "better-auth/next-js";
import { getServices } from "@/lib/server/services";

/** Better Auth endpoints (sign-up, sign-in, sign-out, verification, reset, 2FA). */
function handler() {
  return toNextJsHandler(getServices().auth);
}

export function GET(request: Request) {
  return handler().GET(request);
}

export function POST(request: Request) {
  return handler().POST(request);
}
