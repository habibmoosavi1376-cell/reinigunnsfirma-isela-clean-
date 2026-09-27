# ISELA CLEAN – Produktspezifikation

| Feld | Wert |
| --- | --- |
| Status | Entwurf (Phase 0) – fachliche Freigabe ausstehend |
| Geschäftlicher Name | ISELA CLEAN |
| Repository | `reinigunnsfirma-isela-clean-` (siehe `docs/PHASE_0_REPORT.md`) |
| Startmarkt | Gelsenkirchen |

Dieses Dokument beschreibt **was** die Plattform fachlich leisten soll. Das **wie**
steht in [`ARCHITECTURE.md`](ARCHITECTURE.md), Sicherheitsanforderungen in
[`SECURITY.md`](SECURITY.md). Alle als *Default* markierten Werte sind Vorschläge und
müssen fachlich bestätigt werden.

## 1. Geschäftsmodell

ISELA CLEAN kombiniert vier Geschäftsbereiche auf einer Plattform:

| Bereich | Beschreibung | Leistungserbringung |
| --- | --- | --- |
| Eigene Reinigung | ISELA CLEAN führt Aufträge mit eigenem Personal aus | `IN_HOUSE` |
| Vermittlung | Aufträge werden an geprüfte Reinigungspartner vergeben; ISELA CLEAN erhält eine Provision | `PARTNER` |
| Wiederkehrende Kunden | Verträge mit festem Turnus | `IN_HOUSE` oder `PARTNER` |
| B2B | Gewerbekunden mit mehreren Objekten, Ansprechpartnern und Rahmenverträgen | `IN_HOUSE` oder `PARTNER` |

Jeder Auftrag trägt einen **Fulfillment-Typ** (`IN_HOUSE` | `PARTNER`). Preislogik,
Abrechnung und Qualitätskontrolle sind für beide Typen einheitlich modelliert.

### 1.1 Leistungskatalog (initial)

Privatreinigung, Büroreinigung, Praxisreinigung, Treppenhausreinigung, Fensterreinigung,
Grundreinigung, Unterhaltsreinigung, Immobilien-/Objektreinigung (z. B. Übergabe,
Leerstand). Der Katalog ist **datengetrieben** erweiterbar (neue Leistung = Datensatz,
kein Code-Release).

### 1.2 Kundensegmente

- **Privatkunden (B2C)**
- **Gewerbekunden (B2B):** Hausverwaltungen, Immobilienunternehmen, Büros, Praxen,
  Gastronomie, Fitnessstudios, Einzelhandel, weitere Branchen (Branche als
  konfigurierbare Liste, nicht als Enum im Code).

### 1.3 Turnus wiederkehrender Aufträge

`WEEKLY`, `BIWEEKLY`, `MONTHLY`, `CUSTOM` (frei definierbare Regel, z. B.
RFC-5545-RRULE). Feiertage (NRW, später bundeslandabhängig) und Pausen müssen
berücksichtigt werden.

## 2. Marktexpansion und Einsatzgebiete

Einsatzgebiete sind **Daten**, niemals hartcodierte Städte oder Postleitzahlen.

```text
Stufe 1  Gelsenkirchen (Stadtgebiet)
Stufe 2  Radius 25 km um Gelsenkirchen
Stufe 3  Radius 50 km
Stufe 4  Ruhrgebiet (Polygon)
Stufe 5  NRW (Polygon)
Stufe 6  Deutschland
```

Anforderungen:

- Ein **Einsatzgebiet** (`ServiceArea`) ist entweder *Mittelpunkt + Radius* oder
  *Polygon*; es kann aktiv/inaktiv geschaltet werden.
- Leistungen, Preise, Anfahrtspauschalen und verfügbare Partner können **je
  Einsatzgebiet** unterschiedlich sein.
- Anfragen außerhalb aktiver Gebiete werden nicht verworfen, sondern als Lead mit
  Kennzeichen „außerhalb Einsatzgebiet“ erfasst (Nachfrage-Signal für Expansion).
- Zeitzone `Europe/Berlin`, Währung `EUR`, Sprache initial Deutsch – alle drei als
  Konfiguration, nicht als verstreute Literale.

## 3. Rollen (Akteure)

