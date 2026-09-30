# ISELA CLEAN – Phase 1 / Tag 6: Rechnungen, Zahlungen, Payment Risk, Finanzkontrollen

Branch `phase-1-day-6`, gestapelt auf `phase-1-day-5` @ `51d8110`. Basis aller PRs bleibt
`main` @ `29d82a9`. Nichts wurde gemergt, Tag 7 wurde nicht begonnen.

## 1. Ausgangszustand (§0/§1)

| Prüfung | Ergebnis |
| --- | --- |
| Git | Arbeitsbaum sauber, HEAD `51d8110d2353e52ce8ff01445ad6713f833c29d2` = `origin/phase-1-day-5` |
| PRs | #1–#6 offen, nicht gemergt, Basis `main` @ `29d82a9`; #6 Head `51d8110` |
| CI #6 | alle Gates grün außer „Dependency review“ (Owner-Einstellung „Dependency graph“, bekannt, nicht umgangen) |
| Datenbank | 55 Tabellen, 7 Migrationen; PostgreSQL 16 + PostGIS |
| Test-Baseline (gemessen) | 757 Unit, 203 Integration, 14 E2E – alle grün |

Weil #1–#6 nicht gemergt sind, baut Tag 6 auf dem bestehenden Stack auf (neuer Branch
`phase-1-day-6`, eigener PR gegen `main`, dokumentiert als gestapelt auf #6).

## 2. Financial Domain Audit (§2)

Vor der Implementierung vollständig gelesen: `payment-risk` (Engine, Policy), `quotes`
(Arithmetik, State Machine), `pricing` (Engine, Geld), `operations` (Buchung, Zahlungsstatus,
Einsätze, State Machines), Schema/Migrationen, Settings-Register, Audit.

| Frage | Befund |
| --- | --- |
| Was existierte? | Reine Funktion `evaluatePaymentTerms(history, policy)`; Buchung mit `payment_requirement`/`payment_status`; manueller Zahlungsstatus mit Referenztext; DB-Zahlungssperre für Einsatzbeginn; Cent-Arithmetik in `quotes`/`pricing` |
| Was fehlte für echte Rechnungen? | Rechnung, Positionen-Snapshot, Nummernkreis, Zahlung als Tatsache mit Betrag, Referenzen, Zuordnung, Teil-/Überzahlung, Fälligkeit/Überfälligkeit, Erstattung, Rückbuchung, Kreditfreigabe, Risiko-Protokoll, Provider-Abstraktion, Webhook-Sicherheit |
| Doppelte Finanzregeln | Rundung existiert in `quotes` (Steuer je Satz) und `pricing` (Engine). Rechnungen verwenden **ausschließlich** `calculateTotals` aus `quotes` – keine dritte Steuerlogik. Zahlungsbedingung: vorher zwei Aufrufer mit leerer Historie (`historyWithoutOrders`) in CRM und Buchung → jetzt **ein** Loader `evaluateCustomerPaymentTerms` für alle Aufrufer |
| Wo konnten Angebot/Buchung/Rechnung divergieren? | Rechnung aus Buchungspositionen; Summen werden neu berechnet und müssen Buchung **und** Angebot exakt entsprechen, sonst `CONFLICT` (`PRICE_DIVERGENCE`) – nie stillschweigend „korrigiert“. Buchungspositionen und Rechnungspositionen sind append-only |
| Wo ließ sich die Zahlungshistorie umgehen? | (1) `PAYMENT_CONFIRMED` per Referenztext ohne Betrag/Zahlung (Tag 5) – **geschlossen** (Service + DB-Trigger: nur mit bezahlter Vorkasse-Rechnung); (2) Kreditbuchung ohne Freigabe – **geschlossen** (DB-Trigger); (3) Löschen/Ändern von Rechnungen/Zahlungen – **geschlossen** (Trigger); (4) neues Konto/neue E-Mail – Historie hängt am Kunden, Identitätsabgleich führt zum bestehenden Datensatz |

Internes Modell (umgesetzt): eine Engine (`payment-risk`), ein Rechnungs-/Zahlungsmodul
(`billing`), Buchungsseite nur über `operations`-Funktionen; Sperrreihenfolge
Kunden-Finanz-Advisory-Lock → Buchung → Rechnung → Zahlung.

## 3. Änderungen

