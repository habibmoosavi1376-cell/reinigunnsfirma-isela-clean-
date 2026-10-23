import "server-only";
import { isDomainError, type DomainLogger, type LogFields } from "@isela/shared";

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

/**
 * JSON logger for domain events (booking created, job created, assignment failed, payment
 * guard blocked, …). The domain passes primitive fields only (ids, codes, counts); no
 * names, addresses, phone numbers, e-mail addresses or secrets.
 */
export const domainLogger: DomainLogger = {
  info(event: string, fields: LogFields = {}) {
    console.info(
      JSON.stringify({ level: "info", event, ...fields, time: new Date().toISOString() }),
    );
  },
  warn(event: string, fields: LogFields = {}) {
    console.warn(
      JSON.stringify({ level: "warn", event, ...fields, time: new Date().toISOString() }),
    );
  },
};
