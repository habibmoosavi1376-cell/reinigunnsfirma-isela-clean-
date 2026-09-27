# ISELA CLEAN – Phase 1 / Tag 2: Web-App Foundation, Auth, Security Gate

Stand: 2026-09-27 · Repository: `habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` ·
Branch: `phase-1-day-2` · PR: #3 (gegen `main`)

## 1. Ausgangszustand

| Prüfpunkt | Befund |
| --- | --- |
| Branch / HEAD | `phase-1-day-2`, erstellt von `phase-1-foundation` @ `619c38c` |
| Working Tree | sauber vor Beginn |
| `main` | `29d82a9` (unverändert) |
| PR #1 (Phase 0.1) | offen, nicht gemergt – nicht bearbeitet |
| PR #2 (Tag 1) | offen, nicht gemergt; CI grün außer „Dependency review“ |
| Dependency Review | schlägt fehl, weil der Dependency Graph in den Repository-Einstellungen deaktiviert ist (Owner-Einstellung; nicht abgeschwächt) |
| CodeQL | grün |
| Migrationen | 3 (`0000`–`0002`), kein Drift |
| Tests | 307 Unit, 73 Integration – alle grün |

## 2. PR / Branch

- Da PR #1 und #2 noch nicht gemergt sind, wurde **nicht** auf `main` gearbeitet, keine
  History umgeschrieben und kein GitHub-Schutz umgangen.
- `phase-1-day-2` ist auf `phase-1-foundation` gestapelt. PR #3 zielt wie gefordert auf
  `main` und enthält daher bis zum Merge von #1/#2 auch deren Commits.
  Merge-Reihenfolge: #1 → #2 → #3.
- Commits (logisch getrennt):

| Commit | Inhalt |
| --- | --- |
| `2f6f72f` | fix(auth): Origin-/CSRF-Prüfung von Better Auth in jeder Umgebung aktiv |
| `62c754a` | feat: Domänen-Erweiterungen (config, partners, Anfragen, Migration 0003, SMTP, Rate-Limit) |
| `bd980dc` | feat(web): Next.js-App mit Auth, geschützten Bereichen, Anfrageformular |
| `6c11aab` | test(web): Unit-, Integrations-, Security- und E2E-Tests |
| `fa2288a` | ci: Web-Build, Client-Bundle-Secret-Scan, E2E, Doku |
| (Folge) | fix(test): CodeQL-Befund im SMTP-Sink, Formatierung |
| (dieser) | docs: Tag-2-Report |

## 3. Web-Architektur

- **Stack:** Next.js 16.3.6 (App Router, Turbopack), React 19.3, TypeScript 6 strict,
  Node 24. Alle Seiten werden dynamisch gerendert (Nonce-CSP).
- **Schichten:** Fachlogik bleibt in `packages/*`. Seiten und Server Actions rufen nur
  Paketfunktionen mit einem `ServiceContext` auf; UI-Komponenten greifen nie direkt auf
  die Datenbank zu. Validierung erfolgt zentral per Zod in den Paketen, Autorisierung
  zentral per `authorize()`.
- **Composition Root:** `apps/web/lib/server/composition.ts` baut aus dem validierten Env
  einmal pro Prozess die Dienste (DB, SMTP, Better Auth, CRM-Konfiguration).
- **Env (`@isela/config`):** gruppiert nach DATABASE, AUTH, APPLICATION, SECURITY, EMAIL,
  GEO, PAYMENT, STORAGE, OBSERVABILITY (+ LEGAL).
  - Sicherheitskritische Werte haben keine Defaults; Platzhalter werden abgelehnt.
  - In Produktion sind https und die Impressumsangaben Pflicht.
  - Konfigurierte, aber nicht integrierte Anbieter (Geo, Payment, Storage) werden
    abgelehnt statt vorgetäuscht.
  - Es gibt keine `NEXT_PUBLIC_*`-Variablen.
  - `.env.example` ist vollständig, ohne Werte und per Test mit dem Schema synchron.
- **Fail-fast:** `instrumentation.ts` → `lib/server/startup.ts`. Bei Fehlkonfiguration
  beendet sich der Prozess mit Exit 1 und loggt nur Variablennamen (verifiziert:
  `next start` ohne Env → Exit 1).
