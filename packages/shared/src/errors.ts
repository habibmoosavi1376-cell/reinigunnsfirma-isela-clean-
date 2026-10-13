export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "MFA_REQUIRED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "POLICY_VIOLATION"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR"
  /** A business value (e.g. a price rule) has not been decided yet – no automatic result. */
  | "CONFIG_REQUIRED";

/**
 * Error raised by domain and application services. Messages and details must never
 * contain secrets or personal data – they may be logged or returned to clients.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown, code?: ErrorCode): error is DomainError {
  return error instanceof DomainError && (code === undefined || error.code === code);
}
