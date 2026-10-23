/**
 * Maps the "Rückruf anfordern" form to the domain input (framework-free, unit-tested).
 * Whitelist only; any other field is ignored (mass-assignment protection in addition to the
 * strict domain schema).
 */
import { PRIVACY_NOTICE_VERSION, type FormValues } from "./request-form";

const TEXT_FIELDS = [
  "customerType",
  "fullName",
  "phone",
  "postalCode",
  "serviceCategoryKey",
  "preferredWindow",
  "message",
] as const;

export type CallbackFormField = (typeof TEXT_FIELDS)[number] | "privacyNoticeAcknowledged";

function text(form: FormValues, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function mapCallbackForm(form: FormValues): {
  input: Record<string, unknown>;
  isBot: boolean;
} {
  const input: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    const value = text(form, field);
    if (value !== undefined) input[field] = value;
  }
  const acknowledged = form.get("privacyNoticeAcknowledged");
  input["privacyNoticeAcknowledged"] = acknowledged === "on" || acknowledged === "true";
  input["privacyNoticeVersion"] = PRIVACY_NOTICE_VERSION;
  input["country"] = "DE";
  const token = text(form, "submissionToken");
  if (token !== undefined) input["submissionToken"] = token;
  return { input, isBot: text(form, "website") !== undefined };
}

export type CallbackFormValues = Partial<Record<(typeof TEXT_FIELDS)[number], string>>;

const MAX_ECHO_LENGTH = 600;

/** The visitor's own input, echoed back after a failed submission (whitelisted, capped). */
export function echoCallbackFormValues(form: FormValues): CallbackFormValues {
  const values: CallbackFormValues = {};
  for (const field of TEXT_FIELDS) {
    const value = form.get(field);
    if (typeof value === "string" && value !== "") values[field] = value.slice(0, MAX_ECHO_LENGTH);
  }
  return values;
}

export type CallbackFormState =
  | { readonly status: "idle" }
  | { readonly status: "success" }
  | {
      readonly status: "error";
      readonly message: string;
      readonly fieldErrors: Partial<Record<string, string>>;
      readonly values: CallbackFormValues;
    };

const FIELD_MESSAGES: Partial<Record<string, string>> = {
  customerType: "Bitte wählen Sie aus, für wen die Reinigung ist.",
  fullName: "Bitte geben Sie Ihren Namen an.",
  phone: "Bitte geben Sie eine gültige Telefonnummer an.",
  postalCode: "Bitte geben Sie eine gültige Postleitzahl an (oder lassen Sie das Feld leer).",
  serviceCategoryKey: "Bitte wählen Sie eine Leistung aus der Liste.",
  preferredWindow: "Bitte wählen Sie einen Zeitraum aus der Liste.",
  message: "Die Nachricht darf höchstens 500 Zeichen lang sein.",
  privacyNoticeAcknowledged:
    "Bitte bestätigen Sie, dass Sie die Datenschutzhinweise gelesen haben.",
};

export function callbackFieldErrors(
  issues: readonly { path: string }[],
): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  for (const issue of issues) {
    const field = issue.path.split(".")[0] ?? "";
    result[field] = FIELD_MESSAGES[field] ?? "Bitte prüfen Sie diese Angabe.";
  }
  return result;
}