| Bereich | Inhalt |
| --- | --- |
| Datenbank | Migration `0007_day6_invoices_payments_credit` (additiv): `invoice`, `invoice_item`, `invoice_status_transition`, `invoice_number_counter`, `payment`, `payment_reference`, `payment_transition`, `payment_provider_event`, `credit_terms_approval`, `payment_risk_evaluation`; `booking.payment_review_required` (Default `false`); Trigger-Guards |
| `@isela/payment-risk` | zentrale Engine `evaluateCustomerPaymentTerms(db, customerId, context)`, Loader der echten Historie, Ergebnis-Log, Advisory-Lock je Kunde |
| `@isela/billing` (neu) | Rechnungen, Nummernkreis, Zahlungen, Idempotenz, Erstattung, Rückbuchung, Kreditfreigabe, Fälligkeitslauf, Risikoansichten, Provider-Abstraktion, Webhook-Verarbeitung |
| `@isela/operations` | Buchungsanlage über die zentrale Engine; Zahlungsbestätigung nur über Rechnung; Zahlungsschutz künftiger Buchungen; Kredit-Neuprüfung beim Einsatzbeginn |
| Web | `/admin/invoices[/id]`, `/admin/payments`, `/admin/payment-risk[/customerId]`, `/customer/invoices[/id]`, Rechnungsbereich auf der Buchungsseite, Webhook-Route (ohne Provider 404) |

## 4. Rechnungsdomäne (§3–§6)

- **Invoice:** Nummer, Kunde, Objekt, Buchung, Angebot, Einsatz, Rechnungs-/Fälligkeitsdatum,
  Währung, Netto/Steuer/Brutto, bezahlter Betrag, Status, Zahlungsbedingung
  (`VORKASSE|CREDIT_TERMS`), `created_by`/`issued_by`, Zeitstempel, Version.
- **InvoiceItem:** unveränderlicher Snapshot (Beschreibung, Menge, Einheit, Einzelpreis,
  USt-Satz, Netto, Steuer, Brutto) aus den Buchungspositionen.
- **Payment / PaymentReference / PaymentAllocation:** eine Zahlung gehört genau zu einer
  Rechnung; die Zuordnung ist `applied_cents` (ein Überschuss bleibt sichtbar) – eine
  eigene Allokationstabelle war nicht nötig (optional laut Vorgabe).
- **Status:** `DRAFT → ISSUED → OPEN → PARTIALLY_PAID/PAID/OVERDUE`, `DRAFT → CANCELLED`
  (keine Nummer verbraucht), `ISSUED…PAID → VOID` (Nummer bleibt vergeben). Zahlungsgetriebene
  Status werden nur aus Beträgen/Daten abgeleitet (`deriveInvoiceStatus`). Jeder Wechsel:
  Guard, optimistische Version, append-only Log, Audit, Akteur, Zeit, Grund (Storno/Verwerfen
  Pflicht). Der DB-Trigger wiederholt die Übergangstabelle.
- **Nummern:** `<PRÄFIX>-<JAHR>-<LAUFNUMMER>`, serverseitig beim Ausstellen per atomarem
  UPSERT auf `invoice_number_counter` (Zeilensperre, Rollback setzt zurück, nie `count + 1`),
  Jahr aus dem Rechnungsdatum in der Geschäftszeitzone, `invoice_number_uq` als letzte
  Sicherung; Zähler nur vorwärts (Trigger). Test: 5 parallele Ausstellungen → 000001–000005,
  Jahreswechsel 31.12. 23:30 / 01.01. 00:30 (Europe/Berlin) → getrennte Folgen.
- **Snapshot:** Kopf- und Positionsdaten sind nach dem Anlegen unveränderlich (Trigger
  `invoice_update_guard`, `invoice_item_append_only`, Positionen nur im Entwurf); spätere
  Preisregeln, Angebots- oder Buchungsänderungen wirken nicht.

## 5. Zahlungsbedingungen und Payment Risk (§7–§8, §20, §23–§25)

`evaluateCustomerPaymentTerms(customerId, context)` liefert ein erklärbares Ergebnis:
`VORKASSE_REQUIRED | CREDIT_TERMS_ALLOWED | BLOCKED | REVIEW_REQUIRED` plus Gründe,
Kreditrahmen und verfügbaren Rahmen.

