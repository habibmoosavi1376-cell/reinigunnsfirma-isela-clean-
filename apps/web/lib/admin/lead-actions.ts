/** Whitelisted result codes of lead actions (shown via ?notice= / ?error=). */

export const LEAD_ACTION_NOTICES = {
  status_changed: "Der Status wurde geändert.",
  geocoding_done: "Das Geocoding wurde ausgeführt.",
  geocoding_reviewed: "Die Geocoding-Prüfung wurde gespeichert.",
  address_changed: "Die Adresse wurde geändert und neu geprüft.",
  customer_linked: "Der Lead ist mit einem Kundendatensatz verknüpft.",
  account_linked: "Das Nutzerkonto ist mit dem Kundendatensatz verknüpft.",
  consent_withdrawn: "Der Widerruf wurde dokumentiert.",
} as const;

export type LeadActionNotice = keyof typeof LEAD_ACTION_NOTICES;

export const LEAD_ACTION_ERRORS: Record<string, string> = {
  VALIDATION_FAILED: "Die Eingaben sind ungültig. Bitte prüfen (z. B. Grund bei Verlust angeben).",
  INVALID_STATE_TRANSITION: "Dieser Schritt ist im aktuellen Zustand nicht erlaubt.",
  POLICY_VIOLATION: "Dieser Schritt ist nach den Richtlinien nicht zulässig.",
  CONFLICT: "Der Datensatz wurde zwischenzeitlich geändert oder ist bereits anders verknüpft.",
  NOT_FOUND: "Die benötigten Daten wurden nicht gefunden (z. B. kein verifiziertes Konto).",
  FORBIDDEN: "Für diese Aktion fehlt die Berechtigung.",
  MFA_REQUIRED: "Für diese Aktion ist die Zwei-Faktor-Authentifizierung erforderlich.",
  UNAUTHENTICATED: "Bitte melden Sie sich erneut an.",
  RATE_LIMITED: "Zu viele Anfragen. Bitte später erneut versuchen.",
  UNEXPECTED: "Die Aktion ist fehlgeschlagen. Bitte später erneut versuchen.",
};

export function noticeText(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(LEAD_ACTION_NOTICES, value)
    ? LEAD_ACTION_NOTICES[value as LeadActionNotice]
    : null;
}

export function errorText(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(LEAD_ACTION_ERRORS, value)
    ? (LEAD_ACTION_ERRORS[value] ?? null)
    : null;
}
