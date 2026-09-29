"use client";

import Link from "next/link";
import { startTransition, useActionState, type SubmitEvent } from "react";
import type { RequestFormState, RequestFormValues } from "@/lib/forms/request-form";
import { submitRequestAction } from "./actions";

export interface ServiceOption {
  readonly key: string;
  readonly name: string;
}

const INITIAL: RequestFormState = { status: "idle" };

function FieldError({ state, name }: { state: RequestFormState; name: string }) {
  if (state.status !== "error") return null;
  const message = state.fieldErrors[name];
  if (message === undefined) return null;
  return (
    <p className="field-error" id={`${name}-error`}>
      {message}
    </p>
  );
}

function describedBy(state: RequestFormState, name: string, hint?: string): string | undefined {
  const ids = [
    hint,
    state.status === "error" && state.fieldErrors[name] !== undefined ? `${name}-error` : undefined,
  ];
  const joined = ids.filter((id) => id !== undefined).join(" ");
  return joined === "" ? undefined : joined;
}

export function RequestForm({
  services,
  preselected,
}: {
  services: readonly ServiceOption[];
  preselected?: string;
}) {
  const [state, action, pending] = useActionState(submitRequestAction, INITIAL);
  // With JavaScript, submit inside a transition instead of via the form action so React does
  // not reset the form after a failed validation. Without JavaScript the action still posts.
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
        <h2>Vielen Dank für Ihre Anfrage!</h2>
        <p>
          Wir prüfen Ihre Angaben und melden uns bei Ihnen. Es entsteht keine Buchung und keine
          Zahlungsverpflichtung.
        </p>
      </div>
    );
  }

  const invalid = (name: string) =>
    state.status === "error" && state.fieldErrors[name] !== undefined;
  // After a failed submission React resets the form; the echoed input keeps what was typed.
  const value = (name: keyof RequestFormValues) => {
    const echoed = state.status === "error" ? state.values[name] : undefined;
    return typeof echoed === "string" ? echoed : undefined;
  };

  return (
    <form className="form" action={action} onSubmit={onSubmit} noValidate>
      {state.status === "error" ? (
        <p className="alert alert--error" role="alert">
          {state.message}
        </p>
      ) : null}

      <fieldset>
        <legend>Für wen ist die Reinigung?</legend>
        <div className="field">
          <label htmlFor="customerType">Kundenart</label>
          <select
            id="customerType"
            name="customerType"
            required
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
          <label htmlFor="companyName">Firma (bei Gewerbe/Hausverwaltung)</label>
          <input
            id="companyName"
            name="companyName"
            defaultValue={value("companyName")}
            autoComplete="organization"
            maxLength={200}
            aria-invalid={invalid("companyName")}
            aria-describedby={describedBy(state, "companyName")}
          />
          <FieldError state={state} name="companyName" />
        </div>
        <div className="field">
          <label htmlFor="numberOfProperties">Anzahl Objekte (optional, nur Hausverwaltung)</label>
          <input
            id="numberOfProperties"
            name="numberOfProperties"
            defaultValue={value("numberOfProperties")}
            inputMode="numeric"
            maxLength={6}
            aria-invalid={invalid("numberOfProperties")}
            aria-describedby={describedBy(state, "numberOfProperties")}
          />
          <FieldError state={state} name="numberOfProperties" />
        </div>
      </fieldset>

      <fieldset>
        <legend>Kontakt</legend>
        <div className="field">
          <label htmlFor="fullName">Name</label>
          <input
            id="fullName"
            name="fullName"
            defaultValue={value("fullName")}
            required
            autoComplete="name"
            maxLength={120}
            aria-invalid={invalid("fullName")}
            aria-describedby={describedBy(state, "fullName", "fullName-hint")}
          />
          <p className="hint" id="fullName-hint">
            Bei Gewerbe und Hausverwaltung: Ihre Ansprechpartnerin bzw. Ihr Ansprechpartner.
          </p>
          <FieldError state={state} name="fullName" />
        </div>
        <div className="field">
          <label htmlFor="email">E-Mail</label>
          <input
            id="email"
            name="email"
            defaultValue={value("email")}
            type="email"
            required
            autoComplete="email"
            maxLength={254}
            aria-invalid={invalid("email")}
            aria-describedby={describedBy(state, "email")}
          />
          <FieldError state={state} name="email" />
        </div>
        <div className="field">
          <label htmlFor="phone">Telefon (optional)</label>
          <input
            id="phone"
            name="phone"
            defaultValue={value("phone")}
            type="tel"
            autoComplete="tel"
            maxLength={40}
            aria-invalid={invalid("phone")}
            aria-describedby={describedBy(state, "phone")}
          />
          <FieldError state={state} name="phone" />
        </div>
      </fieldset>

      <fieldset>
        <legend>Adresse des Objekts</legend>
        <div className="field">
          <label htmlFor="street">Straße</label>
          <input
            id="street"
            name="street"
            defaultValue={value("street")}
            required
            autoComplete="address-line1"
            maxLength={200}
            aria-invalid={invalid("street")}
            aria-describedby={describedBy(state, "street")}
          />
          <FieldError state={state} name="street" />
        </div>
        <div className="field">
          <label htmlFor="houseNumber">Hausnummer</label>
          <input
            id="houseNumber"
            name="houseNumber"
            defaultValue={value("houseNumber")}
            required
            maxLength={20}
            aria-invalid={invalid("houseNumber")}
            aria-describedby={describedBy(state, "houseNumber")}
          />
          <FieldError state={state} name="houseNumber" />
        </div>
        <div className="field">
          <label htmlFor="postalCode">Postleitzahl</label>
          <input
            id="postalCode"
            name="postalCode"
            defaultValue={value("postalCode")}
            required
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={10}
            aria-invalid={invalid("postalCode")}
            aria-describedby={describedBy(state, "postalCode")}
          />
          <FieldError state={state} name="postalCode" />
        </div>
        <div className="field">
          <label htmlFor="city">Ort</label>
          <input
            id="city"
            name="city"
            defaultValue={value("city")}
            required
            autoComplete="address-level2"
            maxLength={120}
            aria-invalid={invalid("city")}
            aria-describedby={describedBy(state, "city")}
          />
          <FieldError state={state} name="city" />
        </div>
      </fieldset>

      <fieldset>
        <legend>Was soll gereinigt werden?</legend>
        <div className="field">
          <label htmlFor="serviceCategoryKey">Gewünschte Leistung</label>
          <select
            id="serviceCategoryKey"
            name="serviceCategoryKey"
            required
            defaultValue={value("serviceCategoryKey") ?? preselected ?? ""}
            aria-invalid={invalid("serviceCategoryKey")}
            aria-describedby={describedBy(state, "serviceCategoryKey")}
          >
            <option value="" disabled>
              Bitte wählen
            </option>
            {services.map((service) => (
              <option key={service.key} value={service.key}>
                {service.name}
              </option>
            ))}
          </select>
          <FieldError state={state} name="serviceCategoryKey" />
        </div>
        <div className="field">
          <label htmlFor="propertyType">Objektart</label>
          <select
            id="propertyType"
            name="propertyType"
            required
            defaultValue={value("propertyType") ?? ""}
            aria-invalid={invalid("propertyType")}
            aria-describedby={describedBy(state, "propertyType")}
          >
            <option value="" disabled>
              Bitte wählen
            </option>
            <option value="APARTMENT">Wohnung</option>
            <option value="PRIVATE_HOME">Haus (privat)</option>
            <option value="OFFICE">Büro</option>
            <option value="PRACTICE">Praxis</option>
            <option value="STAIRWELL">Treppenhaus</option>
            <option value="COMMERCIAL">Gewerbefläche</option>
            <option value="OTHER">Sonstiges</option>
          </select>
          <FieldError state={state} name="propertyType" />
        </div>
        <div className="field">
          <label htmlFor="approximateAreaSqm">Ungefähre Fläche in m² (optional)</label>
          <input
            id="approximateAreaSqm"
            name="approximateAreaSqm"
            defaultValue={value("approximateAreaSqm")}
            inputMode="decimal"
            maxLength={10}
            aria-invalid={invalid("approximateAreaSqm")}
            aria-describedby={describedBy(state, "approximateAreaSqm")}
          />
          <FieldError state={state} name="approximateAreaSqm" />
        </div>
        <div className="field">
          <label htmlFor="frequency">Gewünschte Häufigkeit</label>
          <select
            id="frequency"
            name="frequency"
            required
            defaultValue={value("frequency") ?? "ONCE"}
            aria-invalid={invalid("frequency")}
            aria-describedby={describedBy(state, "frequency")}
          >
            <option value="ONCE">Einmalig</option>
            <option value="WEEKLY">Wöchentlich</option>
            <option value="BIWEEKLY">Zweiwöchentlich</option>
            <option value="MONTHLY">Monatlich</option>
            <option value="CUSTOM">Individuell</option>
          </select>
          <FieldError state={state} name="frequency" />
        </div>
        <div className="field">
          <label htmlFor="message">Nachricht (optional)</label>
          <textarea
            id="message"
            name="message"
            defaultValue={value("message")}
            maxLength={2000}
            aria-invalid={invalid("message")}
            aria-describedby={describedBy(state, "message", "message-hint")}
          />
          <p className="hint" id="message-hint">
            Bitte keine sensiblen Daten (z. B. Gesundheitsdaten, Bankdaten) angeben.
          </p>
          <FieldError state={state} name="message" />
        </div>
      </fieldset>

      <div className="honeypot" aria-hidden="true">
        <label htmlFor="website">Website (bitte leer lassen)</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="field field--check">
        <input
          id="privacyNoticeAcknowledged"
          name="privacyNoticeAcknowledged"
          type="checkbox"
          required
          aria-invalid={invalid("privacyNoticeAcknowledged")}
          aria-describedby={describedBy(state, "privacyNoticeAcknowledged")}
        />
        <label htmlFor="privacyNoticeAcknowledged">
          Ich habe die <Link href="/datenschutz">Datenschutzhinweise</Link> gelesen. Meine Angaben
          werden zur Bearbeitung dieser Anfrage verwendet.
        </label>
        <FieldError state={state} name="privacyNoticeAcknowledged" />
      </div>
      <div className="field field--check">
        <input
          id="marketingConsent"
          name="marketingConsent"
          type="checkbox"
          defaultChecked={state.status === "error" && state.values.marketingConsent === true}
        />
        <label htmlFor="marketingConsent">
          Optional: Ich möchte per E-Mail über Angebote von ISELA CLEAN informiert werden. Diese
          Einwilligung kann ich jederzeit widerrufen.
        </label>
      </div>

      <p className="hint">
        Die Anfrage ist unverbindlich. Es wird kein Preis zugesagt, keine Buchung ausgelöst und
        keine Zahlung fällig.
      </p>
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Wird gesendet …" : "Anfrage senden"}
      </button>
    </form>
  );
}