| Regel | Umsetzung |
| --- | --- |
| Neukunde, Auftrag 1 und 2 | Vorkasse (`NEW_CUSTOMER`, `INSUFFICIENT_PAID_ORDERS`) |
| Rechnungskauf frühestens nach ≥ 3 abgeschlossenen **und** bezahlten Aufträgen | Zählung: Buchung `COMPLETED`, Rechnung `PAID`, keine Erstattung/Rückbuchung, Rückgabefrist des Zahlungsmittels abgelaufen; Policy-Minimum ≥ 3 (Schema) |
| keine überfälligen Beträge | nach Fälligkeitsdatum + Karenz gezählt – unabhängig vom Fälligkeitslauf (`OPEN_OVERDUE_INVOICE`) |
| keine Rückbuchungen / Zahlungsprobleme | `RECENT_CHARGEBACK`, `FAILED_PAYMENTS`, `LATE_PAYMENT_HISTORY` im Betrachtungszeitraum |
| Historie nicht per neuem Konto rücksetzbar | Historie am Kunden; Identitätsabgleich (E-Mail/USt-ID/Zahlungsreferenz) führt zum bestehenden Datensatz (Test) |
| keine automatische Freigabe wegen „3 Jobs“ | Minimum ergibt nur `CREDIT_APPROVAL_REQUIRED`; `requireManualApproval` ist jetzt Literal `true` (per Setting nicht abschaltbar) |
| Kreditrahmen | wird bei der Freigabe gesetzt (≤ Obergrenze `defaultCreditLimitCents` der Richtlinie); Obligo = offene Rechnungsbeträge + nicht fakturierte Kreditbuchungen; `CREDIT_LIMIT_EXCEEDED` inkl. angefragtem Auftrag |
| Freigabe-Flow | `REQUESTED → APPROVED/DENIED`, `APPROVED → REVOKED`; Antrag nur bei erfüllter Mindesthistorie; Freigabe nur `credit_terms:approve` (SUPER_ADMIN/FINANCE, MFA), Vier-Augen (Service **und** DB-CHECK), Rahmen, interne Vertrauensbewertung, Grund; Widerruf stellt nicht begonnene Kreditbuchungen sofort auf Vorkasse |
| Risk-Ansicht | erfolgreiche/bezahlte Aufträge, fehlgeschlagene Zahlungen, offene/überfällige Beträge, Rückbuchungen, Ergebnis, Gründe, letzte Bewertung (append-only Log `payment_risk_evaluation`, Ergebnisänderungen auditiert) |

Namenszuordnung zu den Beispielen der Vorgabe: `FIRST_TWO_JOBS` ≙ `INSUFFICIENT_PAID_ORDERS`,
`INSUFFICIENT_PAID_HISTORY` ≙ `INSUFFICIENT_PAID_ORDERS`/`CREDIT_APPROVAL_REQUIRED`,
`OVERDUE_INVOICE` ≙ `OPEN_OVERDUE_INVOICE`, `CHARGEBACK_HISTORY` ≙ `RECENT_CHARGEBACK`,
`HIGH_RISK` ≙ `TRUST_SCORE_TOO_LOW`/`FAILED_PAYMENTS`, `APPROVED_CREDIT_TERMS` ≙
`CREDIT_TERMS_APPROVED`. Die seit Tag 4 gespeicherten Codes wurden bewusst nicht umbenannt
(bestehende Buchungs-Snapshots bleiben lesbar).

## 6. Teilzahlung, Überzahlung, Überfälligkeit, Erstattung (§9–§11)

