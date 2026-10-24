# Phase 1 / Tag 8 – Implementierungsplan (Automation, Follow-ups, Reviews, Recurring)

Stand: 2026-10-24 (Basis `main` @ `6f59f5e`, nach PR #20). **Plan; umgesetzt ist nur F7 (§2 E).** Tag 8 hängt von Voraussetzungen ab
(§1); Code wird erst nach deren Klärung und nach grünem `main` geschrieben.

Quellen: `docs/ROADMAP.md` (Tag 8), `docs/PRODUCT_SPEC.md` §1.3, §4 (Recurring, Automation),
`docs/DOMAIN_MODEL.md` (Überfälligkeit bei wiederkehrenden Aufträgen),
`docs/ARCHITECTURE.md` (ADR-008 pg-boss, `apps/worker`), `docs/PHASE_1_INTEGRATION_GATE.md`
(Follow-ups F4, F7).

## 1. Voraussetzungen und Blocker

| # | Voraussetzung | Warum | Wer |
| --- | --- | --- | --- |
| V1 | PR #20 (Sicherheits-Updates) gemergt, `main` grün | Jeder neue PR würde sonst am Audit-Gate scheitern | **erfüllt** (Merge-Commit `6f59f5e`, 2026-10-23) |
| V2 | ADR-008 (pg-boss als Job-Queue) von „Vorgeschlagen“ auf „Angenommen“ | Erste neue Laufzeitabhängigkeit + Dauerprozess `apps/worker` | Owner |
| V3 | Feiertagsquelle für NRW (statische, versionierte Datentabelle vs. Bibliothek) | Termine dürfen nicht auf Feiertage fallen (§1.3) | Owner/Recht – Empfehlung: Datentabelle |
| V4 | Bewertungsanfragen: Plattform/Kanal, Zeitpunkt, Einwilligung | UWG §7 (Werbe-E-Mail nur mit Einwilligung bzw. Bestandskunden-Ausnahme), keine Anreize für Bewertungen | Owner/Recht |
| V5 | E-Mail-Versanddienst für Produktion (Tag 10) | Bis dahin nur SMTP-Testsenke; keine echten Versände | Owner |

Ohne V2 kann Teil A (Regeln, Generierung als reine Funktionen + DB) dennoch umgesetzt werden;
die zeitgesteuerte Ausführung (Teil C) wartet auf V2.

## 2. Umfang

### A. Wiederkehrende Aufträge (Recurring)

- Schema (Migration `0009`, additiv): `service_contract` (Kunde, Objekt, Leistungsumfang aus
  Angebot, Status, Laufzeit), `recurrence_rule` (`WEEKLY`/`BIWEEKLY`/`MONTHLY`/`CUSTOM`
  RRULE-Teilmenge, Zeitfenster, Zeitzone, Pausen), `occurrence` (Datum, Status, erzeugte
  `booking_id`, eindeutig je Vertrag + Datum).
- Paket `packages/recurring` (laut `ARCHITECTURE.md`): reine Funktion
  `expandOccurrences(rule, window, holidays, pauses)`; idempotente Generierung
  (`UNIQUE(contract_id, occurrence_date)`, `ON CONFLICT DO NOTHING`).
- **Zahlungsregeln unverändert:** Jede erzeugte Buchung durchläuft
  `evaluateCustomerPaymentTerms`; Neukunden und Aufträge 1–2 bleiben Vorkasse; Kreditbedingungen
  nur mit genehmigter Kreditentscheidung; der Job-Start-Guard bleibt die letzte Sperre.
- Überfälligkeit: alle noch nicht ausgeführten Termine auf Vorkasse umstellen und zur Prüfung
  markieren, keine automatische Kündigung (`DOMAIN_MODEL.md`).

### B. Follow-ups und Erinnerungen

- `scheduled_task`/`reminder` (Typ, Bezug, Fälligkeit, Status, Idempotenzschlüssel).
- Interne Wiedervorlagen (Lead-Follow-up, offene Angebote, Prüf-Queue) – **keine**
  automatische Kontaktaufnahme mit Leads; Outreach bleibt menschlich freigegeben.
- Kunden-Erinnerungen (Termin, Zahlung fällig) nur transaktional, PII-frei geloggt.

### C. Ausführung (nach V2)

- `apps/worker` mit pg-boss; Jobs: Termin-Generierung, Fälligkeitslauf, Erinnerungen,
  Payment-Risk-Neubewertung. Jeder Job idempotent, mit Audit-Eintrag; Retries ohne doppelte
  Finanzvorgänge.

### D. Bewertungsanfragen (nach V4)

- Nur nach abgeschlossenem **und** bezahltem Auftrag, nur mit gültiger Rechtsgrundlage,
  einmal je Auftrag, Abmeldung respektiert; keine Anreize, keine Vorfilterung.

### E. Mitzunehmende Follow-ups aus dem Integrations-Gate

- F7 (**umgesetzt** auf `phase-1-day-8`): `businessDayStart`/`businessDayEnd` in
  `@isela/shared`; Lead-, Kunden- und Einsatzlisten interpretieren Datumsfilter als Tage in
  der Geschäftszeitzone (Admin-Seiten übergeben `operations.timeZone`). Unverändert und
  korrekt: `quotes/config.ts` `addDays` und `format.ts` (reine Kalenderarithmetik). Der
  Berichtszeitraum (`report-range.ts`) verwendet ebenfalls Geschäftstage (`e09808e`).
- F4: Lesezugriffe per `Promise.all` auf demselben Transaktions-Client sequenzialisieren
  (Vorbereitung `pg@9`).

## 3. Akzeptanzkriterien

1. Eine Regel erzeugt für ein Zeitfenster genau die erwarteten Termine (Feiertage/Pausen
   ausgelassen), wiederholte Läufe erzeugen keine Duplikate.
2. Termine von Neukunden bzw. Aufträgen 1–2 erzeugen Buchungen mit Vorkasse; ein Job startet
   nie ohne bestätigte Vorauszahlung oder genehmigte Kreditbedingungen.
3. Eine überfällige Rechnung stellt alle offenen Termine des Kunden auf Vorkasse + Prüfung um.
4. Ein neues Konto setzt die Historie eines bestehenden Kunden nicht zurück (bestehende Tests
   bleiben grün).
5. Erinnerungen werden genau einmal ausgelöst (Idempotenzschlüssel), Logs ohne PII.
6. Keine automatische Lead-Kontaktaufnahme; Bewertungsanfragen nur nach V4.
7. Alle bestehenden Gates grün, Migration additiv, Upgrade-Test mit Tag-7-Daten.

## 4. Tests

- Unit: `expandOccurrences` (Monatsende, Sommerzeit, Feiertage, Pausen, CUSTOM-Regeln),
  Zustandsautomaten, Idempotenzschlüssel.
- Integration (PostgreSQL + PostGIS): parallele Generierung (Race), Zahlungsregeln je
  Termin, Überfälligkeits-Umstellung, RBAC (`contract:*`-Berechtigungen, Objektbesitz).
- E2E: Vertrag anlegen → Termine sichtbar → Buchung mit Vorkasse; Kunde sieht nur eigene
  Verträge.
- Regression: komplette Tag-1–7-Suiten.

## 5. Betroffene Dateien (voraussichtlich)

`packages/database/src/schema/operations.ts` (bzw. neues `recurring.ts`),
`packages/database/migrations/0009_*.sql`, `packages/recurring/` (neu),
`packages/operations/src/bookings.ts` (Erzeugung aus Termin), `packages/auth/src/permissions.ts`,
`apps/web/app/admin/contracts/**`, `apps/web/app/customer/(area)/contracts/**`,
`apps/worker/` (nach V2), `docs/*` (Status, Report, Domain Model, Architecture).

## 6. Entscheidungsvorlagen (Owner)

Keine dieser Entscheidungen ist in den Projektdokumenten freigegeben. Bis zur Freigabe wird
nur unabhängig Ausführbares umgesetzt. Rechtliche Punkte sind Prüffragen, keine
Rechtsberatung.

### 6.1 ADR-008 – Hintergrundjobs

| Option | Vorteile | Risiken |
| --- | --- | --- |
| A: pg-boss (ADR-Vorschlag) | Postgres-basiert, keine Zusatzinfrastruktur, Retries, Scheduling, Singleton-Jobs | neue Laufzeitabhängigkeit + eigenes Schema; Dauerprozess `apps/worker` nötig (Hosting, Tag 10) |
| B: eigene Tabelle + `FOR UPDATE SKIP LOCKED` | keine Abhängigkeit, volle Kontrolle | Retries/Backoff/Scheduling selbst bauen und testen |
| C: externer Cron ruft idempotente Endpunkte | kein Dauerprozess | Abhängigkeit vom Hosting; Authentifizierung der Aufrufe; keine Queue-Semantik |

Unabhängig von der Option verbindlich: jeder Job idempotent (fachlicher Schlüssel +
Unique-Index, wie bei Zahlungen/Webhooks), Retries mit Backoff und Obergrenze, danach
„dead letter“ mit Alarm; Audit-Eintrag ohne PII; kein Finanzvorgang doppelt
(DB-Constraints bleiben die letzte Sperre). Empfehlung: Option A, sobald der Hosting-Weg
einen Dauerprozess zulässt; Teil A (Termin-Expansion als reine Funktion + DB) ist davon
unabhängig.

### 6.2 NRW-Feiertage

Vorschlag: versionierte Datentabelle `public_holiday` (Region `DE-NW`, Datum, Name,
Quelle, Version) mit Seed pro Jahr; Quelle ist die geltende Feiertagsregelung des Landes
NRW (Feiertagsgesetz NW) bzw. eine amtliche Veröffentlichung – vom Owner zu bestätigen.
Bewegliche Feiertage können aus der Osterformel berechnet werden, der Seed wird aber
**gegen die Quelle geprüft** und per Review freigegeben. Pflege: jährlicher Seed im Q4,
Änderungen nur per Migration/Review. Die Termin-Expansion bekommt die Feiertage als
Parameter (keine Daten im Code).

### 6.3 Bewertungsanfragen

Zu entscheiden: Kanal (E-Mail/Portal), Zeitpunkt (nach abgeschlossenem **und** bezahltem
Auftrag), Häufigkeit (höchstens einmal je Auftrag), Rechtsgrundlage bzw. Einwilligung für
werbliche E-Mails, Widerspruchsmöglichkeit, Ziel-Plattform und deren Richtlinien. Keine
Anreize, keine Vorfilterung. Bis zur Freigabe: keine Anfragen, auch nicht im Testmodus an
echte Adressen.

### 6.4 E-Mail-Versand

Bis zur Provider-Freigabe (ROADMAP Tag 10) bleibt `EMAIL_PROVIDER=smtp` gegen die lokale
Testsenke; keine Zugangsdaten im Repository, keine Kundenmails. Neue Erinnerungen werden
gegen die Testsenke getestet.
