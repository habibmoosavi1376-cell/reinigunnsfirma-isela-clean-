# ISELA CLEAN – MVP-Roadmap (10 Tage)

Ziel: ein **getestetes** MVP innerhalb von 10 Kalendertagen. Das Zeitziel rechtfertigt
**keine** übersprungenen Tests, deaktivierten Prüfungen oder Fake-Implementierungen im
Produktionspfad. Reicht die Zeit nicht, wird der Umfang reduziert – nicht die Qualität.

## Globale Definition of Done (gilt für jeden Tag)

- [ ] Typecheck, Lint, Unit- und Integrationstests grün (lokal und in CI)
- [ ] Neue Fachregeln mit Tests inkl. Grenzfällen abgedeckt
- [ ] Neue Endpunkte/Use Cases mit Autorisierungstests (RBAC-Matrix erweitert)
- [ ] Keine Secrets, keine Produktionsdaten, keine Fake-Integrationen im Produktionscode
- [ ] Dokumentation (`PHASE_STATUS.md`, betroffene Specs) aktualisiert
- [ ] Änderungen über Feature-Branch + Pull Request

## Tagesplan

| Tag | Phase | Ergebnis (Kurzfassung) |
| --- | --- | --- |
| 0 | Foundation Audit | Baseline, Dokumentation, CI-Grundschutz ✅ |
| 1 | Foundation / Architektur / Security / CI | Monorepo, TS strict, Lint/Format, Vitest, Env-Validierung, CI mit Typecheck/Lint/Test/Build, CodeQL, Dependency Review, ADR-Freigabe |
| 2 | Database / Auth / RBAC / CRM | PostgreSQL + PostGIS, Migrationen, Auth, Sessions, Permissions, RBAC-Matrix-Tests, Audit-Log, CRM-Grundobjekte |
| 3 | Lead Finder / Auftragssuche / Lead Scoring | `LeadSource`-Port, Adapter „manuell/CSV“ + „Website-Anfrage“, erste geprüfte externe Quelle, Dedupe, erklärbares Scoring, Review-Queue |
| 4 | Services / Pricing / Quotes / Booking | Leistungskatalog, Einsatzgebiete (Geo), Preisregeln, Angebote, Buchungsanfrage |
| 5 | Jobs / Employees / Partners / Assignment | Aufträge, Mitarbeitende, Partnerprüfung, Zuweisung, Checklisten |
| 6 | Invoices / Payments / Payment Risk | Rechnungen (unveränderlich, Nummernkreis), Zahlungsanbieter im Testmodus, Webhooks, Payment Risk Engine, Partnerabrechnung |
| 7 | Website / SEO / Local SEO | Öffentliche Seiten, Leistungs- und Standortseiten, strukturierte Daten, Sitemap, Performance |
| 8 | Automation / Follow-ups / Reviews / Recurring | Wiederkehrende Aufträge, Erinnerungen, Follow-ups, Bewertungsanfragen |
| 9 | Security / Regression / E2E / Performance | Security-Review, E2E der Kernflows, Lasttest-Grundlage, Regressionen |
| 10 | Production Build / Deployment / Final Audit / Docs | Staging + Produktion, Backups getestet, Abschlussaudit, Betriebsdokumentation |

## Voraussetzungen, die vor dem jeweiligen Tag geklärt sein müssen

| Bis Tag | Entscheidung |
| --- | --- |
| 1 | Freigabe der vorgeschlagenen ADRs (`ARCHITECTURE.md` §2), Repository-Sichtbarkeit, Default-Branch |
| 2 | Auth-Bibliothek, Rollenmodell bestätigt |
| 3 | Rechtlich zulässige Lead-Quellen und Akquise-Kanäle |
| 6 | Zahlungsanbieter + Testzugang, Rechnungs-/Buchhaltungsweg, Payment-Policy-Defaults |
| 10 | Hosting-Anbieter (EU), Domain, E-Mail-Versanddienst |