| Thema | Festlegung |
| --- | --- |
| Teilzahlung erlaubt? | Eingänge sind Tatsachen und werden immer erfasst; Rechnung `PARTIALLY_PAID`, nie `PAID`; zählt nie als bezahlt (Policy-Literal). Aktiv angebotene Ratenzahlung: Owner-Entscheidung, nicht angeboten |
| Restbetrag | `brutto − bezahlt` (BigInt-Cent) |
| `PAID` | bezahlt = brutto |
| `PARTIALLY_PAID` | 0 < bezahlt < brutto, nicht überfällig |
| `OVERDUE` | Rest > 0 und Geschäftsdatum > Fälligkeit + `overdueGraceDays` |
| Überzahlung | nur der offene Betrag wird zugeordnet; Überschuss bleibt sichtbar („Klärung erforderlich“, Audit `payment.overpayment_detected`). Verrechnung/Guthaben vs. Rückzahlung: **CONFIG_REQUIRED** (Owner) |
| Überfälligkeit | Engine erzwingt sofort Vorkasse für neue Aufträge und blockiert den Start nicht begonnener Kredit-Einsätze; der Fälligkeitslauf setzt `OVERDUE`, bewertet neu und stellt künftige Kreditbuchungen auf `VORKASSE_REQUIRED`/`PAYMENT_REQUIRED`/`PENDING_PAYMENT` mit Prüfvermerk (Regel aus DOMAIN_MODEL §11, nichts gelöscht, Einsatz/Zuweisung bleiben) |
| Scheduler | es gibt noch keinen Worker; der Lauf wird von FINANCE/ADMIN ausgelöst. Der Schutz neuer Aufträge hängt davon **nicht** ab |
| Erstattung | nur für Zahlungen stornierter Rechnungen (bezahlte Rechnung nur bei stornierter Buchung stornierbar); `CONFIRMED → REFUND_PENDING → REFUNDED` mit Referenz der Rücküberweisung; Buchung danach `REFUNDED`. Teil-Erstattungen: CONFIG_REQUIRED |
| Rückbuchung | `CONFIRMED → CHARGED_BACK`: Betrag zurück, Rechnung wieder offen/überfällig, Vorkasse-Buchung unter Prüfvermerk, künftige Kreditbuchungen auf Vorkasse |

## 7. Zahlungen, Provider, Idempotenz, Webhooks (§12–§16)

- **Zahlungsstatus:** `PENDING, AUTHORIZED, CONFIRMED, FAILED, REFUND_PENDING, REFUNDED,
  CHARGED_BACK` (Rückbuchung zusätzlich, weil sie für das Risiko zwingend ist). DB-Trigger
  wiederholt die Übergänge; erfasste Fakten (Betrag, Rechnung, Kunde, Methode, Schlüssel)
  unveränderlich.
- **PaymentReference:** Referenz, Anbieter, Eingang, Betrag, Währung, erfasst von; eindeutig
  je Anbieter (dieselbe Banktransaktion nie doppelt). Luhn-gültige Kartennummern sowie
  CVV/PIN/Passwort/Secret/Token werden abgelehnt.
- **Provider:** `PaymentProvider` mit `createPaymentIntent`, `getPaymentStatus`,
  `verifyPayment`, `refundPayment`. **Kein Anbieter aktiv:** Standard
  `UNCONFIGURED_PAYMENT_PROVIDER` antwortet immer `CONFIG_REQUIRED`; die Webhook-Registry ist
  leer (Route → 404). Test-Double nur in `test/support/payment-provider.ts`.
- **Idempotenz:** Idempotenzschlüssel (serverseitig je Formularansicht erzeugt, unique),
  Provider-Event-ID (unique je Anbieter), Referenz unique, bedingte Statuswechsel unter
  Zeilensperren. Doppelte Zustellung → `DUPLICATE`; Replay/älterer Zustand →
  `IGNORED_OUT_OF_ORDER` (nie Rückschritt); Zeitstempel `processed_at`, Eventstatus.
- **Webhook-Sicherheit:** feste Provider-Konfiguration, HMAC-SHA256 über
  `Zeitstempel.Rohkörper` mit konstantem Vergleich, Toleranz 300 s, striktes Schema, nur
  Payload-Hash gespeichert, Bestätigung erst nach `verifyPayment` (Server-zu-Server),
  Betrag/Währung müssen passen, Körpergröße begrenzt, Antworten ohne Details.

## 8. Rechnungserzeugung und Guards (§17–§19)

- Rechnungen entstehen nur serverseitig aus einer Buchung (= materialisiertes, angenommenes
  Angebot): Vorkasse-Rechnung für Buchungen in `PENDING_PAYMENT`, Schlussrechnung nur für
  Kreditbuchungen mit Einsatz `COMPLETED/QUALITY_CHECK/CLOSED`. Abgelehnte Angebote werden nie
  Buchungen; stornierte Buchungen/Einsätze werden nicht fakturiert (Stornogebühren: Owner).
  Eine aktive Rechnung je Buchung (Service + partieller Unique-Index, Race-Test).
