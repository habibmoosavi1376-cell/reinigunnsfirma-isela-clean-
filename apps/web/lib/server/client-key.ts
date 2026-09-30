import "server-only";
import { headers } from "next/headers";
import { getServices } from "./services";

/**
 * Client identifier for rate limiting of public forms. Uses the configured proxy header
 * (AUTH_IP_ADDRESS_HEADERS, default x-forwarded-for). The deployment's reverse proxy must
 * overwrite this header; otherwise clients could rotate it (documented in the report).
 * The value is hashed before it is stored.
 */
export async function getClientKey(): Promise<string> {
  const { env } = getServices();
  const requestHeaders = await headers();
  const candidates =
    env.AUTH_IP_ADDRESS_HEADERS.length > 0 ? env.AUTH_IP_ADDRESS_HEADERS : ["x-forwarded-for"];
  for (const name of candidates) {
    const value = requestHeaders.get(name);
    const first = value?.split(",")[0]?.trim();
    if (first !== undefined && first !== "") {
      return first;
    }
  }
  return "unknown-client";
}
