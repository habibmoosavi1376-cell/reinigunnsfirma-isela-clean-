/**
 * Analytics events (day 7, framework-free). A closed list of event names and a closed list of
 * properties. Events carry NO personal data: no names, e-mail addresses, phone numbers,
 * addresses, free text, query strings or record identifiers.
 */

export const ANALYTICS_EVENT_NAMES = [
  "page_view",
  "service_view",
  "request_started",
  "request_submitted",
  "callback_requested",
  "quote_viewed",
  "quote_accepted",
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export const ANALYTICS_CUSTOMER_TYPES = ["PRIVATE", "BUSINESS", "PROPERTY_MANAGEMENT"] as const;

export interface AnalyticsEvent {
  readonly name: AnalyticsEventName;
  /** Path only (no query, no fragment); identifiers are replaced by ":id". */
  readonly path?: string;
  /** Public service URL slug (catalogue data, not personal). */
  readonly serviceSlug?: string;
  readonly customerType?: (typeof ANALYTICS_CUSTOMER_TYPES)[number];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PATH_LENGTH = 200;

/**
 * Reduces a URL or path to a privacy-safe path: strips origin, query and fragment and
 * replaces id-like segments (UUIDs, digits, long tokens) with ":id".
 */
export function sanitizePath(raw: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(raw, "http://localhost").pathname;
  } catch {
    return null;
  }
  const segments = pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return ":id";
      }
      if (UUID.test(decoded) || /\d/.test(decoded) || decoded.length > 40) return ":id";
      return SLUG.test(decoded) ? decoded : ":id";
    });
  const path = `/${segments.join("/")}`;
  return path.length > MAX_PATH_LENGTH ? null : path;
}

/**
 * Validates an event against the allowlist. Unknown names or properties drop the WHOLE event
 * (fail closed) – a property that is not explicitly allowed could contain personal data.
 */
export function sanitizeAnalyticsEvent(input: unknown): AnalyticsEvent | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const allowedKeys = new Set(["name", "path", "serviceSlug", "customerType"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
  const name = record["name"];
  if (typeof name !== "string" || !(ANALYTICS_EVENT_NAMES as readonly string[]).includes(name)) {
    return null;
  }
  const event: {
    name: AnalyticsEventName;
    path?: string;
    serviceSlug?: string;
    customerType?: (typeof ANALYTICS_CUSTOMER_TYPES)[number];
  } = { name: name as AnalyticsEventName };
  if (record["path"] !== undefined) {
    if (typeof record["path"] !== "string") return null;
    const path = sanitizePath(record["path"]);
    if (path === null) return null;
    event.path = path;
  }
  if (record["serviceSlug"] !== undefined) {
    const slug = record["serviceSlug"];
    if (typeof slug !== "string" || !SLUG.test(slug) || slug.length > 64) return null;
    event.serviceSlug = slug;
  }
  if (record["customerType"] !== undefined) {
    const type = record["customerType"];
    if (
      typeof type !== "string" ||
      !(ANALYTICS_CUSTOMER_TYPES as readonly string[]).includes(type)
    ) {
      return null;
    }
    event.customerType = type as (typeof ANALYTICS_CUSTOMER_TYPES)[number];
  }
  return event;
}
