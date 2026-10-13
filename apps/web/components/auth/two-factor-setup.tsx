"use client";

import { useState, type SubmitEvent } from "react";
import { authErrorMessage, formText, postAuth } from "@/lib/client/auth-api";

/** TOTP enrolment via Better Auth's twoFactor plugin (secret shown once for manual entry). */
export function TwoFactorSetup() {
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onEnable(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postAuth("/two-factor/enable", {
      password: formText(form, "password"),
    });
    if (result.status !== 200) {
      setError(
        result.status === 400 || result.status === 401
          ? "Das Passwort ist nicht korrekt."
          : authErrorMessage(result.status),
      );
      return;
    }
    const uri = typeof result.data["totpURI"] === "string" ? result.data["totpURI"] : "";
    setSecret(new URL(uri).searchParams.get("secret"));
    const codes = result.data["backupCodes"];
    setBackupCodes(
      Array.isArray(codes) ? codes.filter((c): c is string => typeof c === "string") : [],
    );
  }

  async function onVerify(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postAuth("/two-factor/verify-totp", {
      code: formText(form, "code"),
    });
    if (result.status === 200) {
      setDone(true);
      return;
    }
    setError(
      "Der Code ist ungültig. Bitte prüfen Sie die Uhrzeit Ihres Geräts und versuchen Sie es erneut.",
    );
  }

  if (done) {
    return (
      <p className="alert alert--success" role="status">
        Zwei-Faktor-Authentifizierung ist aktiv. <a href="/admin/dashboard">Weiter</a>
      </p>
    );
  }

  if (secret !== null) {
    return (
      <div className="form">
        <p>
          Tragen Sie diesen Schlüssel in Ihrer Authenticator-App ein (Typ: zeitbasiert, 6 Stellen):
        </p>
        <p>
          <code>{secret}</code>
        </p>
        {backupCodes.length > 0 ? (
          <>
            <p>
              Bewahren Sie diese Wiederherstellungscodes sicher auf. Sie werden nur jetzt angezeigt:
            </p>
            <ul>
              {backupCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <form className="form" onSubmit={(event) => void onVerify(event)}>
          {error === null ? null : (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          )}
          <div className="field">
            <label htmlFor="code">Code aus der App</label>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </div>
          <button className="button" type="submit">
            Aktivieren
          </button>
        </form>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={(event) => void onEnable(event)}>
      {error === null ? null : (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}
      <div className="field">
        <label htmlFor="password">Passwort zur Bestätigung</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
        />
      </div>
      <button className="button" type="submit">
        Zwei-Faktor-Authentifizierung einrichten
      </button>
    </form>
  );
}
