# ISELA CLEAN – Phasenstatus

| Feld | Wert |
| --- | --- |
| Stand | 2026-09-29 |
| Aktuelle Phase | **Phase 0 – Foundation Audit** (abgeschlossen, siehe [`PHASE_0_REPORT.md`](PHASE_0_REPORT.md)); **Phase 0.1 – Repository Handover** (siehe [`PHASE_0_1_REPORT.md`](PHASE_0_1_REPORT.md)) |
| Phase 1 / Tag 1 | Spezifikation, Stack Gate, Datenbank, Auth, RBAC, CRM – siehe [`PHASE_1_DAY_1_REPORT.md`](PHASE_1_DAY_1_REPORT.md) (Branch `phase-1-foundation`) |
| Phase 1 / Tag 4 | Kunden-CRM, Adressen, Objekte, Angebotsgrundlage – siehe [`PHASE_1_DAY_4_REPORT.md`](PHASE_1_DAY_4_REPORT.md) (Branch `phase-1-day-4`) |
| Phase 1 / Tag 5 | Services, Pricing Engine, Buchung, Einsätze, Zuweisung – siehe [`PHASE_1_DAY_5_REPORT.md`](PHASE_1_DAY_5_REPORT.md) (Branch `phase-1-day-5`) |
| Nächste Phase | Phase 1 / Tag 6 gemäß ROADMAP – erst nach Review des Tag-5-Reports |
| Repository | `habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` (öffentlich) |
| Arbeitsbranch | `claude/untitled-session-mhhecl` |

## 1. Vorgefundener Zustand (Baseline vor Phase 0)

Exakt dokumentiert, **bevor** eine Datei angelegt wurde:

| Prüfung | Ergebnis |
| --- | --- |
| `git status` | `On branch claude/untitled-session-mhhecl` – `No commits yet` – nichts zu committen |
| `git branch -a` | keine Branches (lokaler Branch ohne Commit, keine Remote-Branches) |
| `git log --oneline --decorate -20` | Fehler: Branch hat noch keine Commits |
| `git remote -v` | `origin` → `https://github.com/habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` |
| `git ls-remote origin` | leer – keine Refs auf GitHub |
| GitHub API | `409 Git Repository is empty`; 0 Branches |
| Dateien im Arbeitsverzeichnis | keine (nur `.git/`) |
| Git-Hooks | keine aktiven Hooks (nur `*.sample`) |
| `.env`-Dateien | keine vorhanden |
| Secret-Scan (gitleaks 8.30.1, Verzeichnis) | 0 Funde (0 Bytes gescannt) |
| Repository `cleaning-platform-gelsenkirchen` | **nicht gefunden** bzw. kein Zugriff (siehe §6) |

### 1.1 Komponenten-Inventar der Baseline

| Bereich | Vorhanden |
| --- | --- |
| `package.json` / Lockfiles | nein |
| Framework | nein |
| Node-Version-Festlegung (`.nvmrc`, `engines`) | nein |
| TypeScript | nein |
| Datenbank / ORM / Migrationen | nein |
| Authentifizierung | nein |
| Apps / Packages | nein |
| Tests | nein |
| CI/CD (`.github/workflows`) | nein |
| Deployment-Konfiguration | nein |
| Umgebungsvariablen-Vorlage | nein |
| Docker / Infrastructure-as-Code | nein |
| Dokumentation | nein |
| GitHub-Konfiguration (CODEOWNERS, Templates, Dependabot) | nein |

### 1.2 Entwicklungsumgebung (Container, nicht Teil des Repos)

Node.js 22.22.2, npm 10.9.7, pnpm 10.33.0, Docker 29.3.1, PostgreSQL-Client 16.13,
Python 3.11.15. Hinweis: ADR-002 schlägt Node.js 24 LTS vor – die Version wird in
Phase 1 über `.nvmrc`/`engines` festgelegt und in CI verwendet.

## 2. Aktueller Zustand (nach Phase 0)

| Bereich | Stand |
| --- | --- |
| Dokumentation | README, CLAUDE.md, AGENTS.md, Architektur, Produktspezifikation, Security, Roadmap, Status, Phase-0-Report |
| Repository-Schutz | `.gitignore` (Secrets, Dumps, Uploads), `.gitattributes`, `.editorconfig` |
| Umgebungsvariablen | `.env.example` nur mit Platzhaltern |
| CI | GitHub Actions: Secret-Scan, Repo-Guard, Markdown-Lint, Workflow-Lint (SHA-gepinnt, `contents: read`) |
| GitHub-Konfiguration | CODEOWNERS, PR-Template, Issue-Templates, Dependabot (Actions) |
| Anwendungscode | **keiner** (bewusst – Phase 1) |