| Rolle | Beschreibung |
| --- | --- |
| `OWNER` | Geschäftsführung, Vollzugriff inkl. Konfiguration |
| `ADMIN` | Systemadministration, Nutzerverwaltung |
| `DISPATCHER` | Disposition: Aufträge planen, zuweisen |
| `SALES` | Leads, Angebote, Kundenbetreuung |
| `ACCOUNTING` | Rechnungen, Zahlungen, Zahlungsbedingungen, Partnerabrechnung |
| `EMPLOYEE` | Eigene Reinigungskraft: eigene Einsätze, Checklisten |
| `PARTNER_ADMIN` | Inhaber eines Partnerbetriebs |
| `PARTNER_STAFF` | Mitarbeitende eines Partnerbetriebs |
| `CUSTOMER` | Privatkunde |
| `B2B_ADMIN` | Verantwortliche Person eines Gewerbekunden |
| `B2B_USER` | Weitere Nutzer eines Gewerbekunden (z. B. Objektbetreuung) |

Berechtigungen werden als **Permissions** modelliert (z. B. `invoice:approve`), Rollen
sind Bündel von Permissions. Details: [`SECURITY.md`](SECURITY.md#3-autorisierung-rbac).

**Umsetzung ab Phase 1:** Die fachlichen Akteure oben werden auf sieben technische
Rollen abgebildet (Details: [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md#101-rollen-phase-1)):

| Technische Rolle | Fachliche Akteure |
| --- | --- |
| `SUPER_ADMIN` | `OWNER` |
| `ADMIN` | `ADMIN`, `SALES` (Vertrieb bis zur Einführung einer eigenen Rolle) |
| `DISPATCHER` | `DISPATCHER` |
| `FINANCE` | `ACCOUNTING` |
| `STAFF` | `EMPLOYEE` |
| `PARTNER` | `PARTNER_ADMIN` (mit `is_scope_admin`), `PARTNER_STAFF` |
| `CUSTOMER` | `CUSTOMER`, `B2B_ADMIN` (mit `is_scope_admin`), `B2B_USER` |

## 4. Fachliche Module (Bounded Contexts)

| Modul | Kernobjekte | MVP-Tag |
| --- | --- | --- |
| Identity & Access | User, Session, Role, Permission, Organization | 2 |
| CRM | Customer, Organization, Contact, Property (Objekt), Note, Activity | 2 |
| Acquisition | Lead, LeadSource, LeadScore, OutreachDraft, FollowUp | 3 |
| Catalog | Service, ServiceVariant, ServiceArea | 4 |
| Pricing & Quotes | PriceRule, Quote, QuoteLine | 4 |
| Booking | BookingRequest, Booking, TimeSlot | 4 |
| Recurring | ServiceContract, RecurrenceRule, Occurrence | 8 |
| Fulfillment | Job, Employee, Partner, Assignment, Checklist | 5 |
| Quality | Inspection, Complaint, Review | 5 / 8 |
| Billing | Invoice, Payment, CreditNote, PaymentTermsDecision | 6 |
| Payment Risk | PaymentPolicy, CustomerPaymentProfile, TrustScore | 6 |
| Partner Settlement | PartnerStatement, Commission | 6 |
| Website & SEO | Page, LocationPage, ServicePage | 7 |
| Automation | Notification, Reminder, ScheduledTask | 8 |
| Audit | AuditEvent | ab 2 (querschnittlich) |

## 5. Customer Acquisition Engine

Ziel: planbare, rechtskonforme Neukundengewinnung – **Mensch entscheidet, System
unterstützt**.

### 5.1 Pipeline

```text
Discovery → Deduplizierung → Enrichment → Qualification → Scoring
        → Review (Mensch) → Outreach-Entwurf → Versand (manuell) → Follow-up
        → Conversion (Angebot / Auftrag) → Auswertung
```

### 5.2 Komponenten

| Komponente | Aufgabe |
| --- | --- |
| Lead Management | Lead-Lebenszyklus, Status, Zuständigkeit, Historie |
| Lead Discovery | Import aus Quellen über austauschbare Adapter (`LeadSource`) |
| Auftragssuche | Öffentliche Ausschreibungen / Bedarfsmeldungen als eigener Quellentyp |
| Lead Qualification | Pflichtkriterien: Einsatzgebiet, Segment, Leistungsbedarf |
| Lead Scoring | Erklärbarer Score aus konfigurierbaren, gewichteten Faktoren |
| Company Research | Firmendaten aus zulässigen öffentlichen Quellen |
| Contact Research | Nur geschäftliche Kontaktdaten mit dokumentierter Herkunft |
| Outreach Drafting | Entwürfe für Anschreiben – **kein** automatischer Versand |
| Follow-up | Wiedervorlagen/Aufgaben für Vertrieb |
| Conversion Tracking | Lead → Angebot → Auftrag → Umsatz, je Quelle |

### 5.3 Verbindliche Regeln

1. **Keine automatische Massenansprache.** Versand erfolgt ausschließlich nach
   menschlicher Freigabe pro Nachricht.
2. Jeder Lead speichert **Quelle**, **Erhebungsdatum** und **Rechtsgrundlage** der
   Verarbeitung (DSGVO Art. 6); Kontaktsperren (Widerspruch) werden global beachtet.
3. Werbliche Ansprache per E-Mail/Telefon unterliegt u. a. § 7 UWG. Die zulässigen
   Kanäle je Segment sind **vor** Implementierung des Outreach-Moduls rechtlich zu
   prüfen (siehe offene Fragen).
4. Keine Scraping-Adapter, die gegen Nutzungsbedingungen der Quelle verstoßen.
5. Scoring ist **erklärbar**: jeder Score listet die beitragenden Faktoren.

### 5.4 Lead-Scoring (Default-Faktoren, konfigurierbar)

| Faktor | Beispiel |
| --- | --- |
| Gebietspassung | Entfernung zum nächsten aktiven Einsatzgebiet |
| Segmentpassung | Branche im Zielsegment |
| Bedarfssignal | Ausschreibung, Neueröffnung, Umzug, Anfrage über Website |
| Volumenpotenzial | Fläche, Objektanzahl, Turnus |
| Wiederkehrpotenzial | Unterhaltsreinigung statt Einmalauftrag |
| Datenqualität | Vollständigkeit, Aktualität, verifizierte Herkunft |

## 6. Payment Risk Engine

### 6.1 Geschäftsregel

| Situation | Zahlungsbedingung |
| --- | --- |
| Neukunde | Vorkasse (`PREPAYMENT`) |
| 1. Auftrag | Vorkasse |
| 2. Auftrag | Vorkasse |
| Nach ca. 3–4 erfolgreich bezahlten Aufträgen | Prüfung der Zahlungshistorie → ggf. Rechnung (`INVOICE`) |
| Überfällige Rechnung vorhanden | **Automatisch** zurück auf Vorkasse |

### 6.2 Prüfkriterien für `INVOICE`

Alle Bedingungen müssen erfüllt sein:

- Mindestanzahl erfolgreich bezahlter Aufträge erreicht
- keine offenen überfälligen Rechnungen
- keine problematischen Zahlungsrückstände im Betrachtungszeitraum
- keine relevanten Chargebacks / Rücklastschriften im Betrachtungszeitraum
- interne Vertrauensbewertung (Trust Score) über Schwellwert
- beantragter Betrag innerhalb des Kreditlimits

**„Erfolgreich bezahlt“** bedeutet: vollständig beglichen, nicht erstattet, nicht
zurückgebucht **und** außerhalb der Rückgabefrist des Zahlungsmittels (z. B. SEPA-
Lastschrift: 8 Wochen; bei nicht autorisierter Lastschrift bis zu 13 Monate). Die
Fristen sind je Zahlungsmittel konfigurierbar.

### 6.3 Konfiguration (keine Hartcodierung)

Die Regeln liegen als **versionierte Richtlinie** (`PaymentPolicy`) in der Datenbank.
Änderungen sind nur mit Permission `payment_policy:manage` möglich und werden
auditiert.

| Parameter | Default (zu bestätigen) |
| --- | --- |
| `minSuccessfulPaidOrders` | 3 |
| `maxOpenOverdueInvoices` | 0 |
| `overdueGraceDays` | 0 |
| `lookbackDays` | 365 |
| `maxLatePaymentsInLookback` | 0 |
| `latePaymentToleranceDays` | 7 |
| `maxChargebacksInLookback` | 0 |
| `minTrustScore` | 70 (Skala 0–100) |
| `defaultCreditLimitCents` | 50000 |
| `requireManualApproval` | `true` (System empfiehlt, `ACCOUNTING` gibt frei) |

### 6.4 Entscheidung und Nachvollziehbarkeit

Jede Bewertung erzeugt eine gespeicherte Entscheidung:

```text
PaymentTermsDecision {
  customerId, terms: PREPAYMENT | INVOICE, reasons: ReasonCode[],
  policyId, policyVersion, evaluatedAt, decidedBy: SYSTEM | userId
}
```

**Invarianten (Phase 1, verbindlich):** Die Konfiguration darf die Regeln niemals
unsicher machen – z. B. wird `minSuccessfulPaidOrders < 3` vom Validator abgelehnt.
Vollständige Liste sowie Definitionen für Teilzahlung, Mahnstufen, B2B/B2C,
Wiederholungsaufträge und Dubletten: [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md#11-payment-risk--verbindliche-invarianten).

Reason Codes (Auszug): `NEW_CUSTOMER`, `INSUFFICIENT_PAID_ORDERS`,
`OPEN_OVERDUE_INVOICE`, `LATE_PAYMENT_HISTORY`, `RECENT_CHARGEBACK`,
`TRUST_SCORE_TOO_LOW`, `CREDIT_LIMIT_EXCEEDED`, `MANUAL_OVERRIDE`.

**Neubewertung** bei: Zahlungseingang, Fälligkeitsüberschreitung, Chargeback,
Richtlinienänderung, manueller Anforderung. Überfälligkeit wirkt **sofort** auf neue
Aufträge. Manuelle Übersteuerung erfordert Begründung, Ablaufdatum und erzeugt ein
Audit-Event.

## 7. Vermittlung (Partner)

- **Partnerprüfung** vor Freischaltung: Gewerbenachweis, Betriebshaftpflicht,
  Nachweise gemäß rechtlicher Prüfung; Dokumente mit Ablaufdatum und Wiedervorlage.
- **Zuweisung:** nach Einsatzgebiet, Qualifikation, Verfügbarkeit, Qualitätsbewertung;
  Partner kann annehmen/ablehnen.
- **Qualitätskontrolle:** Checklisten, Foto-Nachweise (sichere Uploads), Stichproben,
  Reklamationen, Kundenbewertungen.
- **Partnerabrechnung & Provision:** Provisionsmodell konfigurierbar (prozentual,
  fix, je Leistung); periodische Abrechnungsbelege.

## 8. Nicht-funktionale Anforderungen

| Bereich | Anforderung |
| --- | --- |
| Datenschutz | DSGVO: Datenminimierung, Löschkonzept, Auskunft/Export, AV-Verträge, EU-Hosting |
| Buchhaltung | GoBD-konforme, unveränderbare Rechnungen; fortlaufende Nummernkreise |
| E-Rechnung | B2B-E-Rechnung (XRechnung/ZUGFeRD) gemäß gesetzlichen Übergangsfristen einplanen |
| Barrierefreiheit | WCAG 2.2 AA als Ziel; Anwendbarkeit des BFSG prüfen |
| Performance | Öffentliche Seiten: Core Web Vitals „gut“; API p95 < 300 ms (Ziel) |
| Verfügbarkeit | Backups mit getesteter Wiederherstellung; Ziel-RPO ≤ 24 h |
| Skalierung | Mandanten-/Gebietsfähigkeit ohne Code-Änderung; horizontale Skalierung der Web-/Worker-Prozesse |

## 9. MVP-Abgrenzung

**Im MVP:** Auth/RBAC, CRM, Leads (manuell + Website-Anfragen + ein geprüfter
Quellenadapter), Scoring, Leistungskatalog, Preise, Angebote, Buchung, Aufträge,
Mitarbeitende, Partner, Zuweisung, Rechnungen, Zahlungen über einen echten
Zahlungsanbieter (Testmodus bis zur Freigabe), Payment Risk Engine, Website mit
Local SEO, Wiederkehrende Aufträge, Erinnerungen/Follow-ups.

**Nicht im MVP:** automatisierte Ansprache, native Apps, Mehrsprachigkeit,
Routenoptimierung, Lohnabrechnung.

## 10. Offene fachliche Fragen

1. Zahlungsanbieter (z. B. Stripe, Mollie) und Bankanbindung – Entscheidung erforderlich.
2. Rechnungsstellung: eigenes Modul vs. angebundene Buchhaltungssoftware (z. B. via API).
3. Rechtliche Prüfung: zulässige Akquise-Kanäle (§ 7 UWG), Partner-Modell
   (Abgrenzung Scheinselbstständigkeit/Arbeitnehmerüberlassung), AGB, Widerrufsrecht B2C.
4. Branchenmindestlohn Gebäudereinigung als Preisuntergrenze in der Kalkulation?
5. Provisionsmodell für Partner.
6. Bestätigung aller *Default*-Werte in Abschnitt 6.3 und 5.4.
