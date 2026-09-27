import "server-only";
import { isDomainError } from "@isela/shared";

/**
 * Minimal structured logger. Logs error classes, codes and correlation ids – never request
 * bodies, e-mail addresses, names or stack traces of domain errors.
 */
export function logServerError(event: string, error: unknown, correlationId?: string): void {
  const entry = {
    level: "error",
    event,
    correlationId,
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: isDomainError(error) ? error.code : undefined,
    time: new Date().toISOString(),
  };
  console.error(JSON.stringify(entry));
}
