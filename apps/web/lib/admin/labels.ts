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
  PRIVATE_HOME: "Haus (privat)",
  RETAIL: "Einzelhandel",
  GASTRONOMY: "Gastronomie",
  GYM: "Fitnessstudio",
  HOLIDAY_RENTAL: "Ferienwohnung",
  PROPERTY_MANAGEMENT: "Hausverwaltung/Wohnanlage",
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

export const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Aktiv",
  INACTIVE: "Inaktiv",
  BLOCKED: "Gesperrt",
};

export const ADDRESS_TYPE_LABELS: Record<string, string> = {
  SERVICE: "Objekt-/Serviceadresse",
  BILLING: "Rechnungsadresse",
  OTHER: "Sonstige",
};

export const SERVICE_AREA_MEMBERSHIP_LABELS: Record<string, string> = {
  IN_AREA: "Im Servicegebiet",
  OUTSIDE: "Außerhalb",
  UNKNOWN: "Unbekannt (keine Koordinaten)",
};

export const VERIFICATION_STATUS_LABELS: Record<string, string> = {
  UNVERIFIED: "Ungeprüft",
  VERIFIED: "Geprüft",
  REJECTED: "Abgelehnt",
};

export const IDENTITY_KIND_LABELS: Record<string, string> = {
  EMAIL: "E-Mail",
  PHONE: "Telefon",
  TAX_ID: "Steuernummer",
  PAYMENT_REFERENCE: "Zahlungsreferenz",
  ADDRESS: "Adresse",
};

export const QUOTE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Entwurf",
  PENDING_REVIEW: "In Prüfung",
  SENT: "Freigegeben/versendet",
  ACCEPTED: "Angenommen",
  DECLINED: "Abgelehnt",
  EXPIRED: "Abgelaufen",
  CANCELLED: "Storniert",
};

export const QUOTE_TRANSITION_LABELS: Record<string, string> = {
  PENDING_REVIEW: "Zur Prüfung geben",
  DRAFT: "Zurück in Bearbeitung",
  SENT: "Freigeben",
  ACCEPTED: "Annahme erfassen",
  DECLINED: "Ablehnung erfassen",
  EXPIRED: "Als abgelaufen markieren",
  CANCELLED: "Stornieren",
};

export const SERVICE_UNIT_LABELS: Record<string, string> = {
  HOUR: "Stunde(n)",
  SQUARE_METER: "m²",
  FLAT: "pauschal",
  UNIT: "Stück",
};

export const PAYMENT_TERMS_LABELS: Record<string, string> = {
  PREPAYMENT: "Vorkasse",
  INVOICE: "Rechnungskauf",
};

export const PAYMENT_REASON_LABELS: Record<string, string> = {
  NEW_CUSTOMER: "Neukunde – noch keine bezahlten Aufträge",
  INSUFFICIENT_PAID_ORDERS: "Weniger als die erforderlichen abgeschlossenen und bezahlten Aufträge",
  OPEN_OVERDUE_INVOICE: "Offene überfällige Rechnung",
  LATE_PAYMENT_HISTORY: "Verspätete Zahlungen im Betrachtungszeitraum",
  RECENT_CHARGEBACK: "Rücklastschrift/Chargeback im Betrachtungszeitraum",
  PENDING_DUPLICATE_REVIEW: "Dublettenprüfung offen",
  TRUST_SCORE_TOO_LOW: "Vertrauenswert zu niedrig oder nicht vorhanden",
  CREDIT_LIMIT_EXCEEDED: "Kreditlimit ausgeschöpft",
  B2C_INVOICE_TERMS_DISABLED: "Rechnungskauf für Privatkunden deaktiviert",
  CUSTOMER_BLOCKED: "Kunde gesperrt",
  MANUAL_OVERRIDE: "Manuelle Festlegung",
  FAILED_PAYMENTS: "Fehlgeschlagene Zahlungen im Betrachtungszeitraum",
  CREDIT_APPROVAL_REQUIRED: "Mindesthistorie erfüllt – Freigabe durch zweite Person erforderlich",
  CREDIT_TERMS_APPROVED: "Rechnungskauf freigegeben",
};

