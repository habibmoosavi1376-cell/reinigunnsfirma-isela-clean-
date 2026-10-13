import "server-only";
import { cookies } from "next/headers";
import {
  CONSENT_COOKIE_NAME,
  parseConsentCookie,
  type ConsentState,
} from "@/lib/analytics/consent";
import { trackEvent, type TrackOutcome } from "@/lib/analytics/provider";
import { getServices } from "./services";

/** The visitor's consent as stored in the first-party cookie ("no decision" = no consent). */
export async function currentConsent(): Promise<ConsentState> {
  const value = (await cookies()).get(CONSENT_COOKIE_NAME)?.value;
  return parseConsentCookie(value, getServices().clock.now());
}

/**
 * Server-side event (e.g. after a successful form submission). Consent and the event
 * allowlist are enforced in `trackEvent`; failures never affect the caller.
 */
export async function trackServerEvent(input: unknown): Promise<TrackOutcome> {
  try {
    return await trackEvent(getServices().analytics, await currentConsent(), input);
  } catch {
    return "FAILED";
  }
}
