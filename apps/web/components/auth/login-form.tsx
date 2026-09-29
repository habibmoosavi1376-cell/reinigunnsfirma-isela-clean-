"use client";

import Link from "next/link";
import { useState, type SubmitEvent } from "react";
import { authErrorMessage, formText, postAuth } from "@/lib/client/auth-api";

/** `next` has already been validated on the server (safeRedirectPath). */
export function LoginForm({ next }: { next: string }) {
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onCredentials(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postAuth("/sign-in/email", {
      email: formText(form, "email"),
      password: formText(form, "password"),
    });
    setPending(false);
    if (result.status === 200 && result.data["twoFactorRedirect"] === true) {
      setStep("totp");
      return;
    }
    if (result.status === 200) {
      window.location.assign(next);
      return;
    }
    setError(authErrorMessage(result.status));
  }

  async function onTotp(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postAuth("/two-factor/verify-totp", {
      code: formText(form, "code"),
    });
    setPending(false);
    if (result.status === 200) {
      window.location.assign(next);
      return;
    }
    setError(
      result.status === 429 ? authErrorMessage(429) : "Der Code ist ungültig oder abgelaufen.",
    );
  }

  if (step === "totp") {
    return (
      <form className="form" onSubmit={(event) => void onTotp(event)}>
        {error === null ? null : (
          <p className="alert alert--error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="code">Bestätigungscode aus Ihrer Authenticator-App</label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
          />
        </div>
        <button className="button" type="submit" disabled={pending}>
          Bestätigen
        </button>
      </form>
    );
  }

  return (
    <form className="form" onSubmit={(event) => void onCredentials(event)}>
      {error === null ? null : (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}
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
          autoComplete="current-password"
          required
          maxLength={128}
        />
      </div>
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Anmeldung …" : "Anmelden"}
      </button>
      <p>
        <Link href="/auth/forgot-password">Passwort vergessen?</Link> ·{" "}
        <Link href="/auth/register">Konto erstellen</Link>
      </p>
    </form>
  );
}
