# ISELA CLEAN – Sicherheitsrichtlinie

## 1. Schwachstellen melden

Bitte **keine** öffentlichen Issues für Sicherheitslücken anlegen. Meldungen erfolgen
vertraulich über **GitHub → Security → „Report a vulnerability“** (Private
Vulnerability Reporting). Die Funktion muss in den Repository-Einstellungen aktiviert
sein (siehe [`PHASE_0_REPORT.md`](PHASE_0_REPORT.md), offene Punkte).

## 2. Grundsätze

1. **Deny by default:** Jeder Endpunkt, jede Server Action und jeder Job prüft
   Authentifizierung und Berechtigung serverseitig. UI-Ausblendung ist kein Schutz.
2. **Validierung an jeder Grenze:** HTTP-Requests, Formulare, Webhooks, Job-Payloads,
   Umgebungsvariablen und Daten externer Quellen werden per Schema (Zod) validiert.
3. **Least Privilege:** Rollen, Datenbanknutzer, API-Schlüssel und CI-Tokens erhalten
   nur die minimal nötigen Rechte.
4. **Keine Geheimnisse im Code, in Logs, in Fehlermeldungen oder im Client-Bundle.**
5. **Nachvollziehbarkeit:** Sicherheits- und finanzrelevante Aktionen erzeugen
   unveränderliche Audit-Events.

## 3. Autorisierung (RBAC)

