# ISELA CLEAN – Domänenmodell (Phase 1)

| Feld | Wert |
| --- | --- |
| Status | Verbindliche Spezifikation für Phase 1 (Tag 1) |
| Ergänzt | [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`SECURITY.md`](SECURITY.md) |
| Umsetzung | `packages/database/src/schema/*` (Tabellen), Fachmodule unter `packages/*` |

Konventionen für alle Tabellen:

- Primärschlüssel `id uuid` (DB-Default `gen_random_uuid()`); Better-Auth-Tabellen
  verwenden die von Better Auth erzeugten Text-IDs.
- `created_at`/`updated_at` als `timestamptz` (UTC). Fachdaten werden **archiviert**
  (`archived_at`), nicht hart gelöscht. Harte Löschung erfolgt nur über den späteren
  DSGVO-Löschprozess (Anonymisierung), niemals per Kaskade aus Fachdaten.
- Fremdschlüssel auf Finanz-, Audit- und Stammdaten: `ON DELETE RESTRICT`.
  `CASCADE` nur für rein abhängige technische Daten (z. B. Sessions eines Nutzers).
- Enums sind PostgreSQL-Enums; Erweiterung nur per Migration.

## 1. Adressen – `customer_address`

| Feld | Typ | Regel |
| --- | --- | --- |
| `customer_id` | uuid FK → `customer` | Pflicht, `RESTRICT` |
| `address_type` | `BILLING` \| `SERVICE` \| `OTHER` | Pflicht |
| `street`, `house_number` | text | Pflicht, getrimmt, max. 200/20 Zeichen |
| `postal_code` | text | Pflicht; Format länderspezifisch validiert (DE: 5 Ziffern) |
| `city` | text | Pflicht |
| `country` | char(2) | ISO 3166-1 alpha-2, Default `DE` |
| `city_id`, `postal_code_id` | uuid FK, optional | Verknüpfung zu Referenzdaten, falls eindeutig zuordenbar |
| `latitude`, `longitude` | numeric(9,6) | beide gesetzt oder beide leer; Wertebereich geprüft |
| `location` | `geography(Point,4326)` | **generiert** aus lat/lng – nie separat schreibbar |
| `geocoding_status` | `PENDING` \| `SUCCEEDED` \| `FAILED` \| `MANUAL` | `SUCCEEDED`/`MANUAL` ⇒ Koordinaten gesetzt |
| `geocoded_at` | timestamptz | gesetzt, wenn Koordinaten gesetzt |
| `source` | `CUSTOMER_INPUT` \| `STAFF_INPUT` \| `IMPORT` | Pflicht |
| `verification_status` | `UNVERIFIED` \| `VERIFIED` \| `REJECTED` | Default `UNVERIFIED` |
| `archived_at`, `created_at`, `updated_at` | timestamptz | |

**Einsatzgebietsprüfung:** ausschließlich über `location` + PostGIS gegen aktive
`service_area`-Datensätze. PLZ und Ort sind Adress-/Referenzdaten und **niemals**
alleinige Entscheidungsgrundlage. Ohne Koordinaten gilt eine Adresse als „nicht
prüfbar“ (Ergebnis `UNKNOWN`), nicht als „im Gebiet“.

## 2. Referenzdaten – `city`, `postal_code`, `postal_code_city`

- `city`: `name`, `state_code` (z. B. `NW`), `country`, optional `official_key`
  (Amtlicher Gemeindeschlüssel, eindeutig), optional `centroid geography(Point)`.
- `postal_code`: `code`, `country`; eindeutig je (`code`, `country`).
- `postal_code_city`: **n:m** – eine PLZ kann mehrere Gemeinden betreffen, eine Gemeinde
  mehrere PLZ besitzen. Primärschlüssel (`postal_code_id`, `city_id`).
- Referenzdaten werden aus einer dokumentierten, lizenzierten Quelle importiert (Phase 4).
  Seeds enthalten nur den Startmarkt-Datensatz `Gelsenkirchen` (AGS `05513000`).

## 3. Einsatzgebiet – `service_area`

| Feld | Regel |
| --- | --- |
| `key` | eindeutig, slug |
| `name` | Anzeigename |
| `kind` | `CIRCLE` \| `POLYGON` |
| `center geography(Point,4326)`, `radius_m` | Pflicht bei `CIRCLE`, sonst leer; `radius_m` 1–1 000 000 |
| `boundary geography(MultiPolygon,4326)` | Pflicht bei `POLYGON`, sonst leer |
| `active` | Default `false` – Aktivierung ist eine bewusste Handlung |
| `priority` | Reihenfolge bei Überlappung |

