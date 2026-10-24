# Betrieb – Runbook (Stand 2026-10-24)

Gilt für jede Umgebung. Hosting, Domain und E-Mail-Versanddienst sind **noch nicht
entschieden** (ROADMAP Tag 10); die folgenden Verfahren sind lokal geprüft und
anbieterunabhängig.

## 1. Health-Checks

| Endpunkt | Zweck | Antwort |
| --- | --- | --- |
| `GET /api/health` | Liveness (Prozess antwortet) | `200 {"status":"ok"}` |
| `GET /api/health/ready` | Readiness (Datenbank antwortet in ≤ 2 s) | `200 {"status":"ok"}` bzw. `503 {"status":"unavailable"}` |

Keine Versionen, Hosts oder Fehlermeldungen in der Antwort; `Cache-Control: no-store`.
Monitoring/Alarmierung ist noch nicht angebunden (Anbieter offen).

## 2. Geplante Abläufe (Termin-Erzeugung, Erinnerungen)

```bash
pnpm --filter @isela/web run jobs:run
```

- Technologieneutral (ADR-008 offen): z. B. alle 15 Minuten per Cron des Hosters. Ein
  späterer Worker (pg-boss) ruft dieselbe Funktion `runScheduledWork` auf.
- Läuft als Dienstkonto `JOBS_ACTOR_USER_ID` (Rolle mit `booking:write`, z. B. DISPATCHER;
  jede erzeugte Buchung ist im Audit-Log zuordenbar). Ohne Variable startet der Lauf nicht.
- Idempotent; überlappende Läufe werden per transaktionsgebundenem Advisory-Lock übersprungen.
- Ohne konfigurierte Feiertagsregion bzw. ohne freigegebene Feiertagsjahre werden **keine**
  Termine erzeugt (Back Office → Wiederkehrende Aufträge → Feiertagsdaten).
- `APP_ENVIRONMENT=production`: Erinnerungen werden vorgemerkt, aber **nicht versendet**,
  bis ein Versanddienst freigegeben ist. Außerhalb von Produktion nur an die SMTP-Testsenke
  der jeweiligen Umgebung.
- Ausgabe: eine JSON-Zeile mit Zählern (keine personenbezogenen Daten).

## 3. Benachrichtigungen – manuelle Prüfung

Back Office → Benachrichtigungen. Prüfbedürftig: `DEAD` (endgültig fehlgeschlagen),
`UNCERTAIN` (Zustellung unklar; erneuter Versand nur mit ausdrücklicher Bestätigung möglicher
Dublette), `NO_RECIPIENT` (kein verifiziertes Kundenkonto). `SUPPRESSED` ist bindend.

## 4. Backup und Wiederherstellung

Verfahren (PostgreSQL 16 + PostGIS):

```bash
pg_dump -Fc --no-owner -f backup.dump "$DATABASE_URL"
createdb <ziel>; psql -d <ziel> -c "CREATE EXTENSION postgis; CREATE EXTENSION pg_trgm; CREATE EXTENSION citext;"
pg_restore --no-owner -d "<ziel-url>" backup.dump
DATABASE_URL="<ziel-url>" pnpm run db:migrate   # meldet „Migrations applied.“ ohne Änderungen
```

**Wiederherstellungstest am 2026-10-24 (lokal, Testdatenbank):** Sicherung 642 628 Byte;
nach Wiederherstellung identisch: 134 Buchungen, 49 Rechnungen, 31 Zahlungen, 168 Kunden,
2 759 Audit-Einträge, 12 Migrationen, Prüfsumme über alle Buchungen gleich; Migrator auf der
wiederhergestellten Datenbank ohne ausstehende Migrationen.

Offen (Hosting): Zeitplan, Aufbewahrung, Verschlüsselung und Speicherort der Sicherungen,
regelmäßiger Wiederherstellungstest in der Zielumgebung, Point-in-Time-Recovery.

## 5. Migrationen und Rückfall

Alle Migrationen sind additiv. Rückfall = Code-Revert; neue Tabellen/Spalten bleiben
ungenutzt bestehen. Vor jeder Produktionsmigration: Sicherung (§4) und Upgrade-Test gegen
eine Kopie.
