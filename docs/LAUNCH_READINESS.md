# Launch Readiness – ISELA CLEAN (Stand 2026-10-24)

**Entscheidung: KEINE Produktionsfreigabe.** Kritische Betriebs-, Zahlungs- und
Rechtsvoraussetzungen sind offen (§3). Technisch geprüft ist der Stand von `main` @ `6f59f5e`
plus PR #21 (`phase-1-day-8`, Head siehe PR).

Legende: PASS = geprüft und erfolgreich · FAIL = Prüfung fehlgeschlagen bzw. Anforderung
nicht erfüllt · BLOCKED = Voraussetzung/Freigabe fehlt · UNKNOWN = nicht verlässlich geprüft.

## 1. Technische Prüfungen

| Prüfung | Status | Nachweis |
| --- | --- | --- |
| Typecheck, Lint, Unit (938), Integration (263), E2E (26), Build | PASS | lokal 2026-10-24; CI #93/#94 |
| Migrationen 0000–0010, Drift, Upgrade mit Daten | PASS | `db:check`; Upgrade-Test (Tagesbericht §3) |
| Modulgrenzen, Hardcoding | PASS | `check:boundaries`, `check:hardcoding` |
| Dependency Audit, Lizenzen, Dependency Review | PASS | `check:audit`, `check:licenses`, CI |
| CodeQL, Secret-Scan | PASS | CodeQL #43, gitleaks |
| Health-/Readiness-Endpunkte | FAIL | nicht vorhanden (in `ARCHITECTURE.md` als Betriebsanforderung vorgesehen) |
| Monitoring, Alarmierung | FAIL | nicht vorhanden |
| Backups und Wiederherstellungstest | BLOCKED | Hosting nicht entschieden (ROADMAP Tag 10) |
| Last-/Performance-Test | UNKNOWN | nicht durchgeführt |

## 2. Fachliche Launch-Prüfung

| # | Bereich | Status | Anmerkung |
| --- | --- | --- | --- |
| 1 | Registrierung, Anmeldung, Berechtigungen | PASS | E2E- und RBAC-Tests |
| 2 | Kunden-, Lead-, Jobverwaltung | PASS | Integration/E2E |
| 3 | Datumsfilter, Terminplanung | PASS | F7 + Recurring-Tests; keine Oberfläche für Verträge |
| 4 | Vorkasse, Rechnungsfreigabe, Überfälligkeit | PASS | Payment-Risk-, Billing-, Guard-Tests |
| 5 | Wiederkehrende Aufträge, Doppelverarbeitung | PASS (Backend) / BLOCKED (Betrieb) | Idempotenz getestet; Feiertagsdaten und Zeitplaner fehlen |
| 6 | Benachrichtigungen im Testmodus | PASS (Backend) / BLOCKED (Betrieb) | Outbox getestet; Versanddienst und Zeitplaner fehlen |
| 7 | Datenschutz, Logging, Secrets | PASS (technisch) | Logs nur IDs/Zähler; Rechtstexte sind Entwürfe |
| 8 | Fehlerzustände, Nutzerhinweise | PASS | bestehende E2E; neue Funktionen ohne UI |
| 9 | Migrationen, Rückfallstrategie | PASS | nur additive Migrationen; Rückfall = Code-Revert, neue Tabellen bleiben ungenutzt |
| 10 | Dokumentation, Einschränkungen | PASS | Plan, Tagesbericht, dieser Bericht |

## 3. Vor dem ersten echten Kundenauftrag erforderlich

1. Hosting (EU), Domain, Backups mit Wiederherstellungstest, Health-Checks, Monitoring.
2. E-Mail-Versanddienst auswählen und freigeben (bis dahin nur Testsenke).
3. Zahlungsanbieter bzw. Zahlungsweg (ADR-010) und Buchhaltungsweg; Payment-Policy-Werte bestätigen.
4. Rechtstexte (Impressum, Datenschutz, AGB/Widerruf) fachlich prüfen und freigeben; echte Firmendaten.
5. ADR-008 (Zeitplaner/Worker) entscheiden; erst dann laufen Generierung und Erinnerungen automatisch.
6. NRW-Feiertagsdaten aus amtlicher Quelle erfassen und freigeben (`recordHolidayYear`).
7. Bewertungsanfragen: Kanal, Zeitpunkt, Rechtsgrundlage – erst danach implementieren.
8. Oberfläche für Verträge, Pausen und Benachrichtigungsstatus (Back Office).

## 4. Bekannte Risiken

- Ohne Zeitplaner keine automatische Ausführung (manuelle Auslösung nur über Code möglich).
- F4 (`pg@9`-Vorbereitung) offen, niedrig.
- Ruleset erlaubt noch Squash/Rebase-Merges.
- Dependabot-PRs basieren teils auf älterem `main`; #19 wird mit PR #21 gegenstandslos.
