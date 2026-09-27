/** German UI labels for back-office enums (display only; no logic depends on them). */

export const LEAD_STATUS_LABELS: Record<string, string> = {
  DISCOVERED: "Neu",
  RESEARCHING: "In Recherche",
  QUALIFIED: "Qualifiziert",
  OUTREACH_DRAFTED: "Ansprache vorbereitet",
  CONTACTED: "Kontaktiert",
  RESPONSE: "Rückmeldung",
  QUALIFIED_OPPORTUNITY: "Qualifizierte Chance",
  QUOTE_REQUEST: "Angebotsanfrage",
  QUOTE_SENT: "Angebot gesendet",
  NEGOTIATION: "Verhandlung",
  WON: "Gewonnen",
  LOST: "Verloren",
  FOLLOW_UP: "Wiedervorlage",
};

export const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  PRIVATE: "Privat",
  BUSINESS: "Gewerbe",
  PROPERTY_MANAGEMENT: "Hausverwaltung/Immobilien",
};

export const AVAILABILITY_LABELS: Record<string, string> = {
  AVAILABLE: "Im Servicegebiet",
  NOT_AVAILABLE: "Außerhalb",
  UNKNOWN: "Unbekannt",
};

export const GEOCODING_STATUS_LABELS: Record<string, string> = {
  PENDING: "Ausstehend",
  SUCCEEDED: "Erfolgreich",
  FAILED: "Nicht gefunden",
  MANUAL: "Manuell bestätigt",
  NEEDS_REVIEW: "Prüfung erforderlich",
};

export const GEOCODING_OUTCOME_LABELS: Record<string, string> = {
  ACCEPTED: "Automatisch übernommen",
  NEEDS_REVIEW: "Unsicher – Prüfung erforderlich",
  NO_MATCH: "Kein Treffer",
  UNAVAILABLE: "Anbieter nicht verfügbar",
  MANUAL_CONFIRMED: "Manuell bestätigt",
  MANUAL_REJECTED: "Manuell verworfen",
};

export const GEOCODING_REASON_LABELS: Record<string, string> = {
  PRECISION_TOO_LOW: "nicht gebäudegenau",
  LOW_CONFIDENCE: "geringe Konfidenz",
  POSTAL_CODE_MISMATCH: "PLZ weicht ab",
  STREET_MISMATCH: "Straße weicht ab",
  HOUSE_NUMBER_MISMATCH: "Hausnummer weicht ab",
  COUNTRY_MISMATCH: "anderes Land",
  NO_RESULT: "kein Ergebnis",
  NOT_CONFIGURED: "nicht konfiguriert",
  AUTH_FAILED: "Zugangsdaten ungültig",
  RATE_LIMITED: "Kontingent/Rate-Limit",
  TIMEOUT: "Zeitüberschreitung",
  PROVIDER_ERROR: "Anbieterfehler",
  INVALID_RESPONSE: "ungültige Antwort",
};

export const FREQUENCY_LABELS: Record<string, string> = {
  ONCE: "Einmalig",
  WEEKLY: "Wöchentlich",
  BIWEEKLY: "Zweiwöchentlich",
  MONTHLY: "Monatlich",
  CUSTOM: "Individuell",
};

export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  APARTMENT: "Wohnung",
  HOUSE: "Haus",
  OFFICE: "Büro",
  PRACTICE: "Praxis",
  STAIRWELL: "Treppenhaus",
  COMMERCIAL: "Gewerbefläche",
  OTHER: "Sonstiges",
};

export const CONSENT_PURPOSE_LABELS: Record<string, string> = {
  MARKETING_EMAIL: "Werbung per E-Mail",
  MARKETING_PHONE: "Werbung per Telefon",
  COOKIES_ANALYTICS: "Analyse-Cookies",
  REVIEW_REQUEST: "Bewertungsanfrage",
  REFERRAL_CONTACT: "Empfehlungskontakt",
  OTHER_COMMUNICATION: "Sonstige Kommunikation",
};

export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined) return "–";
  return map[value] ?? value;
}