## 3. Tests, Build, Qualität

| Prüfung | Status |
| --- | --- |
| Unit-/Integration-/E2E-Tests | **nicht vorhanden** – kein Anwendungscode (N/A, nicht „bestanden“) |
| Typecheck | N/A – kein TypeScript-Code |
| Build | N/A – kein Build-Ziel |
| Repo-Guard | bestanden |
| Markdown-Lint | bestanden |
| Workflow-Lint (actionlint + shellcheck) | bestanden |
| Secret-Scan (Verzeichnis + Git-Historie) | bestanden – 0 Funde |
| CI auf GitHub (Lauf #1, Commit `1ed1737`) | bestanden – 4/4 Jobs |

Details und exakte Befehle: [`PHASE_0_REPORT.md`](PHASE_0_REPORT.md).

## 4. Bekannte Probleme

1. **Repository-Name weicht ab:** Beauftragt war `cleaning-platform-gelsenkirchen`;
   verfügbar und genutzt wird `reinigunnsfirma-isela-clean-` (Entscheidung des
   Auftraggebers in dieser Session).
2. **Öffentliches Repository:** Geschäftsregeln (z. B. Payment-Risk-Schwellen) und
   Architektur sind öffentlich einsehbar.
3. **Default-Branch:** Da das Repository leer war, wird der erste gepushte Branch
   (`claude/untitled-session-mhhecl`) auf GitHub automatisch zum Default-Branch.
4. **Kein Branch-Schutz** konfiguriert (ohne Branches nicht möglich).

## 5. Technische Risiken

| Risiko | Auswirkung | Maßnahme |
| --- | --- | --- |
| 10-Tage-Zeitplan bei Start ohne Code | Qualitätsdruck | Umfang reduzieren statt Tests streichen (ROADMAP) |
| Offene Anbieterentscheidungen (Zahlung, Hosting, E-Mail) | Blockiert Tag 6/10 | Entscheidungen bis zu den in ROADMAP genannten Tagen |
| Rechtliche Fragen (UWG, Partner-Modell, E-Rechnung) | Nacharbeit, Haftung | Rechtsberatung vor Tag 3 bzw. Tag 5/6 |
| Öffentliche Sichtbarkeit | Offenlegung interner Regeln | Repository auf privat stellen oder Inhalte bewusst freigeben |
| Keine Lead-Datenquelle mit API-Zugang vereinbart | Tag 3 nur mit manuellen Quellen | Quelle + Nutzungsbedingungen vor Tag 3 klären |

## 6. Fehlende Komponenten

Monorepo-Setup, TypeScript-Konfiguration, Lint/Format, Test-Framework, Env-Validierung,
Datenbank + Migrationen, Auth/RBAC, sämtliche Fachmodule (CRM, Acquisition, Catalog,
Pricing, Booking, Recurring, Fulfillment, Quality, Billing, Payment Risk, Audit),
Website, Worker, Deployment, Monitoring, Backups.

## 7. Empfehlungen für Phase 1

1. Offene Punkte aus `PHASE_0_REPORT.md` §11 entscheiden (Sichtbarkeit, Default-Branch,
   ADR-Freigabe).
2. Monorepo gemäß `ARCHITECTURE.md` §3 anlegen: pnpm-Workspaces, Turborepo,
   TypeScript strict, ESLint (inkl. Modulgrenzen), Prettier, Vitest, `.nvmrc`.
3. `packages/core` (Money, IDs, Result, Clock) und `packages/config` (Zod-Env-Schema)
   **testgetrieben** implementieren – noch ohne Fachlogik.
4. CI erweitern: `pnpm install --frozen-lockfile`, Typecheck, Lint, Test, Build,
   Dependency Review, CodeQL; npm-Ökosystem in Dependabot.
5. Branch-Schutz, Secret Scanning + Push Protection, Private Vulnerability Reporting aktivieren.

## 8. Stand nach Phase 1 / Tag 1

| Bereich | Stand |
| --- | --- |
| Spezifikation | `docs/DOMAIN_MODEL.md` (Adressen, Referenzdaten, Einsatzgebiete, Leistungen, Leads, Consent, Settings, Auth, Payment-Risk-Invarianten, LeadFinder) |
| Pakete | 11 Workspace-Pakete unter `packages/*` (siehe `ARCHITECTURE.md` §2.2) |
| Datenbank | 32 Tabellen, 3 Migrationen (Extensions, Schema, Integritäts-Guards), idempotente Seeds |
| Tests | Unit, Integration (PostgreSQL + PostGIS), Security; Zahlen im Tag-1-Report |
| CI | zusätzlich Typecheck, Lint, Unit, Integration, Build, Drift, Grenzen, Hardcoding, Audit, Lizenzen, Dependency Review, CodeQL |
| Noch nicht vorhanden | Benutzeroberfläche (`apps/web`), Worker (`apps/worker`), E-Mail-Anbieter-Adapter, Geocoding-Adapter, Zahlungsanbieter |

## 9. Stand nach Phase 1 / Tag 2

| Bereich | Stand |
| --- | --- |
| Web-App | `apps/web` (Next.js 16.3): Startseite, Anfrageformular, Auth-Seiten, Kundenbereich, Admin-Dashboard, Impressum/Datenschutz (Entwurf), Fehlerseiten, robots/sitemap |
| Pakete | 13 Workspace-Pakete (neu: `@isela/config`, `@isela/partners`) |
| Datenbank | 34 Tabellen, 4 Migrationen (neu: `0003_web_requests`, rein additiv) |
| Tests | Unit, Integration, Web-Integration, E2E (Playwright); Zahlen im Tag-2-Report |
| CI | zusätzlich Web-Build mit Client-Bundle-Secret-Scan und E2E-Job |
| Noch nicht vorhanden | Geocoding-Adapter, Angebote/Aufträge/Rechnungen, Zahlungsanbieter, Worker, Kunden-Selbstverknüpfung |

## 10. Stand nach Phase 1 / Tag 3

| Bereich | Stand |
| --- | --- |
| Geocoding | Vertrag `GeocodingProvider`, Geoapify-Adapter (aktiv nur mit Credentials), Qualitätsbewertung, menschliche Prüfung |
| Servicegebiet | `AVAILABLE`/`NOT_AVAILABLE`/`UNKNOWN` über PostGIS, gespeichert mit Gebiet und Zeitpunkt |
| Backoffice | `/admin/leads` (Filter, Suche, Pagination), `/admin/leads/[id]` (Kontakt, Anfrage, Adresse, Geocoding, Gebiet, Consent, Historie, Audit, Aktionen) |
| Kundenverknüpfung | Lead → Kunde (Dublettenerkennung), Konto ↔ Kunde (verifiziert, eindeutig, auditiert) |
| Datenbank | 36 Tabellen, 5 Migrationen (neu: `0004_geocoding_crm`, additiv bzw. `RENAME VALUE`) |
| Noch nicht vorhanden | Geocoding-Credentials/AVV, Angebote/Aufträge/Rechnungen, Zahlungen, LeadFinder-Provider, Landingpage-Inhalte und -Route |

## 11. Stand nach Phase 1 / Tag 4

| Bereich | Stand |
| --- | --- |
| Kunden-CRM | `/admin/customers` (Suche inkl. E-Mail-Hash, Filter, Pagination, Kennzahlen), `/admin/customers/[id]` (Stammdaten, Zahlungsstatus, Kontakte, Adressen, Objekte, Anfragen, Angebote, Consent, Audit) |
| Adressen/Objekte | Haupt-, Rechnungs-, Service-Adressen; Dublettenvermeidung im Lead-Fluss; Objektregister `/admin/properties`; Lead → Kunde → Adresse → Objekt |
| Angebote | Paket `@isela/quotes` (State Machine, Cent-Arithmetik, Pricing-Vertrag), `/admin/quotes`, Kundenansicht `/customer/quotes` |
| Einladung | Lead → Kunde → Einladung (gehashter Einmal-Token, Rate-Limit, Audit), Annahme `/account/invitation` |
| Datenbank | 39 Tabellen, 6 Migrationen (neu: `0005_customer_property_quotes`, additiv bzw. `RENAME VALUE`) |
| Noch nicht vorhanden | Aufträge, Rechnungen, Zahlungen (Zahlungshistorie daher leer → Vorkasse), Preis-Engine-Implementierung, Online-Annahme durch Kunden, E-Mail-Versand von Angeboten, pg_trgm (gemessen, zurückgestellt) |

## 12. Stand nach Phase 1 / Tag 5

| Bereich | Stand |
| --- | --- |
| Katalog | Service-Datenmodell (Mindestmenge, Dauermodell, Preisstrategie, Qualifikationen, Objektarten), Extras, zwölf Kategorien, `/admin/services` |
| Pricing | Paket `@isela/pricing`: Engine v1 (BigInt-Cent), versionierte Regelwerke mit `CONFIG_REQUIRED`, append-only Berechnungen, `/admin/pricing`; Angebotspositionen aus der Engine mit auditierter Übersteuerung; nie 0 EUR |
| Buchung | Paket `@isela/operations`: Angebot (ACCEPTED) → Buchung, Vorkasse-Pflicht aus Payment-Risk, manueller Zahlungsstatus (FINANCE, Referenz), `/admin/bookings`, Kundenportal `/customer/jobs` + `/customer/bookings/[id]` |
| Einsätze | Buchung → Einsatz, Lebenszyklus mit Guards, Zahlungssperre (Service + Trigger), `/admin/jobs`, `/team/jobs` für STAFF/PARTNER |
| Zuweisung | Mitarbeitende (Qualifikationen, Gebiete, Arbeitszeiten, Abwesenheiten), Partner-Verifikation, erklärbare Kandidaten/Score, Doppelbuchungsschutz (Exclusion-Constraint), Partnerzuweisung per Owner-Regel standardmäßig aus |
| Datenbank | 55 Tabellen, 7 Migrationen (neu: `0006_day5_services_bookings_jobs`, additiv; drei Checks `NOT VALID`) |
| Tests | 757 Unit, 203 Integration, 14 E2E |
| Noch nicht vorhanden | Preiswerte (Owner), Zahlungsanbieter, Rechnungen, Kreditbedingungen aus Zahlungshistorie, Online-Annahme durch Kunden, Stornobedingungen, `TAX_MODE`/Steuermodi, Qualitätsdaten (Zuverlässigkeit), Serien |

## 13. Stand nach Phase 1 / Tag 6

| Bereich | Stand |
| --- | --- |
| Rechnungen | Paket `@isela/billing`: Rechnung aus Buchung (Vorkasse-/Schlussrechnung), unveränderlicher Snapshot, Status-Maschine mit DB-Trigger, Nummernkreis je Präfix und Jahr (atomarer Zähler), Fälligkeit mit auditierter Änderung, Storno ohne Nummernwiederverwendung, `/admin/invoices[/id]` |
| Zahlungen | Zahlungen als Tatsachen mit eindeutiger Referenz und Idempotenzschlüssel, Bestätigung durch FINANCE/ADMIN, Teil-/Überzahlung, Erstattung, Rückbuchung, `/admin/payments`; Vorkasse wird nur noch über eine bezahlte Vorkasse-Rechnung bestätigt |
| Payment Risk | zentrale Engine `evaluateCustomerPaymentTerms` über die echte Historie (bezahlte Aufträge, Überfälligkeit, Rückbuchungen, Zahlungsprobleme, Obligo), Kreditfreigabe mit Vier-Augen, Widerruf, Fälligkeitslauf mit Zahlungsschutz, `/admin/payment-risk[/customerId]` |
| Provider/Webhooks | Abstraktion + Webhook-Sicherheitsarchitektur; **kein Anbieter aktiv** (CONFIG_REQUIRED, Route 404) |
| Kundenportal | `/customer/invoices[/id]` – eigene freigegebene Rechnungen, Zahlungsstatus, eigene Referenzen |
| Datenbank | 65 Tabellen, 8 Migrationen (neu: `0007_day6_invoices_payments_credit`, additiv; Upgrade-Test mit Day-5-Daten grün) |
| Tests | 896 Unit, 232 Integration, 15 E2E |
| Noch nicht vorhanden | Owner-Werte `billing.config` (CONFIG_REQUIRED), Zahlungsanbieter, Scheduler für den Fälligkeitslauf, rechtlich vollständige Rechnungsbelege (PDF, § 14 UStG, E-Rechnung, Storno-/Gutschriftbeleg), Überzahlungs-/Teilerstattungsregeln, Partnerabrechnung, Serien |
