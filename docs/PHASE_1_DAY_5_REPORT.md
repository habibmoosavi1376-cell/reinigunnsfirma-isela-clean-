# ISELA CLEAN – Phase 1 / Tag 5: Services, Pricing Engine, Buchung, Einsätze, Zuweisung

Stand: 2026-09-29 · Repository: `habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` ·
Branch: `phase-1-day-5` (von `phase-1-day-4` @ `b798531`) · PR gegen `main` (gestapelt auf #5)

## 1. Ausgangszustand

| Prüfpunkt | Befund |
| --- | --- |
| Branch / HEAD | `phase-1-day-5`, erstellt von `phase-1-day-4` @ `b798531`; Working Tree sauber |
| `main` | `29d82a9`, unverändert (auch nach Tag 5) |
| PR #1 – #5 | alle offen, nicht gemergt, nicht bearbeitet; PR #1 inhaltlich unangetastet |
| CI auf PR #5 | alles grün außer „Dependency review“ (Dependency Graph deaktiviert, Owner-Einstellung) |
| Migrationen | 6 (`0000`–`0005`), kein Drift |
| Tests (Baseline, am Commit `b798531` neu gemessen) | 594 Unit, 166 Integration, 13 E2E – alle grün |
| Schema | 39 Tabellen; Katalog ohne Dauer-/Preis-/Qualifikationsmodell; keine Buchungen, Einsätze, Mitarbeitenden; Partner ohne Verifikation |
| `TAX_MODE` | **existiert nicht** im Code. Die bestehende Steuerlogik ist `quote.defaults` (zulässige USt-Sätze, Standardsatz). Tag 5 nutzt genau diese Logik; siehe §6 und §13 |

Stack: PR #1 → #2 → #3 → #4 → #5 → dieser PR. Keine Änderung an `main`, keine
History-Rewrites, kein Merge.

## 2. Änderungen

| Commit | Inhalt |
| --- | --- |
| `f00bc31` | Domäne: Migration `0006`, `@isela/pricing`, `@isela/operations`, Partner-/Katalogverwaltung, Angebots-Pricing, RBAC, Logger-Port |
| `b3ce6a4` | Unit- und Integrationstests (inkl. Security/Concurrency); Fix B1 |
| `6fff32a` | Web: Admin-Module, Kundenportal, Team-Bereich |
| `1fa113f` | E2E; Fix B2 |
| (dieser Commit) | Dokumentation |

Neue Pakete: `@isela/pricing` (Engine + Regelwerke) und `@isela/operations` (Buchung,
Zahlungsstatus, Einsätze, Mitarbeitende, Zuweisung). Neue Abhängigkeiten (Allowlist erweitert,
kein Zyklus): `quotes → pricing, catalog`, `settings → operations`, `partners → audit`,
`operations → audit, auth, catalog, database, payment-risk, shared, validation`.
Booking und Jobs liegen bewusst in **einem** Modul, weil sich ihre Zustände gegenseitig
fortschreiben (bezahlt → eingeplant, erledigt → abgeschlossen); zwei Pakete hätten einen
Abhängigkeitszyklus erzeugt.

## 3. Services (Katalog)

- **Datenmodell `service`** (additiv): `key` (Slug), Name, Kategorie, Beschreibung, aktiv,
  Sortierung, Mindestmenge, Einheit (`HOUR`, `SQUARE_METER`, `FLAT`, `UNIT`), Dauermodell
  (`MANUAL`, `FIXED`, `PER_UNIT` mit Rüstzeit und Sekunden je Einheit – ganzzahlig),
  Preisstrategie (`MANUAL_QUOTE`, `RULE_BASED`), erforderliche Qualifikationen,
  unterstützte Objektarten (leer = alle). **Keine Preise im Katalog oder in UI-Dateien.**
- **Extras:** `service_option` (Schlüssel je Leistung, aktiv, Sortierung); Preise nur in
  Preisregeln.
- **Verfügbarkeit:** aktiv/inaktiv je Kategorie, Leistung und Extra; regionale Verfügbarkeit
  über Servicegebiete (PostGIS) und regionale Preisregelwerke. Eine eigene Tabelle
  „Leistung je Gebiet“ wurde bewusst nicht eingeführt (keine Übermodellierung).
- **Initiale Kategorien:** Die Seeds enthalten jetzt alle zwölf geforderten Kategorien
  (neu: Ferienwohnungsreinigung, Gewerbliche Reinigung; „Hausverwaltung / Objektbetreuung“
  als Anzeigename). Seeds überschreiben keine bestehenden Namen. Es werden **keine
  Leistungen** geseedet – Leistungen legt der Inhaber an (keine Fake-Daten).
- **`/admin/services`** (`catalog:manage`): Kategorien, Leistungen, Extras anlegen,
  (de)aktivieren; alle Änderungen auditiert.

## 4. Pricing

- **Modul `@isela/pricing`**, reine Funktion `calculatePrice(rules, input, context)`, ohne
  Next.js-, DB- oder Uhr-Abhängigkeit.
- **Arithmetik:** Cent als BigInt, kaufmännische Rundung, Zu-/Abschläge in Basispunkten,
  Mengen als skalierte Ganzzahlen (Milli-Einheiten, Zenti-m²). Keine Float-Geldarithmetik.
- **Eingaben:** Leistung/Einheit, Menge, Fläche, Räume, Bäder, Fenster, Häufigkeit, Extras,
  Dringlichkeit, Entfernung, Wochentag/Uhrzeit, Dauermodell, Arbeitszeitschätzung,
  Direktkosten, Partnerkosten. Region (Servicegebiet) und Entfernung ermittelt der Server
  aus vertrauenswürdigen Koordinaten; Fläche/Räume/Bäder aus dem Objekt des Angebots.
- **Ausgaben:** `net`, `tax`, `gross`, `estimatedLaborMinutes`, `directCosts`,
  `internalCost`, `contributionMargin`, `currency`, `pricingVersion` (z. B. `v1+r3`),
  Komponenten, angewandte Anpassungen, Hinweise, `requiresReview: true`.
- **Preisregeln (§4):** versioniertes Regeldokument je Geltungsbereich (Standard oder
  Servicegebiet): Grundpreis, je Einheit, je m², je Raum, je Bad, je Fenster, Extras,
  Häufigkeit, Dringlichkeit, Entfernung (inkl. Freikilometer), Zeitzuschläge, Rabatte
  (nur explizit gewählt), optionaler Mindestpreis, interner Stundensatz.
- **`CONFIG_REQUIRED`:** Jeder Geschäftswert kann `"CONFIG_REQUIRED"` sein; die leere
  Vorlage setzt alle Werte darauf. Benötigt eine Berechnung einen solchen Wert (oder fehlt
  eine Eingabe, die eine Regel braucht), liefert die Engine **keinen Preis**, sondern
  `CONFIG_REQUIRED` mit den fehlenden Schlüsseln. **Es wurden keine Preise oder
  Mindestpreise erfunden.**
- **Nie 0 EUR:** Ein Ergebnis ≤ 0 ist `CONFIG_REQUIRED` (`result.nonPositivePrice`);
  Übersteuerungen verlangen > 0; Angebote können mit 0 EUR weder geprüft, freigegeben noch
  angenommen werden (State Machine **und** DB-CHECK `quote_released_amount_chk`).
- **Versionierung:** Regelwerk `DRAFT → ACTIVE → RETIRED`; eine aktive Version ist per
  DB-Trigger unveränderlich und nicht löschbar. Jede Berechnung wird append-only in
  `pricing_calculation` gespeichert; die Angebotsposition referenziert sie und kopiert
  `pricing_version`. Test: Aktivierung einer neuen Version ändert bestehende Angebote nicht.
- **Rechte:** Entwürfe `pricing:manage` (SUPER_ADMIN, ADMIN, FINANCE), Aktivierung
  `pricing:approve` (SUPER_ADMIN, ADMIN), Übersteuerung `pricing:override`
  (SUPER_ADMIN, ADMIN, mit Begründung, Audit `pricing.override`).
- **Pricing Safety (§5):** Alle Eingaben `z.strictObject` – gefälschte Felder wie `netCents`,
  `taxRateBasisPoints`, `contributionMarginCents`, `customerId` → `VALIDATION_FAILED`.
  Kosteneingaben (Arbeitszeit, Direkt-, Partnerkosten) nur mit `finance:internal_read`;
  Dispositionsrollen erhalten Ergebnisse ohne interne Kosten/Marge. Eine Berechnung kann nur
  für das eigene Angebot und nur einmal übernommen werden.
- **UI:** `/admin/pricing` (Versionen, offene Werte, JSON-Entwurf, Aktivierung) und im
  Angebot „Preis berechnen“ → Prüfseite → „Als Position übernehmen“.

## 5. Tax

- `TAX_MODE` existiert nicht. Verwendet wird die bestehende Steuerlogik: zulässige Sätze und
  Standardsatz aus `quote.defaults`; der Server übergibt den Satz an die Engine, die Summen
  je Satz berechnet `calculateTotals` wie bisher.
- Netto, Steuersatz, Steuerbetrag und Brutto sind in Berechnung, Angebot, Buchung und
  Positionen getrennt gespeichert. Keine Steuerwerte im Frontend.
- B2B/B2C-Erweiterbarkeit (z. B. Reverse Charge, Kleinunternehmerregelung) ist offen und
  braucht eine fachliche/steuerliche Entscheidung (§14).

## 6. Quote → Booking

- Quote-Fluss unverändert `DRAFT → PENDING_REVIEW → SENT → ACCEPTED` (Annahme wird von
  berechtigten Mitarbeitenden mit Nachweis erfasst; Online-Annahme durch Kunden bleibt offen).
- `createBookingFromQuote` (nur `booking:write`): nur `ACCEPTED`; `DECLINED`, `EXPIRED`,
  `CANCELLED` und noch nicht angenommene Angebote → `POLICY_VIOLATION` (getestet).
- Kunde, Objekt, Adresse, Positionen und Beträge kopiert der Server aus dem Angebot; der
  Browser wählt nur Angebot, Zeitfenster und Dauer. Gesperrte Kunden → abgelehnt.
- Einmal je Angebot: `SELECT … FOR UPDATE` auf das Angebot + partieller Unique-Index
  `booking_quote_uq` (parallel getestet: genau eine Buchung).
- Statuswechsel nur über die State Machine, append-only in `booking_status_transition`
  (inkl. Anlage `NULL → REQUESTED`), zusätzlich Audit `booking.status_changed`.

## 7. Booking-Modell

- `booking`: Kunde, Objekt, Adresse, Angebot, Quelle (`QUOTE`), Status, Wunschdatum
  (Geschäftszeitzone), Zeitfenster, Dauer, Währung, Netto/Steuer/Brutto (> 0),
  Zahlungsbedingung, Zahlungsstatus, Entscheidungs-Snapshot (Bedingung, Gründe,
  Richtlinienversion), operative Hinweise, Stornogrund, `version`.
- `booking_item`: append-only Snapshot der Angebotspositionen.
- Status: `REQUESTED`, `PENDING_PAYMENT`, `CONFIRMED`, `SCHEDULED`, `CANCELLED`, `COMPLETED`.
  Übergänge mit Guards (Zahlung, zugewiesener/erledigter Einsatz, Stornogrund, kein Storno
  nach Einsatzbeginn).
- DB-Guards: Besitz-Trigger `booking_owner` (Objekt/Adresse/Angebot desselben Kunden,
  Adresse = Objektadresse), `booking_prepayment_guard_chk` (Vorkasse-Buchung nur mit
  bestätigter Zahlung bestätigt/eingeplant/erledigt).
- **Kapazität/Verfügbarkeit:** Arbeitsfenster je Wochentag, Abwesenheiten, Servicegebiete,
  Qualifikationen, Tageskapazität (Mitarbeitende), gleichzeitige Kapazität (Partner),
  zugewiesene Einsätze.
- **Doppelbuchung:** Exclusion-Constraint `job_assignment_employee_no_overlap_excl`
  (GiST, `tstzrange`) + Advisory-Lock je Ressource; parallel getestet (eine Zuweisung
  gewinnt, direkter SQL-Insert → `23P01`).

## 8. Booking → Job

- `createJobForBooking` (`job:write`) für `PENDING_PAYMENT`/`CONFIRMED`; ein Einsatz je
  Buchung (`job_booking_uq`, parallel getestet). Serverseitig abgeleitet: Termin
  (Fensterbeginn + Dauer), Servicegebiet (PostGIS, sonst leer), Qualifikationen
  (Snapshot aus den Leistungen).
- Lebenszyklus `PLANNED → ASSIGNMENT_PENDING → ASSIGNED → IN_PROGRESS → COMPLETED →
  QUALITY_CHECK → CLOSED` (+ `CANCELLED` nur über den Buchungsstorno). Keine Sprünge;
  `ASSIGNED` nur mit aktiver Zuweisung; append-only `job_status_transition`.
- Synchronisation über die Booking-State-Machine: Zuweisung bei bestätigter Buchung →
  `SCHEDULED`; Aufhebung → `CONFIRMED`; Einsatz erledigt → Buchung `COMPLETED`.
- **Job-Detail** `/admin/jobs/[id]`: Kunde, Objekt, Leistung, Adresse, Termin, Dauer,
  Mitarbeitende/Partner, Buchung, Angebot, Zahlungsstatus, operative Hinweise, Verlauf,
  Zuweisungshistorie; interne Kosten/Deckungsbeitrag nur mit `finance:internal_read`, Audit
  nur mit `audit:read`.

## 9. Employee

- `employee` (Anzeigename, aktiv, Qualifikationsschlüssel, optionaler Startpunkt,
  Tageskapazität, optional verknüpftes STAFF-Konto), `employee_service_area`,
  `employee_working_window` (Wochentag + Minuten, Geschäftszeitzone),
  `employee_unavailability` (nur neutrale Arten `ABSENCE`, `TRAINING`, `OTHER` –
  **keine Gesundheitsdaten**, kein Grund-Freitext).
- `/admin/employees` (Lesen: `employee:read` – SUPER_ADMIN, ADMIN, DISPATCHER; Pflege:
  `employee:manage` – SUPER_ADMIN, ADMIN).
- STAFF sieht unter `/team/jobs` nur eigene aktiv zugewiesene Einsätze (ohne Preise,
  Kundenkontakte) und kann nur beginnen/abschließen.

## 10. Partner

- `partner` erweitert um `verified_at`/`verified_by_user_id`, `max_concurrent_jobs`;
  `partner_service` (angebotene Leistungen), `partner_document` (Art, Status, kurze Referenz,
  gültig bis – nur Metadaten, keine Dateien).
- Aktivierung nur durch eine Person nach Prüfung aller konfigurierten Pflichtnachweise
  (Standard: Gewerbenachweis, Betriebshaftpflicht – aus PRODUCT_SPEC §7), DB-CHECK
  `partner_active_verified_chk`.
- `/admin/partners` (`partner:read` / `partner:manage`); Partner-Nutzer sehen nur den
  eigenen Partner (OWN), unter `/team/jobs` nur eigene Einsätze.
- **Owner-Regel:** `operations.assignment.partnerAssignmentEnabled = false` (Standard).
  Partner werden angezeigt, aber nicht zugewiesen, bis der Inhaber dies freigibt
  (Provisions-/Vertragsmodell und rechtliche Prüfung offen).

## 11. Assignment

- `listAssignmentCandidates` liefert `AssignmentCandidate`: Mitarbeitende/r bzw. Partner,
  Entfernung, `qualificationMatch`, `availability`, `serviceMatch`, `serviceAreaMatch`,
  Kapazität, `eligible`, `blockers`, `score`, `factors`.
- **Harte Regeln** (Ausschlussgründe, alle getestet): inaktiv, nicht verifiziert,
  Partnerzuweisung nicht freigegeben, Qualifikation fehlt, Leistung nicht angeboten,
  Position ohne Katalogleistung (Partner), Servicegebiet unbekannt, außerhalb Gebiet,
  außerhalb Arbeitszeit, abwesend, Terminüberschneidung, Kapazität erschöpft/nicht
  konfiguriert, Nachweise fehlen/abgelaufen.
- **Score (§13):** gewichteter Durchschnitt der Faktoren Entfernung, Qualifikation,
  Verfügbarkeit, Service-Match, Kapazität, Zuverlässigkeit; Gewichte konfigurierbar
  (`operations.assignment`, Summe 100, Standard 30/20/20/10/10/10 – zu bestätigen).
  Faktoren ohne Daten (Zuverlässigkeit: noch keine Qualitätsdaten) zählen als „keine Daten“
  und nicht mit. Jeder Faktor, jedes Gewicht und jeder Beitrag wird angezeigt und mit der
  Zuweisung gespeichert. Keine KI-Entscheidung, keine automatische Zuweisung.
- **Serverseitig:** `assignJob` bewertet genau den gewählten Kandidaten erneut in der
  Transaktion (Advisory-Lock); gefälschte IDs → `NOT_FOUND`, ungeeignete → `POLICY_VIOLATION`.
  Neuzuweisung/Aufhebung mit Pflichtgrund, atomar, auditiert (`job.assigned`,
  `employee.assigned`, `partner.assigned`, `job.reassigned`, `job.assignment_released`).
  Zuweisungen sind nur freigebbar, nicht änderbar/löschbar (Trigger).

## 12. Payment Guards

- **Payment-Risk nicht verwässert:** `evaluatePaymentTerms` unverändert; Kreditbedingung
  (`CREDIT_TERMS_APPROVED`) nur bei expliziter `INVOICE`-Entscheidung. Da Aufträge/Rechnungen
  noch nicht in die Historie einfließen und `requireManualApproval` gilt, ist das Ergebnis
  derzeit immer `VORKASSE_REQUIRED` → Buchung `PENDING_PAYMENT`.
- **Zahlungsstatus (§15):** `PAYMENT_REQUIRED → PAYMENT_PENDING → PAYMENT_CONFIRMED |
  PAYMENT_FAILED`, `PAYMENT_FAILED → PAYMENT_PENDING`, `PAYMENT_CONFIRMED → REFUND_PENDING →
  REFUNDED | PAYMENT_CONFIRMED`. Nur `payment:manage` (SUPER_ADMIN, ADMIN, FINANCE; MFA),
  Bestätigung/Fehlschlag/Erstattung nur mit Referenz; Erstattung nur nach Storno/Erledigung.
  **Kein Zahlungsanbieter, keine automatischen oder simulierten Erfolge.**
- **Ausführungssperre:** `IN_PROGRESS` nur bei bestätigter/eingeplanter Buchung und
  bestätigter Vorkasse (oder expliziter Kreditbedingung) – in der State Machine **und** per
  Trigger `job_payment_guard` (direktes SQL → `23514`, getestet). Blockaden werden als
  `payment_guard.blocked` geloggt.

## 13. Security

- **RBAC (§19):** neue Rechte `pricing:*`, `finance:internal_read`, `booking:read|write`,
  `payment:manage`, `job:read|write|assign|execute_own`, `employee:read|manage`,
  `partner:manage`. SUPER_ADMIN alles; ADMIN alles außer Zahlungsrichtlinie; DISPATCHER
  Buchungen/Einsätze/Zuweisung, keine Zahlungen, Kosten, Preisübersteuerung; FINANCE
  Angebote lesen, Preisregel-Entwürfe, interne Kosten, Zahlungen, Einsätze lesen;
  STAFF/PARTNER nur eigene Einsätze; CUSTOMER nur eigene Buchungen (OWN).
- **Objektbesitz:** Kunde nur eigene Buchungen (fremde IDs → 404), Worker nur aktiv
  zugewiesene Einsätze (fremde → 404), Partner nur eigener Partner (fremd → 403); Staff-Sichten
  verlangen GLOBAL-Rechte. Kundenansicht enthält strukturell keine Mitarbeitenden, Partner,
  Notizen, Kosten oder Margen.
- **Security-Tests (§20) – alle vorhanden:** Booking-, Job-, Employee-, Partner-, Quote-IDOR;
  gefälschte `customerId`, `propertyId`, Mitarbeitenden-/Partner-ID, Preis, Marge,
  Zahlungsstatus; verbotene Übergänge; Doppelbuchungs-Race; unberechtigte Zuweisung;
  unverifizierter Partner; Kundenzugriff auf interne Daten.
- **Concurrency (§21):** gleiche Ressource/gleicher Zeitraum (Exclusion + Advisory-Lock),
  gleicher Kunde (zwei parallele Buchungen konsistent), gleiches Angebot (Unique-Index +
  Row-Lock), gleiche Buchung → Job (Unique), parallele Regelwerk-Aktivierung (Advisory-Lock +
  partieller Unique-Index). Globale Sperrreihenfolge Buchung → Einsatz gegen Deadlocks.
- **Audit (§22):** `pricing.calculated`, `pricing.override`, `pricing.rule_set_*`,
  `quote.status_changed`, `booking.created`, `booking.status_changed`, `booking.cancelled`,
  `job.created`, `job.status_changed`, `job.assigned`, `job.reassigned`,
  `job.assignment_released`, `employee.*`, `partner.*`, `payment.status_changed`,
  `catalog.*`. Ohne Adressen/Kontaktdaten; Zahlungsreferenzen nur in der Zahlungshistorie.
- **Observability (§26):** Port `DomainLogger` (nur primitive Felder); Ereignisse
  `booking.created`, `job.created`, `job.assigned`, `assignment.failed` (mit Blockern),
  `payment_guard.blocked`, `payment.status_changed`; JSON-Logger in der Web-App. Tests prüfen
  die Abwesenheit von Adressen/E-Mails.

## 14. Tests

| Suite | Baseline Tag 4 | Tag 5 | Neu |
| --- | --- | --- | --- |
| Unit | 594 | **757** | +163 (Pricing/Geld/Steuer/Versionen, State Machines, Zahlungsanforderung, Scoring, Zeit, RBAC-Matrix, Navigation, Routing) |
| Integration | 166 | **203** | +37 (`bookings`, `assignment`, `pricing`) |
| E2E | 13 | **14** | +1 (Service → Angebot → Annahme → Buchung → Einsatz → Zuweisung → Zahlung → Kundenansicht → 403/404) |

- Keine Tests gelöscht, übersprungen oder deaktiviert.
- Angepasst (Erweiterungen, keine Abschwächung): Partner-Fixtures in sechs Integrationstests
  um Verifikation ergänzt (neue Invariante „ACTIVE nur verifiziert“); Quote-Unit-Kontext um
  Pflichtfeld `grossCents`; Settings-Registry-Snapshot um `operations.assignment`;
  Navigations-Test um aktive Tag-5-Module; E2E-Registrierungshelfer wartet bei 429 das vom
  Server genannte Fenster ab (Rate-Limit unverändert).
- E2E nutzt für ADMIN echtes TOTP über die Better-Auth-Endpunkte (kein MFA-Flag per SQL).

## 15. Migration

- `0006_day5_services_bookings_jobs.sql` (drizzle-kit generiert, SQL geprüft,
  hand-ergänzt): nur `CREATE TYPE`, `CREATE TABLE`, `ADD COLUMN` (mit Defaults),
  `ADD CONSTRAINT`, `CREATE INDEX`, Trigger/Funktionen, Exclusion-Constraint.
  **Kein `DROP`, keine Enum-Neuerstellung.**
- Checks auf Bestandstabellen, die Altzeilen verletzen könnten, sind `NOT VALID`
  (`service_key_chk`, `partner_active_verified_chk`, `quote_released_amount_chk`): neue und
  geänderte Zeilen werden geprüft, die Migration bricht bei Altdaten nicht ab.
- **Upgrade-Test** (DB auf Stand `0005` mit Altdaten: Leistung mit ungültigem Schlüssel,
  unverifizierter ACTIVE-Partner, freigegebenes 0-EUR-Angebot, Position) → `0006` läuft
  durch, Altzeilen unverändert, neue verletzende Zeilen werden abgelehnt, das Alt-Angebot
  kann storniert, aber nicht angenommen werden.
- Drift: `db:check` grün. Indizes mit Begründung (§25): `booking_customer_window_idx`
  (Kundenportal/Akte), `booking_status_window_idx` (Liste nach Status/Datum),
  `booking_quote_uq` (Race-Schutz), `job_status_start_idx` (Disposition), `job_booking_uq`,
  `job_assignment_active_job_uq`, `job_assignment_partner_active_idx` (Kapazität/eigene
  Einsätze), GiST-Exclusion (Mitarbeitenden-Zuweisungen), Fremdschlüssel-Indizes der
  Transitions-/Dokument-/Fenster-Tabellen. Kunde/Objekt/Angebotsstatus waren bereits indiziert.
- Datenbank: 55 Tabellen (+16), 7 Migrationen.

## 16. Bugs (gefunden und behoben)

| ID | Befund | Behebung |
| --- | --- | --- |
| B1 | STAFF ohne verknüpften Mitarbeitenden erhielt für eine konkrete Einsatz-ID eine leere Liste statt `NOT_FOUND` (kein Datenleck, aber uneinheitlich) | einheitlich `NOT_FOUND` (Test) |
| B2 | Mengenfeld der Engine-Berechnung hätte den bestehenden E2E-Selektor „Menge“ mehrdeutig gemacht | Label präzisiert |

Keine Befunde in bestehender Funktionalität; alle Bestandstests grün.

## 17. Risiken

| Risiko | Einordnung |
| --- | --- |
| Alle Preiswerte offen (`CONFIG_REQUIRED`) | gewollt; Engine liefert erst nach Owner-Freigabe Preise, bis dahin manuelle Preise |
| Standardgewichte Score, Entfernungsreferenz 30 km, max. Zeitfenster 12 h | Konfiguration, vom Inhaber zu bestätigen |
| Entfernung = Luftlinie vom Gebietszentrum (nur CIRCLE) | Näherung; Routing nicht im MVP |
| Zahlungsbestätigung manuell durch FINANCE | bewusst bis zum Zahlungsanbieter (Tag 6); Referenz Pflicht, auditiert |
| Storno mit bestätigter Zahlung | keine automatische Erstattung; Stornobedingungen fachlich offen |
| `NOT VALID`-Constraints | nach Datenprüfung per `VALIDATE CONSTRAINT` scharf schalten |
| Öffentliches Repository | Standard-Scoring-Gewichte und Regelstruktur sichtbar (keine Preise) |

## 18. Rollback

- Code: Revert der Tag-5-Commits; Tag-4-Funktionalität bleibt unberührt (Bestandstests grün).
- Datenbank: Migration `0006` ist additiv. Ohne Produktionsdaten in den neuen Tabellen kann
  manuell zurückgebaut werden: Trigger/Funktionen (`isela_price_rule_set_guard`,
  `isela_booking_owner_check`, `isela_job_assignment_guard`, `isela_job_payment_guard`) und
  die 16 neuen Tabellen entfernen, die neuen Spalten an `service`, `partner`, `quote_item`
  und die neuen Constraints entfernen, danach die neuen Enum-Typen. Mit Produktionsdaten
  gilt Forward-Fix.

## 19. Offene Punkte (Owner/Fachlich)

1. Preiswerte, Mindestpreise, Zu-/Abschläge, Rabatte, interner Stundensatz (`CONFIG_REQUIRED`).
2. Steuerliche Modi (Reverse Charge, Kleinunternehmer, B2B/B2C) – `TAX_MODE` nicht vorhanden.
3. Freigabe der Partnerzuweisung, Provisionsmodell, rechtliche Prüfung des Partner-Modells,
   Pflichtnachweise bestätigen.
4. Score-Gewichte, Entfernungsreferenz, maximale Fensterlänge bestätigen.
5. Stornierungs-/Erstattungsbedingungen; Online-Annahme von Angeboten durch Kunden (AGB,
   Widerrufsrecht).
6. Zahlungsanbieter (Tag 6); Einbeziehung bezahlter Aufträge in die Zahlungshistorie
   (Voraussetzung für Kreditbedingungen).
7. Zuverlässigkeit als Score-Faktor (braucht Qualitätsdaten), Wiederkehrende Serien
   (derzeit ein Einsatz je Buchung).
8. Dependency Graph aktivieren (Owner-Einstellung), `NOT VALID`-Constraints validieren.

## 20. Final Gate

| Gate | Ergebnis |
| --- | --- |
| git status / diff | sauber; Diff geprüft (keine Secrets, keine `.env`, kein `DROP`) |
| Typecheck (Root + Web) | grün |
| Lint (ESLint strict + Prettier) | grün |
| Unit | 757/757 grün (Baseline 594) |
| Integration | 203/203 grün (Baseline 166) |
| E2E | 14/14 grün (Baseline 13) |
| Build (Produktion) + Client-Bundle-Scan | grün; keine Server-Secrets im Client |
| Migration: Drift / Upgrade-Test | grün / grün |
| Modulgrenzen, Hardcoding-Guard, Forbidden-Files | grün |
| `pnpm audit` / Lizenzen | 0 Schwachstellen / alle erlaubt |
| Secrets (gitleaks Historie) | keine Funde (Verzeichnisfunde nur im ignorierten `.next`-Build) |
| actionlint / markdownlint | grün |
| Baseline-Regression | keine Regression |
| CI | siehe PR (Nachtrag nach Lauf) |

## 21. Nächster Schritt

Review dieses Reports und der offenen Punkte durch den Inhaber, danach Freigabe für Tag 6
(Rechnungen, Zahlungen, Payment Risk). Kein eigenmächtiger Merge, kein Beginn von Tag 6.