export const PAYMENT_OUTCOME_LABELS: Record<string, string> = {
  VORKASSE_REQUIRED: "Vorkasse erforderlich",
  CREDIT_TERMS_ALLOWED: "Rechnungskauf zulässig",
  BLOCKED: "Gesperrt",
  REVIEW_REQUIRED: "Prüfung erforderlich (Vorkasse)",
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Entwurf",
  ISSUED: "Ausgestellt",
  OPEN: "Offen",
  PARTIALLY_PAID: "Teilweise bezahlt",
  PAID: "Bezahlt",
  OVERDUE: "Überfällig",
  CANCELLED: "Verworfen",
  VOID: "Storniert",
};

export const INVOICE_KIND_LABELS: Record<string, string> = {
  PREPAYMENT: "Vorkasse-Rechnung",
  FINAL: "Rechnung (nach Leistung)",
};

export const PAYMENT_RECORD_STATUS_LABELS: Record<string, string> = {
  PENDING: "Erfasst – Bestätigung offen",
  AUTHORIZED: "Autorisiert",
  CONFIRMED: "Bestätigt",
  FAILED: "Fehlgeschlagen",
  REFUND_PENDING: "Erstattung läuft",
  REFUNDED: "Erstattet",
  CHARGED_BACK: "Rückbuchung",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  BANK_TRANSFER: "Überweisung",
  SEPA_DIRECT_DEBIT: "SEPA-Lastschrift",
  CARD: "Karte (Zahlungsanbieter)",
};

export const CREDIT_TERMS_STATUS_LABELS: Record<string, string> = {
  REQUESTED: "Beantragt",
  APPROVED: "Freigegeben",
  DENIED: "Abgelehnt",
  REVOKED: "Widerrufen",
};

export const BOOKING_STATUS_LABELS: Record<string, string> = {
  REQUESTED: "Angefragt",
  PENDING_PAYMENT: "Wartet auf Vorkasse",
  CONFIRMED: "Bestätigt",
  SCHEDULED: "Eingeplant",
  CANCELLED: "Storniert",
  COMPLETED: "Erledigt",
};

export const PAYMENT_REQUIREMENT_LABELS: Record<string, string> = {
  VORKASSE_REQUIRED: "Vorkasse erforderlich",
  CREDIT_TERMS_APPROVED: "Freigegebene Zahlungsbedingung (Rechnung)",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PAYMENT_REQUIRED: "Zahlung erforderlich",
  PAYMENT_PENDING: "Zahlung erwartet",
  PAYMENT_CONFIRMED: "Zahlung bestätigt",
  PAYMENT_FAILED: "Zahlung fehlgeschlagen",
  REFUND_PENDING: "Erstattung ausstehend",
  REFUNDED: "Erstattet",
};

export const PAYMENT_TRANSITION_LABELS: Record<string, string> = {
  PAYMENT_PENDING: "Zahlung erwartet",
  PAYMENT_CONFIRMED: "Zahlungseingang bestätigen",
  PAYMENT_FAILED: "Zahlung fehlgeschlagen",
  REFUND_PENDING: "Erstattung anstoßen",
  REFUNDED: "Erstattung erledigt",
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  PLANNED: "Geplant",
  ASSIGNMENT_PENDING: "Zuweisung offen",
  ASSIGNED: "Zugewiesen",
  IN_PROGRESS: "In Ausführung",
  COMPLETED: "Ausgeführt",
  QUALITY_CHECK: "Qualitätsprüfung",
  CLOSED: "Abgeschlossen",
  CANCELLED: "Storniert",
};

export const JOB_TRANSITION_LABELS: Record<string, string> = {
  ASSIGNMENT_PENDING: "Zur Disposition freigeben",
  IN_PROGRESS: "Einsatz beginnen",
  COMPLETED: "Einsatz abschließen",
  QUALITY_CHECK: "Qualitätsprüfung starten",
  CLOSED: "Einsatz schließen",
};

