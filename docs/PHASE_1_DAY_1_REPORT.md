# ISELA CLEAN – Phase 1 / Tag 1 Report

| Feld | Wert |
| --- | --- |
| Datum | 2026-09-27 |
| Repository | `habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` |
| Branch | `phase-1-foundation` (Basis `9c0ffdc`, gestapelt auf PR #1) |
| Commits | `6d53ed8` Spezifikation · `c3823a9` Implementierung · `d567833` Tests · `d13f5e9` CI/Guards/Doku · Report-Commit (Folgecommit) |
| Status | siehe §18 |

## 1. Ausgangszustand

| Prüfung | Befund |
| --- | --- |
| Branch / Working Tree | `claude/untitled-session-mhhecl`, sauber, HEAD `9c0ffdc` |
| `origin/main` | `29d82a9` (Phase-0-Stand) |
| PR #1 | offen, nicht gemergt, `mergeable_state: clean` |
| Default-Branch | weiterhin `claude/untitled-session-mhhecl` |
| Sichtbarkeit | **öffentlich** |
| Tag `phase-0-complete` | remote **nicht vorhanden** (nur lokal) |
| Rulesets / Branch Protection | nicht aktiv (`protected: false`); Rulesets mit den verfügbaren Werkzeugen nicht lesbar |
| Umgebung | kein Docker-Daemon; PostgreSQL 16.13 + PostGIS 3.4.2 lokal per apt installiert; Node 24.21.0 (Prüfsumme verifiziert) außerhalb des Repos |

Folge: Keine Änderung an `main`. Die gesamte Arbeit liegt auf dem neuen Feature-Branch
`phase-1-foundation`; die Owner-Einstellungen wurden nicht umgangen.

## 2. Specification changes

Neues Dokument [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) (verbindlich für Phase 1):

| Abschnitt | Inhalt |
| --- | --- |
| §1 CustomerAddress | alle geforderten Felder; `location` wird aus lat/lng **generiert**; Einsatzgebiet nur über Punkt + PostGIS, ohne Koordinaten `UNKNOWN` |
| §2 City/PostalCode | Referenzdaten, **n:m** über `postal_code_city` |
| §3 ServiceArea | `CIRCLE`/`POLYGON`, generische Geo-Dienste, Startmarkt nur als inaktiver Seed |
| §4 ServiceCategory | datengetrieben, 10 Seed-Kategorien, keine Logik auf Namen |
| §5 Customer | gehashte Identitätsmerkmale, eindeutige vs. Signal-Merkmale, Dublettenprüfung |
| §6 Leads | Provider-Konfiguration, Lead, LeadContact, globale Sperrliste, Pipeline mit 13 Zuständen und Guards |
| §7 Consent | nur Einwilligungen, unveränderlich, Rechtsgrundlage aus Zweck abgeleitet |
| §8 Settings | Registry mit Zod-Schema je Key, Versionen, Gültigkeitszeiträume, Audit |
| §9 AuditLog | append-only, Redaction |
| §10 Identität | 7 Rollen, Auth-Anforderungen (Verifizierung, Reset, Sperre, Sessions, Einladungen, MFA, Recovery) |
| §11 Payment Risk | Invarianten (u. a. `minSuccessfulPaidOrders ≥ 3`), Teilzahlung, Mahnstufen, B2B/B2C, Wiederholungsaufträge, Dubletten |
| §12 LeadFinder | 5 Provider-Arten, Pflicht-Metadaten, WebsiteResearch-Regeln, keine Massenansprache |

`PRODUCT_SPEC.md`: Zuordnung fachlicher Akteure → technische Rollen, Verweis auf die
Invarianten. `ARCHITECTURE.md` §2.1/§2.2 und `SECURITY.md` §3.1/§7 aktualisiert.

## 3. Architecture decision

Modularer Monolith als pnpm-Workspace mit 11 Paketen; Fachlogik ohne Next.js-Abhängigkeit.
Grenzen per Allowlist (`scripts/check-module-boundaries.mjs`) und ESLint geprüft;
sensible Pakete sind `serverOnly`.

| Geforderte Module | Umsetzung Tag 1 |
| --- | --- |
| database, auth, crm, lead-finder, payment-risk, validation, shared | umgesetzt als gleichnamige Pakete |
| notifications | Port `EmailSender` (ohne Default-Implementierung) |
| Zusätzlich | `audit`, `catalog` (Leistungen, Einsatzgebiete, Geo), `settings` |
| pricing, quoting, booking, jobs, partners, invoicing, payments, seo | **nicht begonnen** (Tage 4–7); `partner` existiert nur als minimale Tabelle für Geo-Abfragen |

Abweichungen von der Zielstruktur: flache Pakete statt `packages/modules/*`, kein
Turborepo, keine Testcontainers (Begründung in `ARCHITECTURE.md` §2.1).

## 4. Stack versions

| Komponente | Version | Bemerkung |
| --- | --- | --- |
| Node.js | 24.x (`.nvmrc`), lokal 24.21.0 | `engines >=24.11 <25`, `engine-strict` |
| pnpm | 10.33.0 | `minimumReleaseAge` 48 h, Install-Skripte blockiert |
| TypeScript | **6.0.3** | 7.0.2 verfügbar, aber mit `typescript-eslint` inkompatibel |
| Drizzle ORM / Kit | 0.45.3 / 0.31.11 | exakt, vor 1.0 |
| Better Auth | 1.7.6 | API gegen Typdefinitionen und `getAuthTables` geprüft |
| pg | 8.23.0 | |
| Zod | 4.6.5 | |
| PostgreSQL / PostGIS | 16 / 3.4 | CI: `postgis/postgis:16-3.4` per Digest |
| Vitest | **5.0.1** | 5.0.2 jünger als 48 h |
| ESLint / typescript-eslint / Prettier | 10.11.0 / 8.70.1 / 3.9.9 | |
| Next.js | 16.3.6 geprüft | **nicht installiert** (keine UI an Tag 1) |
| pg-boss | 12.35.0 geprüft | **nicht installiert** (kein Worker an Tag 1) |

## 5. Database schema

32 Tabellen (ohne `spatial_ref_sys`):

| Bereich | Tabellen |
| --- | --- |
| Better Auth | `user`, `session`, `account`, `verification`, `two_factor`, `rate_limit` |
| RBAC | `role`, `permission`, `role_permission`, `user_role`, `invitation`, `account_lockout` |
| Referenz/Katalog | `city`, `postal_code`, `postal_code_city`, `service_area`, `service_category`, `service` |
| CRM | `customer`, `customer_identity`, `customer_duplicate_candidate`, `customer_address`, `property`, `partner` |
| Leads | `lead_source`, `lead`, `lead_status_transition`, `lead_contact`, `contact_suppression` |
| Governance | `consent`, `setting`, `audit_log` |

Regeln: UUID-Primärschlüssel (Better-Auth-Tabellen: Text-IDs), Zeitstempel `timestamptz`,
Archivierung statt Löschung, `RESTRICT` auf allen Fach-/Finanz-/Audit-Fremdschlüsseln
(`CASCADE` nur für Sessions/Accounts/2FA/Rollen eines Nutzers), CHECK-Constraints für
Formen, Bereiche und Statuskonsistenz, GiST-Indizes auf Geo-Spalten, partielle
Unique-Indizes für eindeutige Identitäten und Quellreferenzen.

## 6. Migration

| Migration | Inhalt |
| --- | --- |
| `0000_extensions.sql` (manuell) | `postgis`, `btree_gist` (idempotent), Domains `geo_point`, `geo_multipolygon` |
| `0001_initial_schema.sql` (generiert) | vollständiges Schema |
| `0002_integrity_guards.sql` (manuell) | Append-only-Trigger (`audit_log` inkl. TRUNCATE, `consent`, `lead_status_transition`), Exclusion-Constraint gegen überlappende Settings, Trigger „Objekt-Adresse gehört demselben Kunden“ |

Verifikation: leere Datenbank → Migrationen → erneuter Lauf (No-op) → Seed zweimal
(idempotent): 3 Migrationen, 32 Tabellen, 10 Kategorien, 0 aktive Gebiete.
Drift-Prüfung `pnpm db:check` in CI.

Befunde und Behebungen während der Umsetzung:

1. `drizzle-kit` quotet Typnamen mit Klammern (`"geography(Point,4326)"`) → ungültiges
   SQL. Lösung: PostgreSQL-Domains; kein manuelles Nachbearbeiten generierter Migrationen.
2. Der erste Drift-Check war **wirkungslos**: `drizzle-kit` beendet sich bei absoluten
   `--out`-Pfaden trotz Fehler mit Exit-Code 0. Lösung: relativer Pfad und
   fail-closed-Auswertung; per Negativtest (hinzugefügte Spalte → Exit 1) belegt.

Rollback/Recovery: Es gibt keine Produktionsdaten; das Initialschema kann durch Neuaufbau
zurückgesetzt werden. Ab dem ersten Produktivbetrieb gilt: nur additive Vorwärts-
Migrationen, Rücknahme per Folge-Migration, Point-in-Time-Recovery des Hosters als
Wiederherstellungsnetz (Hosting-Entscheidung offen).

## 7. Auth

Better Auth 1.7.6, in echten HTTP-Requests über `auth.handler` getestet:

| Anforderung | Umsetzung | Test |
| --- | --- | --- |
| E-Mail-Verifizierung | Pflicht vor erster Session, Link 1 h | Sign-in vor Verifizierung → 403 |
| Passwort-Reset | 30 min, einmalig, widerruft alle Sessions | alter Cookie ungültig, Token-Wiederverwendung → 400 |
| Passwortregel | 12–128 Zeichen | 400 bei 8 Zeichen |
| Rate Limiting | pro IP, Datenbank-Speicher, strenge Regeln für Sign-in/Sign-up/Reset/2FA | 11. Sign-in derselben IP → 429 |
| Konto-Sperre | 5 Fehlversuche/15 min → 15 min gesperrt, auch für unbekannte E-Mails | 429 `ACCOUNT_LOCKED`, Freigabe nach Ablauf |
| Sessions | DB, 7 Tage, kein Cookie-Cache | Widerruf wirkt sofort |
| Session-Widerruf | eigene Sessions bzw. `session:revoke_any` | Dispatcher → 403, Admin → OK, auditiert |
| Einladungen | 32 Byte Token, nur Hash gespeichert, 7 Tage, einmalig, E-Mail muss verifiziert und identisch sein | Fremd-/Mehrfach-/Ablauf-Fälle → NOT_FOUND |
| Admin-MFA | Plugin `twoFactor` (TOTP); `SUPER_ADMIN`/`ADMIN`/`FINANCE` ohne MFA ohne Rechte | echte TOTP-Einrichtung im Test, vorher `MFA_REQUIRED` |
| Recovery | Backup-Codes (Plugin), Reset nur per verifizierter E-Mail; `bootstrapSuperAdmin` nur einmal | zweiter Bootstrap → CONFLICT |
| E-Mail-Versand | Port ohne Default; ohne Sender startet Auth nicht | Konfigurationstest |

Bewusste Entscheidung: Plugin `admin` wird nicht genutzt, weil es ein zweites Rollensystem
auf `user.role` einführen würde. Sperren und Session-Widerruf sind eigene, auditierte Funktionen.

## 8. RBAC

- 7 Rollen, 24 Permissions; Matrix als Code (`packages/auth/src/permissions.ts`), in die
  Tabellen synchronisiert (Test: DB spiegelt Code).
- `authorize(actor, permission, resource)`: OWN-Scopes erfordern die Zielressource
  (IDOR-Schutz); privilegierte Rollen ohne MFA → `MFA_REQUIRED`.
- `payment_policy:manage` nur `SUPER_ADMIN` und `FINANCE`; `ADMIN` ausdrücklich nicht.
- Rechteausweitung: `ADMIN` kann weder `ADMIN` noch `SUPER_ADMIN` vergeben; B2B-/Partner-
  Verantwortliche nur einfache Nutzer im eigenen Scope; Scope-Admin-Recht vergeben nur
  globale Admins.
- DB-Constraints erzwingen passende Scopes (`CUSTOMER` ⇒ `customer_id` usw.).

## 9. CRM

- Kunden-Registrierung mit HMAC-gehashten Identitäten: gleiche E-Mail, Steuernummer oder
  Zahlungsreferenz → **bestehender** Kunde (negative Historie bleibt erhalten);
  widersprüchliche Merkmale → `CONFLICT`; Telefon oder gleiche Rechnungsadresse →
  Dublettenprüfung `PENDING` (erzwingt laut Policy Vorkasse).
- Adressen: Kunden können **keine** Koordinaten setzen (Gebiets-Spoofing); Mitarbeitende
  erfassen manuelle Koordinaten (`MANUAL`).
- Objekte nur mit Adresse desselben Kunden (Service-Prüfung und DB-Trigger).
- Leads nur aus freigegebenen Quellen, Status ausschließlich über `transitionLead`
  (Zustandsautomat, Guards, Optimistic Locking, Historie und Audit).
- Kontakte übernehmen die Quelle des Leads; Widerspruch → globale, gehashte Sperrliste;
  `CONTACTED` nur durch einen Menschen und nur mit nicht gesperrtem Kontakt.
- Consent unveränderlich; Rechtsgrundlage aus dem Zweck abgeleitet (Cookies → TDDDG § 25).

## 10. Geo

- `findServiceAreasForPoint`, `isAddressInServiceArea`, `findNearbyPartners`: generisch,
  nur aktive Gebiete, `ST_DWithin`/`ST_Covers` auf `geography`.
- Expansion ohne Code: Test legt einen größeren Kreis und ein Polygon als Daten an und
  aktiviert sie.
- Ungültige Polygone (Selbstüberschneidung) werden abgelehnt.
- Klassifizierte Suche nach „Gelsenkirchen“:

| Fundstelle | Klassifizierung |
| --- | --- |
| `packages/database/src/seed/reference-data.ts` (3×) | ERLAUBT – Seed |
| `docs/*`, `README.md`, `CLAUDE.md` | ERLAUBT – Dokumentation |
| `scripts/check-hardcoded-locations.mjs` | ERLAUBT – Denylist des Guards selbst |
| Fach-, Autorisierungs-, Preis-, Gebiets-, Zuweisungslogik | **keine Treffer** |

CI-Guard `check:hardcoding` sucht Standortnamen und Vergleiche von Standortfeldern mit
Literalen; per Negativtest belegt.

## 11. Security

| Prüfung | Ergebnis |
| --- | --- |
| Secret-Scan (gitleaks, Verzeichnis + Historie) | PASS – ein False Positive (`generic-api-key` auf einem Test-Slug) wurde durch Umbenennung behoben, **ohne** Allowlist |
| Verbotene Dateien | PASS (132 Dateien) |
| `.env` | keine versioniert; `.env.example` nur Platzhalter (+ `IDENTITY_HASH_PEPPER`, `AUTH_*`, `TEST_DATABASE_URL`) |
| RBAC-/IDOR-Review | Service-Aufrufe autorisieren vor dem Zugriff; OWN-Scopes erfordern Ressource; Tests für fremde Kunden, Adressen, Objekte, Consent |
| Mass Assignment | alle Eingaben `z.strictObject`; Test mit erlaubtem + geschütztem Feld schreibt nichts |
| Payment-Risk-Review | unsichere Richtlinien werden vom Validator und im Settings-Service abgelehnt; nichts gespeichert |
| SSRF | `assertSafePublicUrl` (Protokoll, Zugangsdaten, Ports, private/lokale Adressen nach DNS, IPv4-mapped, NAT64) |
| Logging/Audit | Audit append-only, Redaction; Kontakt-E-Mails nicht im Audit-Log |
| GitHub-Einstellungen | **offen** (Owner): Default-Branch, Sichtbarkeit, Rulesets, Remote-Tag |

**Mutationstests** (absichtlich eingebaute Lücken, Tests müssen rot werden): 10 von 10
erkannt – Policy-Untergrenze, IDOR-Bypass, MFA-Pflicht, Kontakt-Guard, Mass Assignment
(nach Verschärfung des Tests), inaktive Gebiete, Konto-Sperre, Rollen-Eskalation,
Dubletten-Umgehung, SSRF-Bereiche.

## 12. Tests

| Suite | Ergebnis |
| --- | --- |
| Unit (7 Dateien) | **307 bestanden** |
| Integration inkl. Security (6 Dateien, PostgreSQL 16 + PostGIS 3.4) | **73 bestanden** |
| E2E | **nicht vorhanden** – keine Benutzeroberfläche; nicht als bestanden gewertet |

## 13. CI

Bestehende Jobs unverändert (Secret-Scan, Repo-Guard, Markdown-Lint, actionlint). Neu:
`quality` (Typecheck, Lint/Format, Modulgrenzen, Hardcoding, Unit, Build), `integration`
(PostGIS-Service per Digest, Drift, Integrationstests), `dependencies` (Audit, Lizenzen),
`dependency-review` (nur PRs), Workflow `codeql.yml`, Dependabot für npm.

Ergebnis auf GitHub ([Lauf #7](https://github.com/habibmoosavi1376-cell/reinigunnsfirma-isela-clean-/actions/runs/36283688859),
Commit `d13f5e9`): **7/7 Jobs erfolgreich** – Secret-Scan, Repo-Guard, Markdown-Lint,
actionlint, Quality (Typecheck/Lint/Grenzen/Hardcoding/Unit/Build), Integration
(PostGIS-Container, Drift, 73 Tests), Dependencies (Audit/Lizenzen). `dependency-review`
und CodeQL laufen erst im Pull Request; ihr Ergebnis steht im PR.

## 14. Dependency audit

| Prüfung | Ergebnis |
| --- | --- |
| `pnpm audit` | 1 moderate Schwachstelle gefunden (GHSA-67mh-4wv8-2f99, esbuild 0.18 über `drizzle-kit` → `@esbuild-kit`, nur Dev) → per `overrides` auf gepatchtes 0.25.12 behoben; danach **0 Schwachstellen**, `drizzle-kit` funktionsfähig |
| Lizenzen | 179 Pakete, alle auf der Allowlist (MIT, Apache-2.0, ISC, BSD, BlueOak, MPL-2.0 für `lightningcss`) |
| Pinning | exakte Versionen (`save-exact`), Lockfile, frozen install in CI |
| Nicht installiert (unnötig an Tag 1) | Next.js, pg-boss, Turborepo, Testcontainers |

## 15. Risiken

| Risiko | Bewertung | Maßnahme |
| --- | --- | --- |
| Owner-Einstellungen fehlen (öffentlich, kein Schutz, Default-Branch, Tag) | hoch | Owner-Aktionen aus Phase-0.1-Report |
| Stapelung: `phase-1-foundation` enthält die Commits von PR #1 | mittel | PR #1 zuerst mergen; danach zeigt der Phase-1-PR nur Tag-1-Änderungen |
| Drizzle vor 1.0, `drizzle-kit`-Eigenheiten (Quoting, Exit-Code) | mittel | Pins, Domains, fail-closed Drift-Check |
| Env-Variablen noch nicht verdrahtet (keine App-Composition) | mittel | Zod-Env-Schema mit `apps/web`/`apps/worker` |
| Kein E-Mail-, Geocoding- oder Zahlungsanbieter | hoch für Produktivstart | Entscheidungen laut ROADMAP |
| Identitäts-Pepper-Rotation | mittel | Re-Hashing-Konzept vor Produktivbetrieb |
| Rate-Limit-IP-Ermittlung hängt vom Proxy-Setup ab | mittel | `AUTH_TRUSTED_PROXIES` je Deployment setzen |
| Rechtliche Punkte (UWG, Partner-Modell, Einwilligungstexte) | hoch | Rechtsberatung, bevor Outreach/Partner live gehen |

## 16. Offene Punkte

1. Owner: PR #1 mergen, `main` als Default, Repository privat, Ruleset für `main`,
   Tag `phase-0-complete`, Secret Scanning/Push Protection prüfen.
2. Fachliche Bestätigung der Default-Werte (Payment Policy, Lockout, Scoring-Gewichte).
3. `SESSION_IDLE_TIMEOUT_SECONDS` (aus Phase 0 in `.env.example`) ist mit Better Auth nicht
   direkt abbildbar; umgesetzt sind 7 Tage Laufzeit + tägliche Aktualisierung. Entscheidung,
   ob ein zusätzlicher Idle-Timeout benötigt wird.
4. Quelle und Lizenz für PLZ-/Gemeinde-Referenzdaten (Import an Tag 4).
5. Rolle `SALES` ist derzeit auf `ADMIN` abgebildet – eigene Rolle bei Bedarf.
6. Geocoding-Anbieter (Adressen bleiben bis dahin `PENDING`/`UNKNOWN` bzw. `MANUAL`).

## 17. Nächste Schritte

1. Review dieses Reports und des PRs; Owner-Aktionen.
2. Tag 2 laut ROADMAP ist inhaltlich weitgehend vorgezogen (DB/Auth/RBAC/CRM). Vorschlag
   für den nächsten Schritt: App-Composition (`apps/web` mit Next.js 16, Env-Schema,
   Better-Auth-Route, CSRF/Origin-Prüfung, Security-Header), danach Tag 3 (LeadFinder-
   Adapter für freigegebene Quellen, Scoring).

## 18. Status

```text
PHASE 1 DAY 1 COMPLETE
```

Einordnung ohne Beschönigung: Alle Tag-1-Lieferobjekte sind umgesetzt und lokal sowie in
der GitHub-CI verifiziert. **Nicht** Teil dieses Status und weiterhin offen sind die
Owner-seitigen GitHub-Einstellungen (§16.1) sowie alles, was an Tag 1 bewusst nicht gebaut
wurde (UI, Worker, Anbieter-Adapter, E2E).