- **Proxy (`proxy.ts`):** CSP-Nonce, Request-ID, Login-Redirect für `/customer`, `/admin`
  und `/account` ohne Session-Cookie (normalisiert, z. B. `/ADMIN`). Keine
  Rechteentscheidung im Proxy.
- **Landingpages:** `/<leistung>-<ort>` sind vorbereitet über `service_category.url_slug`
  und `buildLandingPath`/`parseLandingPath`; kein Ort ist im Code verankert. Seiten
  entstehen erst mit echten Inhalten und aktiven Einsatzgebieten.
- **Modulgrenzen:** `check-module-boundaries.mjs` prüft jetzt auch Apps. `"use client"`-
  Dateien dürfen keine Server-only-Pakete und kein `@/lib/server` importieren; eine
  Negativprobe wurde erkannt.

## 4. Auth

- **Route:** `app/api/auth/[...all]/route.ts` delegiert an die bestehende Better-Auth-
  Instanz aus `@isela/auth`. Es gibt keine zweite Auth-Implementierung.
- **Abläufe:** Registrierung, E-Mail-Verifizierung (SMTP), Login, TOTP-Schritt, Logout,
  Passwort vergessen/zurücksetzen, erneuter Verifizierungslink, MFA-Einrichtung.
- **Reset:** Der Passwort-Reset widerruft alle Sessions (Integrationstest).
- **Enumeration:** Registrierung und Reset antworten identisch, egal ob das Konto
  existiert; die UI-Meldungen sind generisch.
- **Übernommen aus Tag 1:** IP-Rate-Limits (DB), Konto-Sperre, TOTP, DB-Sessions ohne
  Cookie-Cache.
- **Cookies:** `HttpOnly`; `Secure` bei Produktion mit https.
- **Origin/CSRF:** Better Auth prüft Origin und Fetch-Metadata. Beide Prüfungen sind jetzt
  explizit aktiviert (siehe §13). Server Actions sind durch die Origin-Prüfung von Next.js
  geschützt.

## 5. RBAC

- Es bleiben dieselben 7 Rollen und dieselbe Matrix; es gibt keine parallele Rollenlogik.
- **Bereichs-Guards** (`lib/server/guards.ts`):
  - Anonym → 401.
  - Kundenbereich nur für `CUSTOMER` mit Kunden-Scope, sonst 403.
  - Adminbereich nur mit `lead:read`, `settings:read` oder `audit:read`.
  - Privilegierte Rollen ohne MFA werden zur MFA-Einrichtung umgeleitet.
- **Defense in Depth:** Jede Datenfunktion prüft zusätzlich selbst (OWN-Scope gegen IDOR).
- **Explizite Rollenszenarien** (`test/integration/rbac-scenarios.test.ts`):

| Rolle | Geprüft |
| --- | --- |
| CUSTOMER | keine fremden Kunden, keine Admin-Funktionen (Leads, Settings, Einladungen, Kundenanlage) |
| STAFF | keine Finanzverwaltung, keine Kundendaten |
| PARTNER | nur eigener Partner; keine Einladungen für fremde Partner |
| FINANCE | Zahlungsrichtlinie ja, Rollenvergabe nein |
| ADMIN | erlaubte Aktionen; kann weder ADMIN/SUPER_ADMIN vergeben noch Zahlungsrichtlinien ändern; ohne MFA komplett blockiert |
| SUPER_ADMIN | einzige Rolle, die ADMIN/SUPER_ADMIN vergeben kann |

- In E2E bestätigt: Ein angemeldeter Nutzer ohne Kundenrolle erhält 403. Nach der
  Rollenvergabe (Testdaten) ist der Kundenbereich erreichbar, der Adminbereich bleibt 403.

## 6. Security

