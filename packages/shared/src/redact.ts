const SENSITIVE_KEY_PATTERN =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|iban|bic|card|cvc|cvv|backup[-_]?codes?/i;

export const REDACTED = "[REDACTED]";

/**
 * Returns a deep copy of `value` in which values of sensitive keys are replaced.
 * Used before data is written to audit logs or application logs.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitive(nested);
    }
    return result;
  }
  return value;
}
