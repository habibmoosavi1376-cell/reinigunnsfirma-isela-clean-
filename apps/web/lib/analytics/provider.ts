import { hasConsent, type ConsentPurpose, type ConsentState } from "./consent";
import { sanitizeAnalyticsEvent, type AnalyticsEvent } from "./events";

/**
 * Provider abstraction (day 7). No analytics provider is approved yet: the only
 * implementation is the no-op provider, which measures nothing. A real provider must declare
 * the consent purpose it needs; events are only handed over with that consent.
 */
export interface AnalyticsProvider {
  readonly id: string;
  /** false = nothing is ever sent (no provider configured). */
  readonly enabled: boolean;
  readonly purpose: ConsentPurpose;
  send(event: AnalyticsEvent): Promise<void>;
}

export const NOOP_ANALYTICS_PROVIDER: AnalyticsProvider = {
  id: "none",
  enabled: false,
  purpose: "statistics",
  send: () => Promise.resolve(),
};

export type TrackOutcome = "SENT" | "NO_PROVIDER" | "NO_CONSENT" | "INVALID_EVENT" | "FAILED";

/**
 * Hands an event to the provider only if (1) a provider is enabled, (2) the visitor gave
 * consent for the provider's purpose and (3) the event passes the allowlist. Never throws:
 * analytics must not break a page or a form submission.
 */
export async function trackEvent(
  provider: AnalyticsProvider,
  consent: ConsentState,
  input: unknown,
): Promise<TrackOutcome> {
  if (!provider.enabled) return "NO_PROVIDER";
  if (!hasConsent(consent, provider.purpose)) return "NO_CONSENT";
  const event = sanitizeAnalyticsEvent(input);
  if (event === null) return "INVALID_EVENT";
  try {
    await provider.send(event);
    return "SENT";
  } catch {
    return "FAILED";
  }
}

/** Maps the configured provider id to an implementation (only "none" exists so far). */
const PROVIDERS: Readonly<Record<"none", AnalyticsProvider>> = { none: NOOP_ANALYTICS_PROVIDER };

export function analyticsProviderFor(id: keyof typeof PROVIDERS): AnalyticsProvider {
  return PROVIDERS[id];
}
