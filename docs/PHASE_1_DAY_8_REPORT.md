# Phase 1 / Tag 8 – Bericht (Recurring, Erinnerungen, F7, Abhängigkeiten)

Stand: 2026-10-24. Branch `phase-1-day-8` auf `main` @ `6f59f5e` (Merge von PR #20), PR #21.
Nichts gemergt, nichts deployt, keine echten E-Mails oder Bewertungsanfragen versendet.

## 1. Umfang und Commits

| Commit | Inhalt |
| --- | --- |
| `887690c` | Day-8-Plan (cherry-pick von `2916fbc`, ohne PR-#20-Duplikat) |
| `58a61c7` | `nodemailer` 10.0.10 → 10.1.7 (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h) |
| `f1b638b`, `e09808e` | F7: Datumsfilter (Leads, Kunden, Einsätze, Berichtszeitraum) in Geschäftstagen |
| `3f16147`, `0d8bc44` | Plan-Aktualisierungen |
| `7191193` | Wiederkehrende Aufträge (Migration 0009, Termin-Expansion, idempotente Generierung) |
| `f9517db` | Terminerinnerungen über Outbox (Migration 0010, At-most-once-Versand) |

## 2. Fachliche Änderungen

### 2.1 F7 – Datumsfilter

`businessDayStart`/`businessDayEnd`/`businessDateTime` in `@isela/shared` (DST-sicher). Admin-Listen
und Berichtszeitraum interpretieren Kalendertage in der Geschäftszeitzone (`operations.timeZone`).
Ohne Zeitzonenangabe bleibt das Verhalten UTC (rückwärtskompatibel).

### 2.2 Wiederkehrende Aufträge

- `expandOccurrences`: reine Funktion, `WEEKLY`/`BIWEEKLY` (Wochentag des Starts), `MONTHLY`
  (Tag 1–28). Feiertage und Pausen sind **Eingaben**; betroffene Termine werden übersprungen
  (`HOLIDAY`, `PAUSED`, `INVALID_LOCAL_TIME`), nie verschoben. Obergrenze 400 Termine je Lauf.
- Migration `0009` (additiv): `service_contract`, `contract_pause`, `contract_occurrence`
  (`UNIQUE(contract_id, occurrence_date)`, Zustandsprüfung), `public_holiday`,
  `holiday_year_coverage`, `booking_source = CONTRACT` (Vertragsbuchungen ohne `quote_id`).
- `generateContractBookings`: je Termin eigene Transaktion mit Vertragssperre; verweigert Jahre
  ohne freigegebene Feiertagsdaten und Fenster > 120 Tage; erzeugt nie Termine in der
  Vergangenheit. **Keine Feiertagsdaten werden mitgeliefert.**
- `createBookingRecord` aus `createBookingFromQuote` extrahiert: Angebots- und
  Vertragsbuchungen nutzen dieselbe Zahlungslogik (Vorkasse für Neukunden und Aufträge 1–2,
  Rechnungskauf nur mit genehmigter Kreditentscheidung, Vorkasse bei Überfälligkeit) und
  denselben Job-Start-Guard.
- `recordHolidayYear` (`settings:manage`), `addContractPause`, `getServiceContract`.
- Noch keine Admin-Oberfläche und kein Zeitplaner (ADR-008 offen).

### 2.3 Terminerinnerungen

- Migration `0010` (additiv): `notification_outbox` mit eindeutigem Dedupe-Schlüssel; keine
  Empfängeradresse und kein Inhalt gespeichert; nur maschinenlesbare Fehlercodes.
- `enqueueAppointmentReminders`: nur `CONFIRMED`/`SCHEDULED` (bezahlte Vorkasse bzw.
  genehmigter Kredit), wiederholbar ohne Duplikate.
- `dispatchNotifications`: `FOR UPDATE SKIP LOCKED`; `SENDING` wird vor dem Versand
  festgeschrieben (at-most-once); hängende Zustellungen werden `UNCERTAIN` und nie automatisch
  wiederholt; Backoff, danach `DEAD`; Empfänger = verifiziertes Kundenkonto zum Versandzeitpunkt;
  gesperrte Adressen, stornierte und vergangene Termine werden übersprungen.
- Versand nur über den `EmailSender`-Port; in Tests eine In-Memory-Senke, in E2E die lokale
  SMTP-Testsenke. Keine Zugangsdaten im Repository.
- **Bewertungsanfragen nicht implementiert** (Rechtsgrundlage offen).

## 3. Tests und Prüfungen (2026-10-24)

| Prüfung | Befehl | Ergebnis |
| --- | --- | --- |
| Typecheck | `pnpm run typecheck` | PASS |
| Lint | `pnpm run lint` | PASS |
| Unit | `pnpm run test:unit` | PASS 938/938 |
| Integration | `pnpm run test:integration` | PASS 263/263 |
| Build | `pnpm run build`, `next build` | PASS |
| E2E | `playwright test` | PASS 26/26 |
| Migration Drift | `pnpm run db:check` | PASS |
| Upgrade-Test | `main`-Stand (9 Migrationen) mit Daten aus `main`-Tests → Migrator des Branches | PASS: 11 Migrationen, 49 Buchungen / 35 Rechnungen unverändert (Prüfsumme identisch) |
| Boundaries, Hardcoding | `check:boundaries`, `check:hardcoding` | PASS |
| Audit, Lizenzen | `check:audit`, `check:licenses` | PASS |
| Secret-Scan | gitleaks auf `origin/main..HEAD` | PASS |
| CI `f9517db` | CI #93 (push), #94 (PR), CodeQL #43 | PASS inkl. Dependency Review |

Nachweise, dass Tests Fehler erkennen: F7-Integrationstest schlägt mit der alten UTC-Logik
fehl; Konkurrenztests für Generierung und Versand laufen wiederholt stabil.

Behobene Fehler: F7 (Datumsgrenzen um 1–2 h verschoben); PostgreSQL 55P04 beim
Hinzufügen des Enum-Werts `CONTRACT` (Prüfung als Text); fehlerhafte Annahme im eigenen
Konkurrenztest (Gewinner der Parallelläufe ist nicht festgelegt).

## 4. Offene Punkte

Siehe `docs/LAUNCH_READINESS.md`.