Generische Geo-Dienste (keine Stadt-Sonderfälle):

- `findServiceAreasForPoint(point)` – alle aktiven Gebiete, die den Punkt enthalten.
- `isAddressInServiceArea(addressId)` – `IN_AREA` \| `OUTSIDE` \| `UNKNOWN` (keine Koordinaten).
- `findNearbyPartners(point, maxDistanceMeters)` – aktive Partner, deren Standort
  innerhalb der Distanz **und** deren eigener Einsatzradius den Punkt abdeckt.

`Gelsenkirchen` existiert ausschließlich als Seed (`CIRCLE`, 25 km, inaktiv bis zur
Freigabe). Code wie `if (city === "Gelsenkirchen")` ist verboten und wird per CI-Prüfung
gesucht.

## 4. Leistungen – `service_category`, `service`

- `service_category`: `key` (eindeutig), `name`, `description`, `active`, `sort_order`.
- `service`: `category_id` (FK, `RESTRICT`), `key` (eindeutig), `name`, `description`,
  `unit` (`HOUR` \| `SQUARE_METER` \| `FLAT` \| `UNIT`), `active`.
- Startkategorien als Seed: Gebäudereinigung, Büroreinigung, Unterhaltsreinigung,
  Fensterreinigung, Grundreinigung, Treppenhausreinigung, Wohnungsreinigung,
  Praxisreinigung, Gastronomiereinigung, Immobilien-/Hausverwaltungsservice.
- Keine Geschäftslogik auf Kategorienamen oder -keys; Verhalten wird über Daten
  (z. B. Preisregeln je Leistung) gesteuert.

## 5. Kunde – `customer`, `customer_identity`, `customer_duplicate_candidate`

- `customer`: `kind` (`PRIVATE` \| `BUSINESS`), `display_name`, `company_name`
  (Pflicht bei `BUSINESS`), `status` (`ACTIVE` \| `INACTIVE` \| `BLOCKED`),
  `duplicate_review_status` (`NONE` \| `PENDING`), `archived_at`.
- `customer_identity`: normalisierte, **gehashte** Identitätsmerkmale
  (`EMAIL`, `PHONE`, `TAX_ID`, `PAYMENT_REFERENCE`, `ADDRESS`). Hash = SHA-256 über den
  normalisierten Wert mit Anwendungs-Pepper (kein Klartext).
  - `EMAIL`, `TAX_ID`, `PAYMENT_REFERENCE` sind **systemweit eindeutig**: eine erneute
    Registrierung mit gleicher E-Mail führt zum **bestehenden** Kunden – eine negative
    Zahlungshistorie kann nicht durch ein neues Konto zurückgesetzt werden.
  - `PHONE`, `ADDRESS` sind Signale (nicht eindeutig): ein Treffer erzeugt einen
    `customer_duplicate_candidate` und setzt `duplicate_review_status = PENDING`.
    Solange `PENDING`, gilt für den Kunden zwingend Vorkasse.
- `property` (Objekt): `customer_id`, `address_id` (Adresse **desselben** Kunden),
  `name`, `property_type` (`APARTMENT` \| `HOUSE` \| `OFFICE` \| `PRACTICE` \|
  `STAIRWELL` \| `COMMERCIAL` \| `OTHER`), `area_sqm` (> 0, optional), `archived_at`.

## 6. Leads – `lead_source`, `lead`, `lead_contact`, `lead_status_transition`

### 6.1 `lead_source` (Provider-Konfiguration)

| Feld | Regel |
| --- | --- |
| `key` | eindeutig |
| `provider_kind` | `BUSINESS_SEARCH` \| `PUBLIC_OPPORTUNITY` \| `WEBSITE_RESEARCH` \| `REFERRAL` \| `INTERNAL_INBOUND` |
| `legal_basis` | Pflicht (`GDPR_ART6_1B_CONTRACT` \| `GDPR_ART6_1F_LEGITIMATE_INTEREST` \| `GDPR_ART6_1A_CONSENT`) |
| `terms_reviewed_at` | Pflicht für **externe** Kinds (`BUSINESS_SEARCH`, `PUBLIC_OPPORTUNITY`, `WEBSITE_RESEARCH`), sobald `enabled` |
| `allowed_use` | Pflicht, sobald `enabled` (Freitext der geprüften Nutzungsbedingungen) |
| `retention_days` | 1–1095 |
| `rate_limit_per_minute` | 1–600 |
| `enabled` | Default `false`; DB-Check verhindert Aktivierung ohne Prüfnachweis |
| `source_metadata` | jsonb, per Schema validiert (z. B. Basis-URL, Vertragsreferenz) |