- Abgeschlossene Einsätze werden **nie automatisch bezahlt** – bezahlt macht nur eine
  bestätigte Zahlung.
- Zahlungssperre (Tag 5) bleibt und ist verschärft: Einsatzbeginn nur mit bestätigter
  Vorkasse **oder** gültiger Kreditfreigabe ohne überfällige Rechnung und ohne offenen
  Prüfvermerk – im Service (Neubewertung mit der zentralen Engine) und im Trigger.

## 9. Admin, Kundenportal, RBAC (§21–§22, §28)

| Rolle | Finanzrechte |
| --- | --- |
| SUPER_ADMIN | alles |
| ADMIN | Rechnungen, Zahlungen, Risiko lesen, Antrag/Widerruf – **keine** Kreditfreigabe, keine Zahlungsrichtlinie |
| FINANCE | Rechnungen, Zahlungen, Risiko, Kreditfreigabe (MFA) |
| DISPATCHER | nur Zahlungsstatus der Buchung (für die Einsatzfreigabe) |
| STAFF | keine Finanzdaten |
| PARTNER | keine – eine Partnerabrechnung existiert noch nicht (offener Punkt) |
| CUSTOMER | eigene freigegebene Rechnungen (OWN), Zahlungsstatus, eigene Zahlungsreferenzen |

Neue Rechte: `invoice:read|write`, `payment_risk:read`, `credit_terms:request|approve`
(`payment:manage` erweitert). Listen enthalten nur Kundenanzeigename, Beträge, Daten und
Status. Die Kundenansicht enthält keine internen Kosten, Margen, Risiko-, Personal- oder
Partnerdaten; fremde oder nicht freigegebene Rechnungen → 404.

## 10. Security- und Nebenläufigkeitstests (§29–§30)

- IDOR: Rechnung (fremd/Entwurf/unbekannt → 404), Zahlungen, Risikoprofil (Kunde,
  Dispatcher, Staff, Partner → 403).
- Gefälscht: `customerId`, Beträge, Status `PAID`, Rechnungsnummer, `appliedCents`,
  Zahlungsstatus, `riskLevel`, Rahmen über Obergrenze, Vertrauenswert unter Minimum →
  abgelehnt; Rollen-Eskalation (ADMIN/Antragsteller freigeben) → 403.
- Doppelzahlung, Webhook-Replay, doppelte Rechnung, Historien-Reset, Überfälligkeits-Bypass,
  Teilzahlungsberechnung, DB-Direktmanipulation (Snapshot, Nummer, Zähler, Status, Löschen,
  `TRUNCATE`, append-only Logs).
- Races: zwei Rechnungen gleichzeitig, fünf Ausstellungen gleichzeitig, zwei Vollzahlungen
  gleichzeitig (nie doppelt bezahlt), gleiche Zahlung zweimal bestätigt, gleicher
  Idempotenzschlüssel parallel, parallele Kreditanträge, Freigabe vs. Ablehnung parallel,
  Webhook doppelt parallel, Storno vs. Zahlungsbestätigung.

## 11. Steuerlogik (§26)

Steuer je USt-Satz auf der Nettosumme, kaufmännisch gerundet – identisch zur Angebotslogik
(`calculateTotals`). Tests: 0,01 € (3 × 0,01 € bei 19 % → 1 Cent), 0,02 €, 99,99 €, große
Beträge, Teil- und Überzahlung. Steuersätze stammen aus der Angebotskonfiguration; eine
rechtlich vollständige Rechnung (Pflichtangaben § 14 UStG, E-Rechnung, Storno-/Gutschrift-
beleg, PDF) ist **nicht** Teil von Tag 6 – Owner/Steuerberater (offener Punkt).

## 12. Tests (§32)

| Ebene | Ergebnis | Baseline |
| --- | --- | --- |
| Unit | 896 | 757 |
| Integration | 232 | 203 |
| E2E | 15 | 14 |

Neu: `test/unit/billing.test.ts` (Geld, Status, Nummern, Referenzen, Webhook-Signatur),
Engine-/Policy-/RBAC-Erweiterungen, `test/integration/billing.test.ts` (29 Fälle: Angebot →
Buchung → Einsatz → Rechnung → Zahlung, Kreditfluss mit drei realen Aufträgen, Überfälligkeit,
Schutz, Widerruf, IDOR, Races, DB-Guards, Provider/Webhooks), `apps/web/e2e/finance.spec.ts`;
`operations.spec.ts` zahlt Vorkasse jetzt über Rechnung und prüft das Kundenportal.