- **Header:**
  - Nonce-CSP mit `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`.
  - `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP.
  - `X-Powered-By` entfernt.
  - HSTS nur bei Produktion mit https.
  - Die API-CSP ist restriktiv, mit `Cache-Control: no-store`.
  - Die dokumentierten Ausnahmen stehen in `docs/SECURITY.md` §3.3.
- **Keine CSP-Verstöße** auf der Startseite und im Anfrageformular (E2E, Browser-Events).
- **Open Redirect:** Nur Pfade gleicher Origin sind erlaubt. Abgelehnt werden `//`,
  `\`, Steuerzeichen (auch prozent-kodiert) und `/api/`-Ziele (Unit- und E2E-Tests).
- **Fehler:** keine Stacktraces an Benutzer (Fehlerseiten mit Referenz-ID). Logs enthalten
  nur Fehlername/-code und Korrelations-ID, keine personenbezogenen Daten.
- **Client-Bundle:** CI baut mit zufälligen Canary-Secrets und durchsucht
  `.next/static` nach Werten, Variablennamen, Connection-Strings und Schlüsselmaterial.
  Das Ergebnis ist lokal grün; eine Negativprobe wurde erkannt.
- **Supply Chain:**
  - `sharp`/libvips (LGPL, optionale Next-Abhängigkeit) wird nicht installiert
    (`ignoredOptionalDependencies`, `images.unoptimized`).
  - Die Lizenzrichtlinie wurde um `MIT-0` (nodemailer) und eine dokumentierte Ausnahme
    für `caniuse-lite` (CC-BY-4.0, Build-Daten) ergänzt.
  - `pnpm audit`: 0 Schwachstellen.

## 7. Website-Struktur

18 Seiten plus robots/sitemap/Icon, alle ohne erfundene Inhalte:

- **Öffentlich:**
  - `/` mit Header, Hero, Leistungen, Privat (B2C), Gewerbe (B2B),
    Hausverwaltungen/Immobilien, Warum ISELA CLEAN, Servicegebiet, Anfrage-CTA und Footer.
  - `/anfrage`, `/impressum` (nur aus `BUSINESS_*`-Env), `/datenschutz` (sachlicher
    Entwurf, als Entwurf gekennzeichnet).
- **Auth:** `/auth/login|register|verify-email|forgot-password|reset-password` (noindex).
- **Kunde:** `/customer` (+ `requests`, `quotes`, `jobs`, `invoices`, `profile`). Angebote,
  Aufträge und Rechnungen zeigen ehrlich „wird freigeschaltet“.
- **Admin:** `/admin` → `/admin/dashboard` (Lead-Übersicht, nur mit `lead:read`).
- **Konto:** `/account/security` (TOTP-Einrichtung).
- **Fehler:** `not-found`, `error`, `global-error`, `unauthorized` (401), `forbidden`
  (403), Loading-UI in den geschützten Segmenten.
- **Inhalte:** Leistungen und Einsatzgebiete kommen aus der Datenbank. Ohne aktive
  Einsatzgebiete zeigt die Seite „wird eingerichtet“. Es gibt keine Kunden, Bewertungen,
  Referenzen, Zahlen, Zertifikate oder Partner.
- **Barrierefreiheit:** Skip-Link, Labels, `aria-invalid`/`aria-describedby`,
  Fokus-Styles, mobile-first.

## 8. Request Foundation („Reinigung anfragen“)

- **Felder:** Kundenart, Name, Firma (Pflicht bei Gewerbe/Hausverwaltung), E-Mail,
  Telefon, Adresse, Leistung, Objektart, Fläche, Häufigkeit, Nachricht,
  Datenschutzhinweis und optionale Marketing-Einwilligung.
- **Speicherung:** als Lead (`DISCOVERED`) mit Kontakt (Art. 6 Abs. 1 lit. b DSGVO) und
  `service_request`. Ein Consent-Datensatz entsteht nur bei aktiver Einwilligung, mit
  Textversion und Nachweis.
- **Nicht enthalten:** keine Preiszusage, keine Buchung, keine Zahlung, keine
  Partnerzuweisung. `service_area_status = UNKNOWN`, bis Geocoding integriert ist.
- **Schutz:**
  - Whitelist-Mapping und `z.strictObject` (Mass Assignment).
  - Längenlimits, 64-KB-Limit für Server Actions.
  - Honeypot.
  - Rate-Limits pro Client (HMAC-Key) und pro E-Mail (3/24 h), ohne Klartext-IP oder
    -E-Mail in der Datenbank.
- **Audit:** `service_request.submitted` als SYSTEM, ohne personenbezogene Daten.
- **UX:** Eingaben bleiben nach Validierungsfehlern erhalten (siehe §13). Ohne JavaScript
  funktioniert das Formular weiterhin (Progressive Enhancement).

## 9. SEO

- **Metadaten:** `metadataBase` aus `APP_BASE_URL`, Titel-Template, Canonical,
  OpenGraph. Private Bereiche sind noindex.
- **robots.txt:** sperrt `/api/`, `/auth/`, `/customer`, `/admin`, `/account`.
- **Sitemap:** nur echte Seiten.
- **JSON-LD:** Organization aus konfigurierten Fakten; LocalBusiness nur bei vollständiger
  Adresse. Keine Bewertungen (E2E prüft das). Ausgabe mit Nonce, `<`, `>` und `&` escaped.
- **Keine** Doorway Pages, kein Keyword-Stuffing, keine erfundenen lokalen Referenzen.

## 10. Tests

| Suite | Anzahl | Ergebnis |
| --- | --- | --- |
| Unit gesamt | 394 (307 Bestand + 87 neu) | alle bestanden |
| Integration gesamt | 99 (73 Bestand + 26 neu) | alle bestanden |
| davon Bestand Tag 1, separat ausgeführt | 307 Unit / 73 Integration | alle bestanden |
| E2E (Playwright, Chromium) | 9 | alle bestanden, 3 von 3 Läufen stabil |

- **Unit:**
  - Env-Schema und `.env.example`-Synchronität.
  - Route-Guards und Route-Klassifizierung (inkl. Normalisierung).
  - Redirect-Schutz, Request-Mapping, Consent, Werte-Echo, SEO-Helfer, Loopback-Regel.
- **Integration:**
  - Die echte Auth-Route mit echter DB und SMTP-Sink: Registrierung, Verifizierung,
    Login, Session, Logout, keine Enumeration, Reset widerruft Sessions,
    Origin/CSRF/Callback-Prüfung, keine Stacktraces.
  - Anfragen: Mass Assignment, übergroße und fehlerhafte Eingaben, ungültiger Consent,
    fehlende Datenschutzbestätigung, Rate-Limits, Kundenisolation, nicht authentifizierter
    Zugriff.
  - RBAC-Szenarien.
- **E2E:** echter Produktions-Build (`next start`), frisch migrierte E2E-Datenbank, lokaler
  TEST-ONLY-SMTP-Sink. Abgedeckt:
  - Startseite, Header, CSP ohne Verstöße, JSON-LD, Skip-Link, robots/sitemap, 404.
  - Redirect geschützter Bereiche.
  - Registrierung → Verifizierung per E-Mail-Link → Login.
  - 403 ohne Kundenrolle, Kundenbereich nach Rollenvergabe, 403 im Adminbereich.
  - Open-Redirect-Versuch, Logout.
  - Anfrageformular (serverseitige Pflichtprüfung, Speicherung) und Honeypot.
- **Testdaten:** eindeutig als „E2E-Testdaten“ markiert, nur in der dedizierten
  E2E-Datenbank (Guard: Name muss „e2e“ enthalten).
- **Performance** (lokal, Produktions-Build):
  - TTFB warm ≈ 14 ms für `/`, kalt ≈ 290 ms beim ersten Request.
  - Startseite 24,8 KB HTML (5,9 KB gzip).
  - Alle Client-Chunks zusammen 182 KB gzip.
  - Keine Bildoptimierung nötig, da keine Bilder.

## 11. CI

Alle bestehenden Jobs bleiben unverändert erhalten: Secret-Scan, Repo-Guard, Markdown-
und Workflow-Lint, Quality, Integration, Audit/Lizenzen, Dependency Review und CodeQL.

- **Erweitert:**
  - Typecheck inklusive `apps/web` (`next typegen` + `tsc`).
  - Lint inklusive TSX.
  - Unit- und Integrationstests inklusive `apps/web/tests`.
  - Grenz- und Hardcoding-Checks inklusive Apps.
- **Neu:**
  - „Web build (production) and client-bundle secret scan“ (Canary-Secrets).
  - „E2E (Playwright, production build, PostgreSQL + PostGIS)“ mit Chromium über
    `playwright install --with-deps` in der Lockfile-Version.
- Workflow per actionlint geprüft.
- **Erster CI-Lauf auf PR #3** (Commit `fa2288a`):
  - Grün: Secret-Scan, Repo-Guard, Markdown-Lint, actionlint, Integration, Audit/Lizenzen,
    Web-Build mit Bundle-Scan, **E2E (in CI bestanden)** und CodeQL-Analyse.
  - Rot: „Typecheck, lint, unit tests, build“ (Prettier-Formatierung eines Guard-
    Skripts) und CodeQL-Alert `js/incomplete-sanitization` (hoch) im TEST-ONLY-SMTP-Sink.
    Beides ist im Folge-Commit behoben (§12, §13).
  - Rot: „Dependency review“ wegen der Owner-Einstellung (wie bei #2).
- Den finalen CI-Stand zeigen die PR-Checks.

## 12. Security Findings

| # | Befund | Schwere | Status |
| --- | --- | --- | --- |
| S1 | Better Auth deaktiviert Origin- **und** CSRF-Prüfung stillschweigend bei `NODE_ENV=test` oder `TEST=1`. Eine falsch gesetzte Umgebungsvariable in einer Bereitstellung hätte Login-CSRF und CSRF auf cookie-basierte Aktionen ermöglicht. | hoch | behoben (explizit aktiviert); Regressionstest unter `NODE_ENV=test` mit fremdem Origin, Cross-Site-Navigation und Cookie-Requests ohne/mit fremdem Origin |
| S2 | Open Redirect über prozent-kodierte Steuerzeichen (`/%0d%0a…`) | mittel | behoben; Unit-Test |
| S3 | Root-`loading.tsx` ließ geschützte Bereiche mit HTTP 200 statt 401/403 antworten. Inhalte wurden nicht ausgeliefert, aber die Statuscodes waren falsch (Caches, Monitoring). | niedrig | behoben; E2E prüft 403 |
| S4 | Fehlkonfiguration beim Start wurde nur geloggt, der Server lief weiter | mittel | behoben (Exit 1, verifiziert) |
| S5 | `sharp`/libvips (LGPL) als optionale Abhängigkeit verletzte die Lizenzrichtlinie | niedrig | behoben (nicht installiert) |
| S6 | CodeQL `js/incomplete-sanitization`: Der Link-Finder im TEST-ONLY-SMTP-Sink baute eine Regex aus Eingabe mit unvollständigem Escaping (Backslash). Nur Testcode, nicht produktiv erreichbar. | hoch (CodeQL) / praktisch niedrig | behoben: statische Regex plus Substring-Filter; betroffene Integrations- und E2E-Tests erneut grün |

- **Dependency Review:** fehlt als wirksamer Check, weil der Dependency Graph deaktiviert
  ist. Das ist offen und benötigt die Owner-Einstellung; siehe §14.
- **gitleaks:** Die Git-History ist ohne Funde.
- **gitleaks dir:** Die Funde liegen ausschließlich im gitignorierten Build-Ordner
  `apps/web/.next` (Next-Preview-Schlüssel pro Build, PEM-Präfix-Prüfungen in
  Bibliothekscode). Es sind keine echten Secrets und nichts davon wird committet.

## 13. Behobene Bugs

1. S1–S6 (siehe §12).
2. **Turbopack-Bundling der Migrationen:** `new URL("../migrations")` wurde gebündelt.
   Die Migrationen sind jetzt nur noch über den Subpath-Export `@isela/database/migrate`
   erreichbar.
3. **CSP `upgrade-insecure-requests`** hing an `NODE_ENV` und brach lokales http. Es hängt
   jetzt an einer https-`APP_BASE_URL`.
4. **Leerer RBAC-Katalog:** Der Seed hat die RBAC-Tabellen nie befüllt; außerhalb der
   Tests waren sie leer. `db:seed` synchronisiert sie jetzt.
5. **Datenverlust im Formular:** React 19 setzte das Formular nach einem Validierungsfehler
   zurück, inklusive der `<select>`-Felder. Die Absendung läuft jetzt über eine
   Transition; zusätzlich werden die Werte für den Weg ohne JavaScript zurückgegeben.
6. **STARTTLS-Pflicht auch für Loopback-Relays:** Ein SMTP-Relay auf demselben Host
   bricht die Verbindung nicht mehr ab; ein Relay im Netzwerk bleibt TLS-pflichtig.
7. **Edge-Runtime-Warnung** durch `process.exit` in `instrumentation.ts`: Der Node-only-
   Teil liegt jetzt in einem eigenen Modul.
8. **Hartcodierte Migrationsanzahl** im Test: Der Test prüft jetzt gegen das Journal.
9. **Textfehler** im Formularhinweis („Es werden kein Preis…“) korrigiert.
10. **Formatierung:** Prettier-Formatierung von `scripts/check-module-boundaries.mjs` (CI).

## 14. Offene Punkte

1. **Impressum/Datenschutz:** echte Angaben und eine rechtlich geprüfte
   Datenschutzerklärung (Owner/Rechtsberatung). `PRIVACY_NOTICE_VERSION` ist ein Entwurf.
2. **Geocoding-Anbieter:** Auswahl und Adapter fehlen; bis dahin bleibt
   `service_area_status = UNKNOWN`.
3. **Kunden-Selbstverknüpfung** (Konto ↔ Kundendatensatz): Der Back-Office-Prozess fehlt.
   In E2E wird die Rolle als Testdaten per SQL vergeben.
4. **Client-IP hinter Proxy:** `AUTH_IP_ADDRESS_HEADERS`/`AUTH_TRUSTED_PROXIES` müssen je
   Hosting korrekt gesetzt werden, sonst teilen sich Clients ein Rate-Limit.
5. **Session-Idle-Timeout:** Better Auth kennt kein separates Idle-Timeout. Es gelten die
   Session-Dauer von 7 Tagen und ein Refresh nach 1 Tag. Die frühere Variable wurde aus
   `.env.example` entfernt.
6. **Repository-Einstellungen (Owner):**
   - Dependency Graph aktivieren (für Dependency Review).
   - Branch-Schutz für `main`.
   - Tag `phase-0-complete` pushen (bisher 403).
7. **HSTS `preload`:** bewusst nicht gesetzt; das erfordert eine Owner-Entscheidung.
8. **Nicht umgesetzt (laut Vorgabe):** Angebote, Aufträge, Rechnungen, Zahlungen,
   Buchung und Partnerzuweisung.

## 15. Risiken

- **Gestapelte PRs:** PR #3 ist erst nach #1/#2 sauber reviewbar.
  Merge-Reihenfolge: #1 → #2 → #3.
- **`experimental.authInterrupts`:** ist experimentell. Ändert sich das Verhalten, fallen
  die Guard-Unit-Tests (Digests) und die E2E-Statusprüfungen.
- **Dynamisches Rendering überall** (Nonce-CSP): höhere Serverlast als bei statischen
  Seiten. Bei Bedarf kommt später ein CDN oder Caching für öffentliche Seiten ohne Nonce
  (bewusste Abwägung).
- **Better Auth als sicherheitskritische Abhängigkeit:** Upgrades nur mit den Auth-
  Integrationstests, insbesondere der Origin/CSRF-Regression.
- **E2E in CI:** abhängig vom Chromium-Download durch `playwright install`. Lokal war der
  Lauf 3 von 3 Mal stabil.

## 16. Nächste Phase

1. Owner-Aufgaben (§14.6), Merge von #1 → #2 → #3.
2. Geocoding-Adapter (EU-Anbieter) und PostGIS-Verfügbarkeitsprüfung für Anfragen.
3. Back-Office: Lead-Bearbeitung, Statusübergänge in der UI, Kunden-Verknüpfung und
   Einladungen.
4. Angebotsmodul (manuell, ohne automatische Preiszusage) sowie Admin-Settings-UI.
5. Rechtstexte final; danach Landingpages aus echten Einsatzgebiet- × Leistungsinhalten.

PHASE 1 DAY 2 COMPLETE