### 6.2 `lead`

`source_id`, `source_reference` (eindeutig je Quelle, Dedupe), `status`,
`company_name`, `segment`, `website`, `postal_code`, `city`, `location` (optional),
`outside_service_area`, `score`, `owner_user_id`, `collected_at`, `archived_at`.

### 6.3 `lead_contact`

`lead_id`, `full_name`, `role_title`, `email`, `phone`, `source_id`, `legal_basis`,
`consent_status` (`NOT_REQUIRED` \| `UNKNOWN` \| `GRANTED` \| `WITHDRAWN`),
`suppressed`, `suppressed_at`, `suppression_reason`. Kontakte werden nur aus der
dokumentierten Quelle übernommen – keine generierten oder geratenen Adressen.
Ein Widerspruch wird zusätzlich in `contact_suppression` (Hash von E-Mail/Telefon)
gespeichert und gilt **global** für alle künftigen Leads.

### 6.4 Pipeline und erlaubte Übergänge

| Von | Nach |
| --- | --- |
| `DISCOVERED` | `RESEARCHING`, `QUALIFIED`, `QUOTE_REQUEST`¹, `LOST` |
| `RESEARCHING` | `QUALIFIED`, `LOST` |
| `QUALIFIED` | `OUTREACH_DRAFTED`, `QUOTE_REQUEST`, `LOST` |
| `OUTREACH_DRAFTED` | `CONTACTED`², `QUALIFIED`, `LOST` |
| `CONTACTED` | `RESPONSE`, `FOLLOW_UP`, `LOST` |
| `FOLLOW_UP` | `CONTACTED`², `RESPONSE`, `LOST` |
| `RESPONSE` | `QUALIFIED_OPPORTUNITY`, `FOLLOW_UP`, `LOST` |
| `QUALIFIED_OPPORTUNITY` | `QUOTE_REQUEST`, `FOLLOW_UP`, `LOST` |
| `QUOTE_REQUEST` | `QUOTE_SENT`, `LOST` |
| `QUOTE_SENT` | `NEGOTIATION`, `WON`, `LOST`, `FOLLOW_UP` |
| `NEGOTIATION` | `QUOTE_SENT`, `WON`, `LOST` |
| `LOST` | `FOLLOW_UP`³ |
| `WON` | – (Endzustand) |

¹ nur für Quellen vom Typ `INTERNAL_INBOUND` (Kunde fragt selbst an).
² nur durch einen **menschlichen** Akteur und nur, wenn mindestens ein nicht
gesperrter Kontakt existiert – das System versendet nichts automatisch.
³ Reaktivierung nur mit Begründung.
`LOST` erfordert immer eine Begründung. Jeder Übergang erzeugt einen Eintrag in
`lead_status_transition` **und** im Audit-Log. Direkte Status-Updates sind nicht möglich.

## 7. Einwilligungen – `consent`

Nur **Einwilligungen** werden hier gespeichert. Verarbeitungen auf anderer Rechtsgrundlage
(Vertrag, berechtigtes Interesse) werden **nicht** als Consent modelliert, sondern am
jeweiligen Datensatz (`legal_basis`) dokumentiert.

| Feld | Regel |
| --- | --- |
| `subject_type`, `subject_id` | `CUSTOMER` \| `LEAD_CONTACT` \| `USER` |
| `purpose` | `MARKETING_EMAIL` \| `MARKETING_PHONE` \| `COOKIES_ANALYTICS` \| `REVIEW_REQUEST` \| `REFERRAL_CONTACT` \| `OTHER_COMMUNICATION` |
| `legal_basis` | `GDPR_ART6_1A` \| `TDDDG_25_1` (Endgerätezugriff/Cookies) |
| `status` | `GRANTED` \| `WITHDRAWN` |
| `granted_at`, `withdrawn_at` | `WITHDRAWN` ⇒ `withdrawn_at` gesetzt |
| `source` | z. B. `WEBSITE_FORM`, `CUSTOMER_PORTAL`, `STAFF_RECORDED` |
| `text_version` | Version des Einwilligungstextes |
| `evidence_reference` | Verweis auf Nachweis (z. B. Formular-Submission-ID), keine Rohdaten |

Datensätze sind **unveränderlich**; ein Widerruf erzeugt einen neuen Datensatz mit
`status = WITHDRAWN`. Der wirksame Status ist der jüngste Datensatz je Subjekt und Zweck.

