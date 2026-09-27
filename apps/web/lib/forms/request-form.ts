/**
 * Maps the HTML form of the request page to the domain input (framework-free, unit-tested).
 * Only whitelisted fields are copied – any other form field is ignored and can therefore
 * never reach the domain (mass-assignment protection in addition to the strict schema).
 */

export const PRIVACY_NOTICE_VERSION = "2026-09-entwurf";
export const MARKETING_CONSENT_TEXT_VERSION = "2026-09-marketing-v1";

const TEXT_FIELDS = [
  "customerType",
  "fullName",
  "companyName",
  "email",
  "phone",
  "street",
  "houseNumber",
  "postalCode",
  "city",
  "serviceCategoryKey",
  "propertyType",
  "frequency",
  "message",
] as const;

export type RequestFormField =
  (typeof TEXT_FIELDS)[number] | "approximateAreaSqm" | "privacyNoticeAcknowledged";

export interface FormValues {
  get(name: string): FormDataEntryValue | null;
}

function text(form: FormValues, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Returns the domain input and whether the honeypot field was filled (bot). */
export function mapRequestForm(form: FormValues): {
  input: Record<string, unknown>;
  isBot: boolean;
} {
  const input: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    const value = text(form, field);
    if (value !== undefined) input[field] = value;
  }
  const area = text(form, "approximateAreaSqm");
  if (area !== undefined) {
    const parsed = Number(area.replace(",", "."));
    input["approximateAreaSqm"] = Number.isFinite(parsed) ? parsed : area;
  }
  // Only meaningful for property management; the domain rejects it for other customer types.
  const properties = text(form, "numberOfProperties");
  if (properties !== undefined) {
    const parsed = Number(properties);
    input["numberOfProperties"] = Number.isInteger(parsed) ? parsed : properties;
  }
  // Checkbox: only the literal "on"/"true" counts as an acknowledgement.
  const acknowledged = form.get("privacyNoticeAcknowledged");
  input["privacyNoticeAcknowledged"] = acknowledged === "on" || acknowledged === "true";
  input["privacyNoticeVersion"] = PRIVACY_NOTICE_VERSION;
  const marketing = form.get("marketingConsent");
  const marketingConsent = marketing === "on" || marketing === "true";
  input["marketingConsent"] = marketingConsent;
  if (marketingConsent) {
    input["marketingConsentTextVersion"] = MARKETING_CONSENT_TEXT_VERSION;
  }
  input["country"] = "DE";
  const honeypot = text(form, "website");
  return { input, isBot: honeypot !== undefined };
}

/**
 * The visitor's own input, echoed back after a failed submission so that React's automatic
 * form reset does not wipe the form. Whitelisted fields only (never the honeypot), capped.
 */
export type RequestFormValues = Partial<
  Record<(typeof TEXT_FIELDS)[number] | "approximateAreaSqm" | "numberOfProperties", string>
> & {
  readonly marketingConsent?: boolean;
};

const MAX_ECHO_LENGTH = 2000;

export function echoRequestFormValues(form: FormValues): RequestFormValues {
  const values: Partial<Record<string, string>> = {};
  for (const field of [...TEXT_FIELDS, "approximateAreaSqm", "numberOfProperties"] as const) {
    const value = form.get(field);
    if (typeof value === "string" && value !== "") values[field] = value.slice(0, MAX_ECHO_LENGTH);
  }
  const marketing = form.get("marketingConsent");
  return { ...values, marketingConsent: marketing === "on" || marketing === "true" };
}

export type RequestFormState =
  | { readonly status: "idle" }
  | { readonly status: "success" }
  | {
      readonly status: "error";
      readonly message: string;
      readonly fieldErrors: Partial<Record<string, string>>;
      readonly values: RequestFormValues;
    };

const FIELD_MESSAGES: Partial<Record<string, string>> = {
  customerType: "Bitte wählen Sie aus, für wen die Reinigung ist.",
  fullName: "Bitte geben Sie Ihren Namen an.",
  companyName: "Bitte geben Sie den Firmennamen an.",
  email: "Bitte geben Sie eine gültige E-Mail-Adresse an.",
  phone: "Bitte prüfen Sie die Telefonnummer.",
  street: "Bitte geben Sie die Straße an.",
  houseNumber: "Bitte geben Sie die Hausnummer an.",
  postalCode: "Bitte geben Sie eine gültige Postleitzahl an.",
  city: "Bitte geben Sie den Ort an.",
  serviceCategoryKey: "Bitte wählen Sie eine Leistung.",
  propertyType: "Bitte wählen Sie die Objektart.",
  approximateAreaSqm: "Bitte geben Sie die Fläche als Zahl in m² an.",
  numberOfProperties:
    "Die Anzahl der Objekte (ganze Zahl) ist nur bei Hausverwaltungen/Immobilien möglich.",
  frequency: "Bitte wählen Sie die gewünschte Häufigkeit.",
  message: "Die Nachricht darf höchstens 2000 Zeichen lang sein.",
  privacyNoticeAcknowledged:
    "Bitte bestätigen Sie, dass Sie die Datenschutzhinweise gelesen haben.",
};

/** Converts validation issue paths into user-facing, field-specific messages (no values). */
export function fieldErrorsFromIssues(
  issues: readonly { path: string }[],
): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  for (const issue of issues) {
    const field = issue.path.split(".")[0] ?? "";
    result[field] = FIELD_MESSAGES[field] ?? "Bitte prüfen Sie diese Angabe.";
  }
  return result;
}
