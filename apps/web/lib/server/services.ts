import "server-only";
import { parseServerEnv } from "@isela/config";
import { createWebServices, type WebServices } from "./composition";

const globalForServices = globalThis as unknown as { __iselaWebServices?: WebServices };

/**
 * Lazily created singleton (survives dev hot reloads). The environment is validated on first
 * use; `instrumentation.ts` triggers this at server start so misconfiguration fails fast.
 */
export function getServices(): WebServices {
  globalForServices.__iselaWebServices ??= createWebServices(parseServerEnv(process.env));
  return globalForServices.__iselaWebServices;
}