## 8. Settings – `setting`

Typisierte, versionierte Konfiguration – kein freies JSON:

| Feld | Regel |
| --- | --- |
| `key` | nur registrierte Keys (Registry im Code, je Key ein Zod-Schema) |
| `scope_type`, `scope_id` | `GLOBAL` (ohne ID) \| `SERVICE_AREA` \| `CUSTOMER` (mit ID) – pro Key erlaubte Scopes festgelegt |
| `version` | fortlaufend je (`key`, Scope) |
| `value` | jsonb, **vor dem Schreiben** gegen das Schema des Keys validiert |
| `effective_from`, `effective_until` | Gültigkeitszeitraum; Überschneidungen je Key/Scope per Exclusion-Constraint verboten |
| `created_by`, `updated_by`, `change_reason` | Pflicht; jede Änderung zusätzlich im Audit-Log |

Versionen werden nie überschrieben: Eine Änderung schließt die aktuelle Version
(`effective_until`) und legt eine neue an.

| Key | Scopes | Status |
| --- | --- | --- |
| `payment.policy` | `GLOBAL` | Tag 1 implementiert |
| `lead.scoring` | `GLOBAL` | Tag 1 implementiert |
| `service_area.defaults`, `pricing.*`, `tax.*`, `booking.rules`, `notification.*`, `operations.*` | je Key | Schema wird mit dem jeweiligen Modul eingeführt |

## 9. Audit-Log – `audit_log`

`occurred_at`, `actor_type` (`USER` \| `SYSTEM`), `actor_id`, `action`, `entity_type`,
`entity_id`, `before`, `after`, `correlation_id`. **Append-only** (DB-Trigger verhindert
`UPDATE`/`DELETE`). Felder mit Geheimnissen oder vollständigen Zahlungsdaten werden vor
dem Schreiben redigiert (`password`, `token`, `secret`, `iban`, `card*` …).

## 10. Identität und Zugriff

### 10.1 Rollen (Phase 1)

| Rolle | Zweck | Scope |
| --- | --- | --- |
| `SUPER_ADMIN` | Geschäftsführung/Inhaber | global |
| `ADMIN` | Administration, Vertrieb | global |
| `DISPATCHER` | Disposition, Kundenpflege | global |
| `FINANCE` | Rechnungen, Zahlungsrichtlinie | global |
| `STAFF` | Eigene Reinigungskräfte | eigene Einsätze (ab Tag 5) |
| `PARTNER` | Partnerbetrieb | eigener Partner (`partner_id`) |
| `CUSTOMER` | Privat- oder Gewerbekunde | eigener Kunde (`customer_id`) |

Rollenzuweisungen (`user_role`) tragen optional `customer_id`/`partner_id` und
`is_scope_admin` (B2B-Verantwortliche bzw. Partner-Inhaber dürfen innerhalb ihres Scopes
einladen). Die Rechte-Matrix ist **Code** (reviewbar, getestet) und wird in die Tabellen
`role`/`permission`/`role_permission` synchronisiert.

### 10.2 Authentifizierung (Better Auth 1.7.x)

| Anforderung | Umsetzung |
| --- | --- |
| E-Mail-Verifizierung | Pflicht vor erster Session (`requireEmailVerification`); Link gültig 1 h |
| Passwort-Reset | Token 30 min gültig, einmalig; alle Sessions werden beim Reset widerrufen |
| Passwort-Regeln | 12–128 Zeichen |
| Rate Limiting | pro IP, Datenbank-Speicher; strenge Regeln für Sign-in, Sign-up, Reset |
| Konto-Sperre | nach 5 Fehlversuchen in 15 min: 15 min gesperrt (konfigurierbar mit Untergrenzen) |
| Sessions | serverseitig in PostgreSQL, 7 Tage, Refresh täglich, kein Cookie-Cache (Widerruf wirkt sofort) |
| Session-Widerruf | eigene Sessions (Nutzer), alle Sessions eines Nutzers (`session:revoke_any`) |
| Einladungen B2B/Partner | Token 32 Byte zufällig, nur Hash gespeichert, 7 Tage gültig, einmalig; einladende Person kann nur Rollen vergeben, die sie selbst vergeben darf |
| Admin-MFA | TOTP über Better-Auth-Plugin `twoFactor`; Rollen `SUPER_ADMIN`, `ADMIN`, `FINANCE` erhalten **ohne** aktivierte MFA keine Berechtigung |
| Recovery | Backup-Codes (Plugin), Passwort-Reset nur per verifizierter E-Mail; Wiederherstellung von Admin-Konten ausschließlich durch einen zweiten `SUPER_ADMIN` mit Audit-Eintrag |
| E-Mail-Versand | Port `EmailSender`; ohne konfigurierten Anbieter startet die Auth **nicht** (fail closed) – es gibt keinen Fake-Versand im Produktionspfad |

