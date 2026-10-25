# Launch Readiness – ISELA CLEAN (Stand 2026-10-25, Phase 3)

**Entscheidung: KEINE Produktionsfreigabe.** Die Software ist für einen kontrollierten
Testbetrieb technisch weit; Betreiber-, Zahlungs- und Rechtsvoraussetzungen fehlen (§4).

Geprüft: `main` @ `d8266ed` (PR #24 gemergt) plus offene PRs #25 (Rechnungs-Snapshot)
und #26 (Kundenansicht Verträge), beide CI-grün bzw. lokal grün, **nicht gemergt** (Freigabe offen).

Legende Prüfstatus: PASS · FAIL · BLOCKED (Voraussetzung/Freigabe fehlt) · UNKNOWN.
Reifegrad: **T** technisch umgesetzt · **V** in Testumgebung verifiziert · **K** für
Produktion konfiguriert · **F** für Produktion freigegeben.

## 1. Technische Prüfungen

| Prüfung | Status | Reife | Nachweis |
| --- | --- | --- | --- |
| Typecheck, Lint, Build, Web-Build | PASS | T V | lokal + CI je Push |
| Unit / Integration / E2E | PASS | T V | 941 / 279 (#25) bzw. 277 (#26) / 29 |
| Migrationen 0000–0012, Drift, Upgrade mit Daten | PASS | T V | `db:check`; Upgrade-Test 0012 |
| Modulgrenzen, Hardcoding, Audit, Lizenzen, Secret-Scan | PASS | T V | Skripte, gitleaks |
| CodeQL, Dependency Review | PASS | T V | CI auf `main` und PRs |
| Health-/Readiness-Endpunkte | PASS | T V | Unit + E2E; DB-Ausfall → 503, Erholung ohne Neustart |
| Geplante Abläufe (Runner) | PASS | T V | Integrationstests, lokaler Lauf; Cron offen |
| Backup/Wiederherstellung (Verfahren) | PASS | T V | `OPERATIONS.md` §4 |
| Backup in Zielumgebung, PITR | BLOCKED | – | Hosting offen |
| Monitoring, Alarmierung | BLOCKED | T | Regeln `OPERATIONS.md` §6; Anbieter offen |
| Last-/Stabilitätstest | PASS (lokal) | T V | `OPERATIONS.md` §7; Zielumgebung offen |

## 2. Fachliche Prüfung

| Bereich | Status | Reife | Anmerkung |
| --- | --- | --- | --- |
| Registrierung, Anmeldung, Rollen, MFA für Admins | PASS | T V | E2E, RBAC-Tests |
| Kunden, Leads, Angebote, Buchungen, Einsätze | PASS | T V | Integration/E2E |
| Kundenportal: Buchungen, Rechnungen, Angebote | PASS | T V | IDOR-Tests |
| Kundenportal: eigene wiederkehrende Aufträge | PASS | T V | PR #26 (offen) |
| Vorkasse Auftrag 1–2; Kredit ≥ 3 erledigt + bezahlt + Freigabe | PASS | T V | Payment-Risk-, Billing-Tests |
| Überfällige Rechnung → künftige Aufträge Vorkasse | PASS | T V | Guard-Tests |
| Kein Auftrag ohne bestätigte Vorkasse/Kredit | PASS | T V | DB-Check + Job-Start-Guard |
| Kundenhistorie nicht durch neue Konten rücksetzbar | PASS | T V | Identitätstests |
| Wiederkehrende Aufträge, Pausen, Status, Back Office | PASS | T V | Integration + E2E |
| Feiertage nur aus freigegebenen Daten | PASS / BLOCKED | T V | Mechanik geprüft; amtliche Daten fehlen |
| Keine Doppel-Aufträge/-Benachrichtigungen | PASS | T V | Konkurrenztests, Advisory-Lock |
| Audit für Verträge, Zahlungen, Benachrichtigungen | PASS | T V | Audit-Assertions in Tests |
| Erinnerungen (Testsenke), manuelle Prüfung | PASS | T V | Produktion versendet nicht |
| Rechnung: Leistungsdatum, Empfänger, Aussteller eingefroren | PASS | T V | PR #25 (offen); Steuernummer/USt-IdNr. Pflicht |
| Stornorechnung/Gutschrift als Beleg | BLOCKED | – | Form mit Steuerberatung klären |
| Bewertungsanfragen | BLOCKED | – | Rechtsgrundlage/Kanal offen; nicht implementiert |
| Rechtstexte, Firmendaten | BLOCKED | T | Entwürfe; echte Daten fehlen |
| Online-Zahlung | BLOCKED | – | Anbieter offen (ADR-010) |

Kein Bereich ist **K** oder **F**: Es gibt keine Produktionsumgebung.

## 3. Offene PRs und Entscheidungen

- PR #25 Rechnungs-Snapshot (Migration 0012) – Merge-Freigabe erforderlich.
- PR #26 Kundenansicht Verträge – Merge-Freigabe erforderlich.
- Dependabot-PRs #13–#23 – einzeln prüfen und freigeben.

## 4. Checkliste externe Voraussetzungen (Betreiber)

| # | Voraussetzung | Verantwortlich | Ergebnis/Nachweis |
| --- | --- | --- | --- |
| 1 | EU-Hosting, Domain, TLS | Owner | Anbieter, Region, DNS; `APP_BASE_URL` |
| 2 | Backups in Zielumgebung | Owner/Hoster | täglicher Dump, Aufbewahrung, Verschlüsselung, Restore-Test protokolliert |
| 3 | Monitoring | Owner | Dienst angebunden an Regeln `OPERATIONS.md` §6, Alarmziel |
| 4 | E-Mail-Versanddienst | Owner | AV-Vertrag, SPF/DKIM/DMARC, SMTP-Zugang; erst dann Versand in Produktion |
| 5 | Zahlungsanbieter, Buchhaltung | Owner/Steuerberatung | Anbieter (ADR-010), Abgleich, Werte der Zahlungsrichtlinie bestätigt |
| 6 | Firmendaten, Rechtstexte | Owner/Rechtsberatung | Impressum, Datenschutz, AGB geprüft; `BUSINESS_*` inkl. Steuernummer/USt-IdNr. |
| 7 | Amtliche Feiertagsdaten | Owner | Region gesetzt; je Jahr aus amtlicher Quelle (NRW) erfasst und freigegeben |
| 8 | Scheduler, Dienstkonto | Owner/Hoster | Cron für `jobs:run` (z. B. 15 min); Konto `JOBS_ACTOR_USER_ID` mit DISPATCHER |
| 9 | Korrekturbelege | Steuerberatung | Form Stornorechnung/Gutschrift festgelegt, danach Umsetzung |
| 10 | Bewertungsanfragen | Owner/Rechtsberatung | Kanal, Zeitpunkt, Einwilligung/Rechtsgrundlage; danach Umsetzung |

## 5. Bekannte Lücken und Risiken

- Korrekturbelege werden bewusst nicht erzeugt (`voidInvoice` dokumentiert das).
- Last-Test nur lokal (4 vCPU); Zielumgebung muss erneut gemessen werden.
- Ruleset erlaubt noch Squash/Rebase (Session darf Einstellungen nicht ändern).
- F4 (`pg@9`-Vorbereitung) offen, niedrig.