Angepasste (nicht gelöschte) Tests wegen bewusst verschärfter Regeln:

- `bookings.test.ts` „is changed only by finance with a reference …“ → „is confirmed only
  through a paid prepayment invoice …“ (Referenztext bestätigt nicht mehr).
- `payment-terms.test.ts` „allows invoice review only after three … paid orders“ → „allows
  invoice terms only after three … AND an approval“ (keine automatische Gewährung mehr).
- Übrige Fälle behalten ihren Namen; Testdaten enthalten jetzt die Freigabe. Der
  parametrisierte Test der verbotenen Buchungsübergänge hat zwei Fälle weniger
  (`CONFIRMED/SCHEDULED → PENDING_PAYMENT` ist jetzt der Schutzpfad), dafür neue explizite
  Tests. Abgleich der Testnamen Tag 5 → Tag 6: 452 → 515, keine ersatzlos entfallen.

E2E „Overdue-Zustand“: der Fälligkeitslauf, der Überfällig-Filter und die Risikoansicht sind
E2E abgedeckt; der Statuswechsel einer tatsächlich überfälligen Rechnung (braucht ein
Rechnungsdatum in der Vergangenheit) ist in der Integration abgedeckt.

## 13. Migration (§31, §33)

- Additiv: neue Tabellen/Enums, eine Spalte mit Default, neue Trigger; `isela_job_payment_guard`
  per `CREATE OR REPLACE` verschärft (alle bisherigen Bedingungen bleiben). Kein `DROP`,
  kein `TRUNCATE`, keine Enum-Neuerstellung.
- Upgrade-Test: Day-5-Code (`51d8110`) in einem Worktree erzeugte echte Altdaten (23
  Buchungen, davon 6 mit altem manuell bestätigtem Zahlungsstatus, 15 Einsätze) → Migration
  0007 → Buchungsdaten bitgenau unverändert, 8 Migrationen, kein neuer `NOT VALID`-Constraint
  (3 bekannte aus Tag 5), Altbuchungen weiter änderbar; Day-6-Suite (56 Tests) auf der
  migrierten DB grün.
- Indizes: Rechnungsnummer (unique), Kunde+Erstellung, Status+Fälligkeit, Erstellung,
  aktive Rechnung je Buchung; Zahlung je Rechnung, Kunde+Status, Status+Erstellung,
  Idempotenzschlüssel, Provider-Zahlung; Referenz (unique); Events; Kreditentscheidungen;
  Risiko-Log je Kunde+Zeit. Keine weiteren.
- Datencheck vor Constraint: gespeicherte `payment.policy` mit `requireManualApproval=false`
  würde jetzt vom Schema abgelehnt (fail-safe: keine Buchung statt Kredit). In der
  Upgrade-DB existiert keine solche Version.

## 14. Audit (§27)

`invoice.created|issued|status_changed|overdue|voided|due_date_changed` (mit
`manualOverride`), `payment.created|confirmed|failed|refund_requested|refunded|refund_aborted|charged_back|authorized|overpayment_detected`,
`credit_terms.requested|approved|denied|revoked`, `payment_risk.evaluation_changed`,
`booking.payment_protection_applied|payment_review_flagged|payment_review_cleared`. Keine
Referenztexte, keine Bank-/Kartendaten, keine Namen im Audit.

## 15. Owner-Entscheidungen und Konfiguration

| Wert | Stand |
| --- | --- |
| Rechnungs-Präfix, Zahlungsziel, Vorkasse-Frist (`billing.config`) | **CONFIG_REQUIRED** – ohne Werte wird keine Rechnung ausgestellt |
| Zahlungsanbieter | nicht gewählt, nicht aktiv |
| Überzahlung (Guthaben/Rückzahlung), Teil-Erstattung, Ratenzahlung, Stornogebühren | CONFIG_REQUIRED, nicht angeboten |
| Rechtliche Rechnungspflichtangaben, E-Rechnung, Storno-/Gutschriftbeleg | Owner/Steuerberater |
| Policy-Werte (`minSuccessfulPaidOrders` 3, Karenz, Lookback, Kreditrahmen-Obergrenze 500 €, `minTrustScore` 70, `maxFailedPaymentsInLookback` 0, B2C aus) | Standard „zu bestätigen“ (PRODUCT_SPEC §6.3) |
| Vier-Augen bei Kreditfreigabe | immer aktiv |
| Partnerabrechnung | offen |

