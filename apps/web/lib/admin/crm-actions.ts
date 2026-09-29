import { LEAD_ACTION_ERRORS } from "./lead-actions";

/** Whitelisted result codes of customer/property/quote actions (?notice= / ?error=). */
export const CRM_ACTION_NOTICES = {
  customer_updated: "Die Stammdaten wurden gespeichert.",
  address_added: "Die Adresse wurde angelegt.",
  address_added_duplicate:
    "Die Adresse wurde angelegt. Hinweis: Eine gleichwertige Adresse existiert bereits.",
  address_updated: "Die Adresse wurde geändert. Die Koordinaten werden neu ermittelt.",
  primary_changed: "Die Hauptadresse wurde geändert.",
  property_created: "Das Objekt wurde angelegt.",
  property_updated: "Das Objekt wurde gespeichert.",
  quote_created: "Der Angebotsentwurf wurde angelegt.",
  quote_item_added: "Die Position wurde hinzugefügt.",
  quote_item_removed: "Die Position wurde entfernt.",
  quote_updated: "Das Angebot wurde gespeichert.",
  quote_transitioned: "Der Angebotsstatus wurde geändert.",
  price_calculated: "Die Preisberechnung wurde gespeichert.",
  booking_created: "Die Buchung wurde angelegt.",
  booking_cancelled: "Die Buchung wurde storniert.",
  payment_changed: "Der Zahlungsstatus wurde geändert.",
  job_created: "Der Einsatz wurde geplant.",
  job_transitioned: "Der Einsatzstatus wurde geändert.",
  job_assigned: "Der Einsatz wurde zugewiesen.",
  job_released: "Die Zuweisung wurde aufgehoben.",
  job_reassigned: "Der Einsatz wurde neu zugewiesen.",
  service_saved: "Die Leistung wurde gespeichert.",
  category_saved: "Die Kategorie wurde gespeichert.",
  option_saved: "Das Extra wurde gespeichert.",
  rule_set_saved: "Der Preisregel-Entwurf wurde gespeichert.",
  rule_set_activated: "Die Preisregeln wurden aktiviert.",
  employee_saved: "Die Mitarbeiterdaten wurden gespeichert.",
  partner_saved: "Die Partnerdaten wurden gespeichert.",
  partner_verified: "Der Partner wurde verifiziert und aktiviert.",
} as const;

export type CrmActionNotice = keyof typeof CRM_ACTION_NOTICES;

export const CRM_ACTION_ERRORS: Record<string, string> = {
  ...LEAD_ACTION_ERRORS,
  VALIDATION_FAILED: "Die Eingaben sind ungültig. Bitte Pflichtfelder und Formate prüfen.",
  NOT_FOUND: "Der Datensatz wurde nicht gefunden oder gehört nicht zu diesem Kunden.",
  CONFIG_REQUIRED:
    "Für diese Berechnung fehlen noch freigegebene Preisregeln (CONFIG_REQUIRED). Es wurde kein Preis übernommen.",
};

export function crmNoticeText(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(CRM_ACTION_NOTICES, value)
    ? CRM_ACTION_NOTICES[value as CrmActionNotice]
    : null;
}

export function crmErrorText(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(CRM_ACTION_ERRORS, value)
    ? (CRM_ACTION_ERRORS[value] ?? null)
    : null;
}