## 11. Payment Risk – verbindliche Invarianten

Die Regeln aus PRODUCT_SPEC §6 sind konfigurierbar, aber der Validator der Richtlinie
`payment.policy` **lehnt unsichere Konfigurationen ab**:

| Invariante | Validierung |
| --- | --- |
| Rechnungskauf frühestens nach 3 erfolgreich abgeschlossenen **und** bezahlten Aufträgen | `minSuccessfulPaidOrders` ≥ 3 (Obergrenze 20) |
| Offene überfällige Rechnung ⇒ Vorkasse | `maxOpenOverdueInvoices` muss 0 sein; `revertToPrepaymentOnOverdue` muss `true` sein |
| Keine relevanten Chargebacks/Disputes | `maxChargebacksInLookback` muss 0 sein |
| Teilzahlung zählt nicht als bezahlt | `partialPaymentCountsAsPaid` muss `false` sein |
| Offene Dublettenprüfung ⇒ Vorkasse | `pendingDuplicateReviewForcesPrepayment` muss `true` sein |
| Rücklastschrift-Fristen | `settlementDays.SEPA_DIRECT_DEBIT` ≥ 56 (8 Wochen) |
| Zahlungsverzug | `latePaymentToleranceDays` 0–14, `maxLatePaymentsInLookback` 0–3 |
| Vertrauensbewertung | `minTrustScore` 50–100 |
| Kreditlimit | `defaultCreditLimitCents` 1–5 000 000 |

Fachliche Definitionen:

- **Erfolgreicher Auftrag:** Leistung erbracht **und** Rechnung vollständig bezahlt
  **und** Rückbuchungsfrist des Zahlungsmittels abgelaufen, ohne Erstattung/Chargeback.
- **Teilzahlung:** Rechnung bleibt offen; Auftrag zählt nicht.
- **Mahnstufen:** 0 = nicht fällig, 1 = überfällig (Zahlungserinnerung), 2 = 1. Mahnung,
  3 = 2. Mahnung/Inkasso-Prüfung. Ab Stufe 1 gilt für **neue** Aufträge Vorkasse.
- **B2B/B2C:** Rechnungskauf standardmäßig nur für `BUSINESS`; für `PRIVATE` nur, wenn
  `b2cInvoiceTermsAllowed = true`.
- **Wiederkehrende Aufträge:** Tritt Überfälligkeit auf, werden alle noch nicht
  ausgeführten Termine auf Vorkasse umgestellt und zur Prüfung markiert
  (keine automatische Kündigung).
- **Dubletten:** siehe §5 – neue Konten erben die Historie über eindeutige Merkmale;
  Signal-Treffer erzwingen Vorkasse bis zur Prüfung.

Die Entscheidungslogik (`evaluatePaymentTerms`) wird an Tag 6 implementiert; an Tag 1
existieren Richtlinien-Schema, Validator und die Dubletten-Erkennung.

## 12. LeadFinder – Provider-Vertrag

```text
LeadFinder
├── BusinessSearchProvider      (extern, deaktiviert bis ToS geprüft)
├── PublicOpportunityProvider   (extern, deaktiviert bis ToS geprüft)
├── WebsiteResearchProvider     (extern, deaktiviert bis ToS geprüft)
├── ReferralProvider            (intern)
└── InternalInboundProvider     (intern)
```

Jeder Provider deklariert: `providerId`, `providerKind`, `legalBasis`,
`termsReviewedAt`, `allowedUse`, `retentionDays`, `rateLimitPerMinute`, `enabled`,
`sourceMetadata`. Die Registry verweigert die Nutzung eines Providers, der deaktiviert ist
oder dessen Prüfnachweis fehlt.

`WebsiteResearchProvider`: nur öffentlich zugängliche Inhalte, `robots.txt` wird
beachtet, Rate Limit je Host, SSRF-Schutz (nur `http`/`https`, keine Zugangsdaten in URLs,
keine privaten/lokalen Adressen nach DNS-Auflösung), keine Login-, CAPTCHA- oder
ToS-Umgehung.

Keine automatische Massenansprache: Der höchste automatisch erreichbare Status ist
`OUTREACH_DRAFTED`; `CONTACTED` setzt eine menschliche Aktion voraus.
