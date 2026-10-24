# Launch Readiness – ISELA CLEAN (Stand 2026-10-24, nach Back Office)

**Entscheidung: KEINE Produktionsfreigabe.** Die Software ist für einen kontrollierten
Testbetrieb technisch weit, aber Betreiber-, Zahlungs- und Rechtsvoraussetzungen fehlen (§3).
Geprüft: `main` @ `2cb16fe` (PR #21 gemergt) plus Branch `phase-1-backoffice` (PR siehe
Status). Legende: PASS · FAIL · BLOCKED (Voraussetzung/Freigabe fehlt) · UNKNOWN.

## 1. Technische Prüfungen

| Prüfung | Status | Nachweis |
| --- | --- | --- |
| Typecheck, Lint, Build, Web-Build | PASS | lokal 2026-10-24; CI auf jedem Push |
| Unit / Integration / E2E | PASS | 941 / 276 / 29 lokal |
| Migrationen 0000–0011, Drift, Upgrade mit Daten | PASS | `db:check`; Upgrade-Test Tag 8 |
| Modulgrenzen, Hardcoding, Audit, Lizenzen, Secret-Scan | PASS | Skripte, gitleaks |
| CodeQL, Dependency Review | PASS | CI (#101/#47 auf `main`) |
| Health-/Readiness-Endpunkte | PASS | `/api/health`, `/api/health/ready`; Unit + E2E |
| Geplante Abläufe (Runner) | PASS (technisch) | `jobs:run`, Integrationstests, lokaler Lauf |
| Backup/Wiederherstellung (Verfahren) | PASS (lokal) | `OPERATIONS.md` §4, Prüfsummen identisch |
| Backup in Zielumgebung, PITR | BLOCKED | Hosting offen |
| Monitoring, Alarmierung | BLOCKED | Anbieter offen; Endpunkte vorhanden |
| Last-/Performance-Test | UNKNOWN | nicht durchgeführt |

## 2. Fachliche Prüfung

| Bereich | Status | Anmerkung |
| --- | --- | --- |
| Registrierung, Anmeldung, Rollen, MFA für Admins | PASS | E2E, RBAC-Tests |
| Kunden, Leads, Angebote, Buchungen, Einsätze | PASS | Integration/E2E |
| Vorkasse Auftrag 1–2; Kredit ≥ 3 bezahlte + Freigabe; Überfälligkeit → Vorkasse | PASS | Payment-Risk-, Billing-, Guard-Tests; Vertragsbuchungen nutzen dieselbe Logik |
| Kein Auftrag ohne bestätigte Vorkasse/Kredit | PASS | DB-Check + Job-Start-Guard |
| Kundenhistorie nicht durch neue Konten rücksetzbar | PASS | Identitätstests |
| Wiederkehrende Aufträge inkl. Back Office, Pausen, Status | PASS | Integration + E2E |
| Feiertage nur aus freigegebenen Daten | PASS (Mechanik) / BLOCKED (Daten) | keine Daten erfasst |
| Keine Doppel-Aufträge/-Benachrichtigungen | PASS | Konkurrenztests |
| Erinnerungen (Testmodus), manuelle Prüfung | PASS | Integration + E2E; Produktion versendet nicht |
| Bewertungsanfragen | BLOCKED | Rechtsgrundlage/Kanal offen; nicht implementiert |
| Rechnungen, Stornos, Erstattungen | PASS (Tag 6) | Stornorechnung/Gutschrift als Beleg: BLOCKED (Steuerberatung/Owner, siehe §4) |
| Rechtstexte, Firmendaten | BLOCKED | Entwürfe; echte Daten fehlen |

## 3. Vor dem ersten echten Kundenauftrag erforderlich (Betreiber)

1. Hosting (EU), Domain, TLS; Backup-Plan und Wiederherstellungstest dort; Monitoring an Health-Endpunkten.
2. E-Mail-Versanddienst freigeben (danach `dispatchEnabled` in Produktion).
3. Zahlungsweg/-anbieter (ADR-010) und Buchhaltung; Werte der Zahlungsrichtlinie bestätigen.
4. Rechtstexte prüfen lassen; echte Firmendaten (Impressum).
5. ADR-008: Ausführung `jobs:run` (Cron) oder Worker; Dienstkonto `JOBS_ACTOR_USER_ID` anlegen.
6. Feiertagsregion setzen und NRW-Feiertage je Jahr aus amtlicher Quelle freigeben.
7. Bewertungsanfragen: Kanal, Zeitpunkt, Rechtsgrundlage.
8. Form der Korrekturbelege (Stornorechnung/Gutschrift) mit Steuerberatung festlegen.

## 4. Bekannte Lücken und Risiken

- Korrekturbelege (Stornorechnung/Gutschrift) werden bewusst nicht erzeugt, bis die steuerliche Form entschieden ist (`voidInvoice` dokumentiert das).
- Ruleset erlaubt noch Squash/Rebase (Proxy der Session darf Einstellungen nicht ändern).
- F4 (`pg@9`-Vorbereitung) offen, niedrig.
- Kein Last-Test.
