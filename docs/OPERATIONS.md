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
Monitoring/Alarmierung ist noch nicht angebunden (Anbieter offen); Regeln siehe §6.

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

## 6. Monitoring und Alarmierung (Regeln, anbieterunabhängig)

Status: **definiert, nicht angebunden** (Anbieter und Zielumgebung offen). Empfohlene Regeln:

| Signal | Prüfung | Alarm |
| --- | --- | --- |
| Liveness | `GET /api/health` alle 60 s aus einer zweiten Region | 3 Fehlschläge in Folge → Bereitschaft |
| Readiness (DB) | `GET /api/health/ready` alle 60 s | `503` über 3 min → Bereitschaft |
| Antwortzeit | p95 `/api/health/ready` | > 500 ms über 10 min → Warnung |
| Geplante Abläufe | JSON-Zeile `scheduled_work.result` je Lauf | kein Lauf in 60 min oder Exit-Code ≠ 0 → Warnung |
| Benachrichtigungen | Back Office: `DEAD`/`UNCERTAIN` > 0 | täglich prüfen; > 0 seit 24 h → Warnung |
| Sicherungen | Erfolg des täglichen `pg_dump` | fehlend → Bereitschaft |
| TLS-Zertifikat | Restlaufzeit | < 14 Tage → Warnung |
| Speicher/Datenträger | Host-Metriken | > 85 % → Warnung |

Logs enthalten keine personenbezogenen Daten (Zähler, Korrelations-IDs). Alarmziele
(E-Mail/Telefon des Betreibers) werden erst mit dem Anbieter festgelegt.

## 7. Last- und Stabilitätstest (lokal, isoliert)

Skript: `pnpm run test:load -- --base http://127.0.0.1:<port> --concurrency 20 --seconds 20
--paths /api/health,/` (verweigert Nicht-Loopback-Ziele ohne `LOAD_TEST_ALLOW_REMOTE=1`).

**Messung am 2026-10-25** – Produktions-Build (`next start`), lokale PostgreSQL 16, Sandbox
mit 4 vCPU, Testdatenbank. Aussagekraft: Größenordnung, **kein** Ersatz für einen Test in der
Zielumgebung.

| Pfad | Parallel | Anfragen | Fehler | Anfragen/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/health` | 20 | 22 430 | 0 | 1 121 | 14.8 | 31.7 | 47.3 |
| `/api/health/ready` | 20 | 18 935 | 0 | 946 | 19.3 | 32.7 | 43.9 |
| `/` | 20 | 2 020 | 0 | 101 | 188 | 273 | 371 |
| `/leistungen` | 20 | 2 645 | 0 | 132 | 148 | 195 | 245 |
| `/auth/login` | 20 | 3 065 | 0 | 153 | 127 | 179 | 217 |
| `/api/health/ready` (60 s) | 10 | 54 271 | 0 | 904 | 9.7 | 19.2 | 26.5 |

Stabilität: Speicher des Server-Prozesses nach allen Läufen ~0,7 GB RSS ohne Anstieg im
Dauerlauf. Datenbank gestoppt → `/api/health` 200, `/api/health/ready` 503; nach Neustart
der Datenbank sofort wieder 200 ohne Neustart der Anwendung. Parallele/wiederholte
Terminerzeugung und Erinnerungen sind über Integrationstests (Konkurrenz, Advisory-Lock)
abgedeckt.
