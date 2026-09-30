/**
 * Structured domain log port. Fields are restricted to primitives so that callers log ids,
 * codes and counts – never objects that could carry names, addresses, phone numbers,
 * e-mail addresses, notes or secrets. The web app provides a JSON implementation.
 */
export type LogFieldValue = string | number | boolean | null;

export type LogFields = Readonly<Record<string, LogFieldValue>>;

export interface DomainLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

/** Logger that discards everything (default when no logger is configured). */
export const noopLogger: DomainLogger = {
  info() {},
  warn() {},
};
