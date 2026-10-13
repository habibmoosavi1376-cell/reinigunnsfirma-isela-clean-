"use client";

import Link from "next/link";
import { useState, type SubmitEvent } from "react";
import { authErrorMessage, formText, postAuth } from "@/lib/client/auth-api";

export function ForgotPasswordForm() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await postAuth("/request-password-reset", {
      email: formText(form, "email"),
      redirectTo: "/auth/reset-password",
    });
    if (result.status === 429) {
      setError(authErrorMessage(429));
      return;
    }
    // Same response for known and unknown addresses (no enumeration).
    setDone(true);
  }

  if (done) {
    return (
      <p className="alert alert--success" role="status">
        Wenn zu dieser Adresse ein Konto besteht, erhalten Sie eine E-Mail mit einem Link zum
        Zurücksetzen (30 Minuten gültig).
      </p>
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
        <label htmlFor="email">E-Mail</label>
        <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} />
      </div>
      <button className="button" type="submit">
        Link anfordern
      </button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = formText(form, "password");
    if (newPassword !== formText(form, "passwordConfirm")) {
      setError("Die Passwörter stimmen nicht überein.");
      return;
    }
    const result = await postAuth("/reset-password", { token, newPassword });
    if (result.status === 200) {
      setDone(true);
      return;
    }
    setError(
      result.status === 400
        ? "Der Link ist ungültig oder abgelaufen, oder das Passwort ist zu kurz (mindestens 12 Zeichen)."
        : authErrorMessage(result.status),
    );
  }

  if (done) {
    return (
      <p className="alert alert--success" role="status">
        Ihr Passwort wurde geändert. Alle bestehenden Sitzungen wurden beendet.{" "}
        <Link href="/auth/login">Jetzt anmelden</Link>
      </p>
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
        <label htmlFor="password">Neues Passwort</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
        />
      </div>
      <div className="field">
        <label htmlFor="passwordConfirm">Neues Passwort wiederholen</label>
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
      <button className="button" type="submit">
        Passwort speichern
      </button>
    </form>
  );
}

export function ResendVerificationForm() {
  const [done, setDone] = useState(false);
  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await postAuth("/send-verification-email", {
      email: formText(form, "email"),
      callbackURL: "/auth/verify-email?status=verified",
    });
    setDone(true);
  }
  if (done) {
    return (
      <p className="alert alert--success" role="status">
        Wenn eine Bestätigung aussteht, erhalten Sie eine neue E-Mail.
      </p>
    );
  }
  return (
    <form className="form" onSubmit={(event) => void onSubmit(event)}>
      <div className="field">
        <label htmlFor="resend-email">E-Mail</label>
        <input
          id="resend-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
        />
      </div>
      <button className="button button--secondary" type="submit">
        Bestätigungslink erneut senden
      </button>
    </form>
  );
}

export function SignOutButton() {
  async function onClick() {
    await postAuth("/sign-out", {});
    window.location.assign("/");
  }
  return (
    <button className="button button--secondary" type="button" onClick={() => void onClick()}>
      Abmelden
    </button>
  );
}
