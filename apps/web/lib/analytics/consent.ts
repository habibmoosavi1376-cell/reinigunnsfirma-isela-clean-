/**
 * Consent for optional processing (day 7, framework-free). Stored in a first-party cookie
 * on the visitor's device only. Technically necessary cookies (sign-in) need no consent and
 * are not covered here. Absence of a valid decision always means: NO consent.
 */

export const CONSENT_COOKIE_NAME = "isela_consent";
/** Re-ask after at most 12 months. */
export const CONSENT_MAX_AGE_SECONDS = 365 * 24 * 3600;
export const CONSENT_FORMAT_VERSION = "v1";

export type ConsentPurpose = "statistics" | "marketing";

export interface ConsentState {
  readonly statistics: boolean;
  readonly marketing: boolean;
  /** When the visitor decided; null = no decision yet. */
  readonly decidedAt: Date | null;
}

export const NO_CONSENT: ConsentState = { statistics: false, marketing: false, decidedAt: null };

const PATTERN = /^v1\.([01])\.([01])\.(\d{10,13})$/;

/** Parses the cookie value; anything malformed or expired counts as "no consent". */
export function parseConsentCookie(value: string | undefined, now: Date): ConsentState {
  if (value === undefined) return NO_CONSENT;
  const match = PATTERN.exec(value);
  if (match === null) return NO_CONSENT;
  const decidedAt = new Date(Number(match[3]));
  if (Number.isNaN(decidedAt.getTime())) return NO_CONSENT;
  const age = now.getTime() - decidedAt.getTime();
  if (age < -60_000 || age > CONSENT_MAX_AGE_SECONDS * 1000) return NO_CONSENT;
  return { statistics: match[1] === "1", marketing: match[2] === "1", decidedAt };
}

export function serializeConsentCookie(
  choice: { readonly statistics: boolean; readonly marketing: boolean },
  now: Date,
): string {
  return `${CONSENT_FORMAT_VERSION}.${choice.statistics ? "1" : "0"}.${
    choice.marketing ? "1" : "0"
  }.${String(now.getTime())}`;
}

export function hasConsent(state: ConsentState, purpose: ConsentPurpose): boolean {
  return state.decidedAt !== null && state[purpose];
}