- Rollen (siehe [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md#3-rollen-akteure)) sind Bündel von
  **Permissions** im Format `ressource:aktion` (z. B. `invoice:approve`,
  `payment_policy:manage`, `lead:export`).
- Prüfungen erfolgen zentral über eine Policy-Funktion
  (`authorize(actor, permission, resource)`), nicht über verstreute Rollenvergleiche.
- **Objektbezogene Autorisierung (IDOR-Schutz):** Neben der Permission wird immer die
  Zugehörigkeit geprüft (Mandant/`organization_id`, eigener Kunde, zugewiesener Auftrag,
  eigener Partnerbetrieb).
- Eine **RBAC-Testmatrix** (Rolle × Permission × Ressourcenbesitz) ist Teil der
  Integrationstests und muss bei jeder neuen Permission erweitert werden.

### 3.1 Umsetzungsstand (Phase 1, Tag 1)

- Rechte-Matrix als Code: `packages/auth/src/permissions.ts`; zentrale Prüfung
  `authorize()` in `packages/auth/src/policy.ts` (OWN-Scopes gegen IDOR, MFA-Pflicht für
  `SUPER_ADMIN`/`ADMIN`/`FINANCE`, Schutz gegen Rechteausweitung bei Rollenvergabe).
- Authentifizierung mit Better Auth 1.7.6: E-Mail-Verifizierung, Passwort-Reset mit
  Session-Widerruf, DB-Sessions ohne Cookie-Cache, IP-Rate-Limits, Konto-Sperre,
  TOTP-MFA, Einladungen mit gehashten Einmal-Token (Details: `docs/DOMAIN_MODEL.md` §10).
- Mass-Assignment-Schutz: alle Service-Eingaben über `z.strictObject`; unbekannte Felder
  führen zu `VALIDATION_FAILED`, es wird nichts geschrieben.
- Audit-Log append-only per DB-Trigger; Redaction sensibler Felder.
- Nachweis: RBAC-Matrix- und Security-Tests in `test/unit/rbac-policy.test.ts`,
  `test/integration/*.test.ts`; Mutationstests belegen, dass die Tests Sicherheitslücken
  erkennen (siehe `docs/PHASE_1_DAY_1_REPORT.md`).

### 3.2 Umsetzungsstand (Phase 1, Tag 2 – Web-App)

- Autorisierung bleibt serverseitig: Bereichs-Guards (`apps/web/lib/server/guards.ts`)
  prüfen Rolle/Scope/MFA über dieselbe Rechte-Matrix (`authorize`, `isAuthorized`); jede
  Datenfunktion prüft zusätzlich selbst (Defense in Depth). Der Proxy leitet nur
  Anfragen ohne Session-Cookie zur Anmeldung um – er trifft keine Rechteentscheidung.
- Better-Auth-Origin- und CSRF-Prüfung sind explizit aktiviert
  (`advanced.disableOriginCheck/disableCSRFCheck: false`). Better Auth schaltet beide
  sonst bei `NODE_ENV=test` oder `TEST=1` stillschweigend ab (Befund Tag 2, behoben).
- Server Actions: Origin-Prüfung durch Next.js, `bodySizeLimit` 64 KB.
- Öffentliche Anfragen: Whitelist-Mapping + `z.strictObject`, Honeypot, Rate-Limit pro
  Client (HMAC-Key, kein Klartext) und pro E-Mail, keine personenbezogenen Daten im Audit.
- Redirects: nur gleiche Origin, nur Pfade, keine `//`, `\\`, Steuerzeichen (auch
  prozent-kodiert) und keine `/api/`-Ziele (`apps/web/lib/security/redirects.ts`).

### 3.3 Security-Header und dokumentierte Ausnahmen

| Header | Wert | Anmerkung |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self' 'nonce-…' 'strict-dynamic'`; `style-src 'self' 'nonce-…'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'` | Nonce pro Request im Proxy |
| `Content-Security-Policy` (API) | `default-src 'none'; frame-ancestors 'none'` | plus `Cache-Control: no-store` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | nur Produktion **und** https-Basis-URL; kein `preload` (bewusste Owner-Entscheidung nötig) |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | |
| `X-Frame-Options` | `DENY` | Fallback für alte Browser |
| `Permissions-Policy` | Kamera, Mikrofon, Geolocation, Payment, USB, Serial, Bluetooth, Topics deaktiviert | |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` | `same-origin` | |
| `X-Powered-By` | entfernt (`poweredByHeader: false`) | keine Server-Informationen |

Notwendige Ausnahmen:

1. **Dynamisches Rendering:** Nonce-basierte CSP erfordert pro Request gerendertes HTML
   (`dynamic = "force-dynamic"` im Root-Layout). Statisches Caching von Seiten entfällt.
2. **`'unsafe-eval'` nur im Entwicklungsmodus** (React-Dev-Tooling); nie in Produktion.
   `ws:` in `connect-src` ebenfalls nur in Entwicklung (HMR).
3. **`upgrade-insecure-requests`** nur, wenn `APP_BASE_URL` https ist (sonst bricht lokales
   http).
4. **`experimental.authInterrupts`** (Next.js 16) für `unauthorized()`/`forbidden()` mit
   echten 401/403-Statuscodes. Deshalb liegt `loading.tsx` nicht im Root, sondern in den
   Bereichssegmenten (sonst würde Streaming den Status vor dem Guard auf 200 festlegen).
5. **Loopback-Ausnahmen:** https-Pflicht und STARTTLS-Pflicht gelten nicht für
   `localhost`/`127.0.0.1`/`[::1]` (lokale Produktions-Builds, E2E, SMTP-Relay auf dem
   Host). Eine echte Bereitstellung läuft nie auf Loopback.
6. **Bilder:** `images.unoptimized` – keine serverseitige Bildoptimierung (vermeidet den
   optionalen LGPL-Baustein sharp/libvips und einen Bild-Proxy-Endpunkt).

## 4. Anforderungskatalog

| Thema | Maßnahme | Nachweis |
| --- | --- | --- |
| Serverseitige Autorisierung | Zentrale Policy-Checks in jedem Use Case | RBAC-Matrix-Tests |
| Input Validation | Zod-Schemas; unbekannte Felder werden verworfen (`strict`) | Unit-Tests je Schema |
| Mass Assignment | Explizite Eingabe-DTOs; nie Request-Body direkt in ORM-Updates | Code-Review-Checkliste, Tests |
| Sichere Sessions | Serverseitige Sessions, Cookies `HttpOnly`, `Secure`, `SameSite=Lax`, Rotation bei Login/Rechtewechsel, Ablauf + Idle-Timeout | Integrationstests |
| CSRF | `SameSite`-Cookies + Origin-Prüfung für zustandsändernde Requests; Token wo nötig | Tests für Cross-Origin-Requests |
| XSS | Standard-Escaping des Frameworks, kein ungeprüftes HTML, Content-Security-Policy mit Nonces | CSP-Header-Test, Lint-Regel |
| SQL-Injection | Ausschließlich parametrisierte Queries (ORM/Query-Builder); Raw-SQL nur mit Parametern und Review | Lint-Regel, Review |
| SSRF | Allowlist ausgehender Hosts; keine vom Nutzer gelieferten URLs ohne Prüfung; private IP-Bereiche blockiert | Unit-Tests des HTTP-Clients |
| Sichere Uploads | Größenlimit, MIME-Prüfung per Inhalt, Umbenennung, privater Speicher, signierte kurzlebige URLs, EXIF-Entfernung bei Fotos | Integrationstests |
| Sichere Webhooks | Signaturprüfung (konstantzeitlich), Zeitfenster, Replay-Schutz, Idempotenz | Tests mit gültigen/ungültigen Signaturen |
| Idempotency | Idempotency-Keys für Zahlungen, Buchungen, Rechnungen; Unique-Constraints | Tests für Doppel-Requests |
| Audit Logs | Append-only Tabelle: Akteur, Aktion, Ressource, Zeitpunkt, Ergebnis – ohne sensible Inhalte | Tests je auditierter Aktion |
| Secrets Management | Nur über Umgebung/Secret-Store; validiert beim Start; Rotation dokumentiert | CI-Secret-Scan, Env-Schema |
| Rate Limiting | Login, Registrierung, Passwort-Reset, Kontaktformular, öffentliche APIs | Tests für Limits |
| Sichere Redirects | Nur relative Pfade oder Allowlist; kein ungeprüfter `redirect`-Parameter | Unit-Tests |
| Security-Header | HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors` | Header-Tests |
| Passwörter | Moderne Hash-Verfahren (Argon2id/scrypt) über die Auth-Bibliothek; Prüfung gegen Mindestlänge | Tests |
| Admin-Konten | MFA für `OWNER`, `ADMIN`, `ACCOUNTING` | Vor Produktivstart verpflichtend |

## 5. Datenschutz und Logging

- **Datenminimierung:** Es werden nur Daten erhoben, die für den Zweck nötig sind.
- **Logs** enthalten keine Passwörter, Tokens, Zahlungsdaten, vollständigen Adressen,
  Telefonnummern oder Freitext-Notizen. Personenbezug nur über pseudonyme IDs.
- **Redaction** ist im Logger zentral konfiguriert und getestet.
- Zahlungsdaten (Karten, IBAN) werden – soweit möglich – ausschließlich beim
  Zahlungsanbieter verarbeitet (Tokenisierung).
- Lösch- und Aufbewahrungsfristen werden je Datenkategorie dokumentiert (DSGVO vs.
  handels-/steuerrechtliche Pflichten).
- Test- und Entwicklungsumgebungen verwenden **keine** Produktionsdaten.

## 6. Secrets

- `.env`-Dateien sind per `.gitignore` ausgeschlossen; nur [`.env.example`](../.env.example)
  mit Platzhaltern ist versioniert.
- Die CI prüft jeden Push auf eingecheckte Secrets (gitleaks) und verbotene Dateien
  (`scripts/check-forbidden-files.sh`).
- Wird ein Secret versehentlich committed, gilt es als **kompromittiert**: sofort
  rotieren, danach Historie bereinigen. Löschen allein genügt nicht.

## 7. Supply Chain

- GitHub Actions sind auf **Commit-SHAs** gepinnt; Dependabot aktualisiert sie.
- Heruntergeladene Werkzeuge in der CI werden per SHA-256-Prüfsumme verifiziert.
- Workflows laufen mit minimalen `permissions` (Standard: `contents: read`).
- Lockfile verpflichtend (`--frozen-lockfile`), Dependency Review für PRs, CodeQL,
  `pnpm audit`, Lizenz-Allowlist (`scripts/check-licenses.mjs`), Dependabot für npm.
- `minimumReleaseAge` (48 h) in `pnpm-workspace.yaml`; Install-Skripte von Abhängigkeiten
  sind blockiert; Kernbibliotheken exakt gepinnt (`save-exact`).

## 8. Repository-Einstellungen (Empfehlung)

- Branch-Schutz für den Default-Branch: PR-Pflicht, grüne CI, keine Force-Pushes.
- Secret Scanning + Push Protection aktivieren.
- Private Vulnerability Reporting aktivieren.
- Sichtbarkeit des Repositorys prüfen (derzeit **öffentlich**, siehe Phase-0-Report).