export const FULFILLMENT_LABELS: Record<string, string> = {
  IN_HOUSE: "Eigenes Personal",
  PARTNER: "Partnerbetrieb",
};

export const CANDIDATE_BLOCKER_LABELS: Record<string, string> = {
  INACTIVE: "nicht aktiv",
  NOT_VERIFIED: "nicht verifiziert",
  PARTNER_ASSIGNMENT_DISABLED: "Partnerzuweisung nicht freigegeben (Owner-Regel)",
  MISSING_QUALIFICATION: "Qualifikation fehlt",
  SERVICE_NOT_OFFERED: "Leistung nicht im Angebot",
  SERVICE_UNKNOWN: "Position ohne Katalogleistung",
  SERVICE_AREA_UNKNOWN: "Servicegebiet unbekannt (keine Koordinaten)",
  OUTSIDE_SERVICE_AREA: "außerhalb des Gebiets",
  OUTSIDE_WORKING_HOURS: "außerhalb der Arbeitszeit",
  UNAVAILABLE: "abwesend",
  TIME_CONFLICT: "Terminüberschneidung",
  CAPACITY_EXHAUSTED: "Kapazität erschöpft",
  CAPACITY_NOT_CONFIGURED: "Kapazität nicht konfiguriert",
  DOCUMENTS_MISSING: "Nachweise fehlen/abgelaufen",
};

export const SCORE_FACTOR_LABELS: Record<string, string> = {
  distance: "Entfernung",
  qualification: "Qualifikation",
  availability: "Verfügbarkeit",
  serviceMatch: "Leistung",
  capacity: "Kapazität",
  reliability: "Zuverlässigkeit",
};

export const PARTNER_STATUS_LABELS: Record<string, string> = {
  PENDING_VERIFICATION: "Prüfung ausstehend",
  ACTIVE: "Aktiv (verifiziert)",
  SUSPENDED: "Gesperrt",
};

export const PARTNER_DOCUMENT_KIND_LABELS: Record<string, string> = {
  TRADE_REGISTRATION: "Gewerbenachweis",
  LIABILITY_INSURANCE: "Betriebshaftpflicht",
  OTHER: "Sonstiger Nachweis",
};

export const PARTNER_DOCUMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Ungeprüft",
  VERIFIED: "Geprüft",
  REJECTED: "Abgelehnt",
};

export const DURATION_MODEL_LABELS: Record<string, string> = {
  MANUAL: "Manuell je Auftrag",
  FIXED: "Feste Dauer",
  PER_UNIT: "Je Einheit",
};

export const PRICING_STRATEGY_LABELS: Record<string, string> = {
  MANUAL_QUOTE: "Manuelles Angebot",
  RULE_BASED: "Preisregeln (Pricing Engine)",
};

export const RULE_SET_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Entwurf",
  ACTIVE: "Aktiv",
  RETIRED: "Abgelöst",
};

export const PRICING_SOURCE_LABELS: Record<string, string> = {
  MANUAL: "manuell",
  ENGINE: "Pricing Engine",
  ENGINE_OVERRIDDEN: "Engine, übersteuert",
};

export const UNAVAILABILITY_KIND_LABELS: Record<string, string> = {
  ABSENCE: "Abwesenheit",
  TRAINING: "Schulung",
  OTHER: "Sonstiges",
};

export const WEEKDAY_LABELS: Record<string, string> = {
  "1": "Montag",
  "2": "Dienstag",
  "3": "Mittwoch",
  "4": "Donnerstag",
  "5": "Freitag",
  "6": "Samstag",
  "7": "Sonntag",
};

export const URGENCY_LABELS: Record<string, string> = {
  STANDARD: "Standard",
  EXPRESS: "Express",
};

export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined) return "–";
  return map[value] ?? value;
}