## 16. Risiken

- Kein Scheduler für den Fälligkeitslauf (Materialisierung/Schutz künftiger Kreditbuchungen
  erfolgt erst beim Lauf; neue Aufträge und Einsatzstarts sind sofort geschützt).
- Prüfvermerk nach Rückbuchung auf bereits bestätigter Vorkasse ändert den Zahlungsstatus der
  Buchung nicht (Trigger-/Service-Sperre verhindert den Start).
- Rechnungen sind noch keine rechtlich vollständigen Belege (siehe §11).
- `payment.policy`-Versionen mit `requireManualApproval=false` werden abgelehnt (fail-safe).

## 17. Rollback

Code: PR nicht mergen bzw. Revert. Datenbank: 0007 ist additiv; ein Rückbau wäre eine
eigene, geprüfte Migration (Trigger/Funktionen entfernen, Tabellen erst nach Datensicherung) –
kein automatisches Down. Die Day-5-Funktion `isela_job_payment_guard` kann per
`CREATE OR REPLACE` auf den alten Stand gesetzt werden.

## 18. Final Gate

| Gate | Ergebnis |
| --- | --- |
| git status / diff | sauber; Diff geprüft (keine Secrets, keine `.env`, kein `DROP`/`TRUNCATE`) |
| Typecheck (Root + Web) | grün |
| Lint (ESLint strict + Prettier) | grün |
| Unit | 896/896 grün (Baseline 757) |
| Integration | 232/232 grün (Baseline 203) |
| E2E | 15/15 grün (Baseline 14) |
| Build (Produktion) + Client-Bundle-Scan | grün |
| Migration: Drift / Upgrade-Test | grün / grün (Day-5-Altdaten unverändert, Day-6-Suite 56/56 auf migrierter DB) |
| Security-Tests (IDOR, Fälschung, Races, Webhooks, DB-Guards) | grün (Teil der Integration) |
| Modulgrenzen, Hardcoding-Guard, Forbidden-Files | grün |
| `pnpm audit` / Lizenzen | 0 Schwachstellen / alle erlaubt |
| Secrets (gitleaks, Day-6-Commits) | keine Funde (Verzeichnisfunde nur in ignorierten `node_modules`/`.next`) |
| markdownlint | grün |
| Baseline-Regression | keine; Testnamen 452 → 515, keiner ersatzlos entfallen |

**Tatsächlicher CI-Stand auf `ebd6a7d00bae27f194b024a7981011ba8c356d1a`** (PR #7, Läufe `push`
und `pull_request`, Stand 2026-09-30):

| Check | Ergebnis |
| --- | --- |
| Typecheck, lint, unit tests, build | success |
| Integration tests (PostgreSQL + PostGIS) | success |
| E2E (Playwright, production build, PostgreSQL + PostGIS) | success |
| Web build (production) and client-bundle secret scan | success |
| Secret scan (gitleaks) | success |
| Dependency audit and license policy | success |
| Repo guard (forbidden files) | success |
| Markdown lint | success |
| Workflow lint (actionlint) | success |
| CodeQL / Analyze (JavaScript/TypeScript) | success |
| Dependency review (pull requests) | failure – `Dependency review is not supported on this repository. Please ensure that Dependency graph is enabled` |

Modulgrenzen und Hardcoding-Guard laufen im Job „Typecheck, lint, unit tests, build“, der
Migrations-Drift im Job „Integration tests“ – beide grün. Dependency Review scheitert
ausschließlich an der Owner-Einstellung „Dependency graph“ (seit #2 bekannt, auf #7
kommentiert); der Check wurde weder abgeschaltet noch umgangen. Keine offenen Review-Threads.
Nach `ebd6a7d` folgt nur dieser Dokumentations-Nachtrag (keine Code-Änderung).

Verdict: `PHASE 1 DAY 6 COMPLETE`.

## 19. Nächster Schritt

Review dieses Reports und der Owner-Entscheidungen (§15) durch den Inhaber. Kein
eigenmächtiger Merge, kein Beginn von Tag 7.
