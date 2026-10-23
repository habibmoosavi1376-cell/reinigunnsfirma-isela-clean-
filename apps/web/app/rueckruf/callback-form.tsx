"use client";

import Link from "next/link";
import { startTransition, useActionState, type SubmitEvent } from "react";
import type { CallbackFormState, CallbackFormValues } from "@/lib/forms/callback-form";
import { submitCallbackAction } from "./actions";

export interface ServiceOption {
  readonly key: string;
  readonly name: string;
}

const INITIAL: CallbackFormState = { status: "idle" };

function FieldError({ state, name }: { state: CallbackFormState; name: string }) {
  if (state.status !== "error") return null;
  const message = state.fieldErrors[name];
  if (message === undefined) return null;
  return (
    <p className="field-error" id={`${name}-error`}>
      {message}
    </p>
  );
}

function describedBy(state: CallbackFormState, name: string, hint?: string): string | undefined {
  const ids = [
    hint,
    state.status === "error" && state.fieldErrors[name] !== undefined ? `${name}-error` : undefined,
  ];
  const joined = ids.filter((id) => id !== undefined).join(" ");
  return joined === "" ? undefined : joined;
}

export function CallbackForm({
  services,
  preselected,
  submissionToken,
}: {
  services: readonly ServiceOption[];
  preselected?: string;
  submissionToken: string;
}) {
  const [state, action, pending] = useActionState(submitCallbackAction, INITIAL);
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => {
      action(data);
    });
  };

  if (state.status === "success") {
    return (
      <div className="alert alert--success" role="status">
        <h2>Vielen Dank – Ihr Rückrufwunsch ist eingegangen.</h2>
        <p>
          Wir rufen Sie zurück, sobald es uns möglich ist, und berücksichtigen Ihren Wunschzeitraum
          nach Möglichkeit. Ein fester Termin ist damit nicht vereinbart.
        </p>
      </div>
    );
  }

  const invalid = (name: string) =>
    state.status === "error" && state.fieldErrors[name] !== undefined;
  const value = (name: keyof CallbackFormValues) =>
    state.status === "error" ? state.values[name] : undefined;

  return (
    <form className="form" action={action} onSubmit={onSubmit} noValidate>
      {state.status === "error" ? (
        <p className="alert alert--error" role="alert">
          {state.message}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="cb-fullName">Name</label>
        <input
          id="cb-fullName"
          name="fullName"
          defaultValue={value("fullName")}
          required
          autoComplete="name"
          maxLength={120}
          aria-invalid={invalid("fullName")}
          aria-describedby={describedBy(state, "fullName")}
        />
        <FieldError state={state} name="fullName" />
      </div>
      <div className="field">
        <label htmlFor="cb-phone">Telefonnummer</label>
        <input
          id="cb-phone"
          name="phone"
          type="tel"
          defaultValue={value("phone")}
          required
          autoComplete="tel"
          maxLength={40}
          aria-invalid={invalid("phone")}
          aria-describedby={describedBy(state, "phone")}
        />
        <FieldError state={state} name="phone" />
      </div>
      <div className="field">
        <label htmlFor="cb-customerType">Für wen ist die Reinigung?</label>
        <select
          id="cb-customerType"
          name="customerType"
          defaultValue={value("customerType") ?? "PRIVATE"}
          aria-invalid={invalid("customerType")}
          aria-describedby={describedBy(state, "customerType")}
        >
          <option value="PRIVATE">Privathaushalt</option>
          <option value="BUSINESS">Gewerbe</option>
          <option value="PROPERTY_MANAGEMENT">Hausverwaltung / Immobilien</option>
        </select>
        <FieldError state={state} name="customerType" />
      </div>
      <div className="field">
        <label htmlFor="cb-service">Leistung (optional)</label>
        <select
          id="cb-service"
          name="serviceCategoryKey"
          defaultValue={value("serviceCategoryKey") ?? preselected ?? ""}
          aria-invalid={invalid("serviceCategoryKey")}
          aria-describedby={describedBy(state, "serviceCategoryKey")}
        >
          <option value="">Noch offen</option>
          {services.map((service) => (
            <option key={service.key} value={service.key}>
              {service.name}
            </option>
          ))}
        </select>
        <FieldError state={state} name="serviceCategoryKey" />
      </div>
      <div className="field">
        <label htmlFor="cb-postalCode">Postleitzahl des Objekts (optional)</label>
        <input
          id="cb-postalCode"
          name="postalCode"
          defaultValue={value("postalCode")}
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={10}
          aria-invalid={invalid("postalCode")}
          aria-describedby={describedBy(state, "postalCode", "cb-postalCode-hint")}
        />
        <p className="hint" id="cb-postalCode-hint">
          Hilft uns, die Verfügbarkeit vorab einzuschätzen. Zugesagt wird sie erst nach Prüfung.
        </p>
        <FieldError state={state} name="postalCode" />
      </div>
      <div className="field">
        <label htmlFor="cb-window">Wann passt es Ihnen am besten?</label>
        <select
          id="cb-window"
          name="preferredWindow"
          defaultValue={value("preferredWindow") ?? "ANY"}
          aria-invalid={invalid("preferredWindow")}
          aria-describedby={describedBy(state, "preferredWindow")}
        >
          <option value="ANY">Egal</option>
          <option value="MORNING">Vormittags</option>
          <option value="MIDDAY">Mittags</option>
          <option value="AFTERNOON">Nachmittags</option>
        </select>
        <FieldError state={state} name="preferredWindow" />
      </div>
      <div className="field">
        <label htmlFor="cb-message">Worum geht es? (optional)</label>
        <textarea
          id="cb-message"
          name="message"
          defaultValue={value("message")}
          maxLength={500}
          rows={3}
          aria-invalid={invalid("message")}
          aria-describedby={describedBy(state, "message", "cb-message-hint")}
        />
        <p className="hint" id="cb-message-hint">
          Bitte keine sensiblen Daten (z. B. Gesundheitsdaten, Bankdaten) angeben.
        </p>
        <FieldError state={state} name="message" />
      </div>

      <input type="hidden" name="submissionToken" value={submissionToken} />
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="cb-website">Website (bitte leer lassen)</label>
        <input id="cb-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="field field--check">
        <input
          id="cb-privacy"
          name="privacyNoticeAcknowledged"
          type="checkbox"
          required
          aria-invalid={invalid("privacyNoticeAcknowledged")}
          aria-describedby={describedBy(state, "privacyNoticeAcknowledged")}
        />
        <label htmlFor="cb-privacy">
          Ich habe die <Link href="/datenschutz">Datenschutzhinweise</Link> gelesen. Name und
          Telefonnummer werden nur für diesen Rückruf und eine daraus entstehende Anfrage verwendet.
        </label>
        <FieldError state={state} name="privacyNoticeAcknowledged" />
      </div>

      <button className="button" type="submit" disabled={pending}>
        {pending ? "Wird gesendet …" : "Rückruf anfordern"}
      </button>
    </form>
  );
}
