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
  invoice_created: "Der Rechnungsentwurf wurde aus der Buchung erzeugt.",
  invoice_issued: "Die Rechnung wurde ausgestellt und nummeriert.",
  invoice_released: "Die Rechnung wurde freigegeben; die Zahlung wird erwartet.",
  invoice_cancelled: "Der Rechnungsentwurf wurde verworfen.",
  invoice_voided: "Die Rechnung wurde storniert (Nummer bleibt vergeben).",
  due_date_changed: "Die Fälligkeit wurde geändert (protokolliert).",
  payment_recorded: "Der Zahlungseingang wurde erfasst und wartet auf Bestätigung.",
  payment_duplicate: "Diese Zahlung war bereits erfasst – es wurde nichts doppelt gebucht.",
  payment_confirmed: "Die Zahlung wurde bestätigt und der Rechnung zugeordnet.",
  payment_failed: "Die Zahlung wurde als fehlgeschlagen markiert.",
  refund_requested: "Die Erstattung wurde angestoßen.",
  refund_completed: "Die Erstattung wurde abgeschlossen.",
  refund_aborted: "Die Erstattung wurde abgebrochen.",
  chargeback_recorded: "Die Rückbuchung wurde erfasst; künftige Aufträge sind geschützt.",
  review_cleared: "Die Zahlungsprüfung der Buchung wurde abgeschlossen.",
  credit_requested: "Der Antrag auf Rechnungskauf wurde gestellt.",
  credit_approved: "Der Rechnungskauf wurde freigegeben.",
  credit_denied: "Der Antrag auf Rechnungskauf wurde abgelehnt.",
  credit_revoked:
    "Der Rechnungskauf wurde widerrufen; offene Termine sind auf Vorkasse umgestellt.",
  risk_reevaluated: "Das Zahlungsrisiko wurde neu bewertet.",
  overdue_run: "Der Fälligkeitslauf wurde ausgeführt.",
} as const;

export type CrmActionNotice = keyof typeof CRM_ACTION_NOTICES;

export const CRM_ACTION_ERRORS: Record<string, string> = {
  ...LEAD_ACTION_ERRORS,
  VALIDATION_FAILED: "Die Eingaben sind ungültig. Bitte Pflichtfelder und Formate prüfen.",
  NOT_FOUND: "Der Datensatz wurde nicht gefunden oder gehört nicht zu diesem Kunden.",
  CONFIG_REQUIRED:
    "Es fehlen noch freigegebene Konfigurationswerte (CONFIG_REQUIRED, z. B. Preisregeln oder Rechnungseinstellungen). Es wurde nichts übernommen.",
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
