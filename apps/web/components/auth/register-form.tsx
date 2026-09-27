"use client";

import { useState, type SubmitEvent } from "react";
import { authErrorMessage, formText, postAuth } from "@/lib/client/auth-api";

export function RegisterForm() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = formText(form, "password");
    if (password !== formText(form, "passwordConfirm")) {
      setError("Die Passwörter stimmen nicht überein.");
      return;
    }
    setPending(true);
    const result = await postAuth("/sign-up/email", {
      name: formText(form, "name"),
      email: formText(form, "email"),
      password,
      callbackURL: "/auth/verify-email?status=verified",
    });
    setPending(false);
    if (result.status === 200) {
      setDone(true);
      return;
    }
    setError(
      result.status === 400
        ? "Bitte prüfen Sie Ihre Eingaben. Das Passwort muss mindestens 12 Zeichen lang sein."
        : authErrorMessage(result.status),
    );
  }

  if (done) {
    // Identical message whether or not the address was already registered (no enumeration).
    return (
      <div className="alert alert--success" role="status">
        <p>
          Bitte prüfen Sie Ihr Postfach. Wenn die Registrierung möglich ist, erhalten Sie eine
          E-Mail mit einem Bestätigungslink (1 Stunde gültig).
        </p>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={(event) => void onSubmit(event)}>
      {error === null ? null : (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}
      <div className="field">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" autoComplete="name" required maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="email">E-Mail</label>
        <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} />
      </div>
      <div className="field">
        <label htmlFor="password">Passwort</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          aria-describedby="password-hint"
        />
        <p className="hint" id="password-hint">
          Mindestens 12 Zeichen.
        </p>
      </div>
      <div className="field">
        <label htmlFor="passwordConfirm">Passwort wiederholen</label>
        <input
          id="passwordConfirm"
          name="passwordConfirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
        />
      </div>
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Wird gesendet …" : "Konto erstellen"}
      </button>
    </form>
  );
}
