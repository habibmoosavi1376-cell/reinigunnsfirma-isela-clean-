# ISELA CLEAN – Phase 1 / Tag 4: Kunden-CRM, Objekte, Adressen, Angebotsgrundlage

Stand: 2026-09-27 · Repository: `habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` ·
Branch: `phase-1-day-4` (von `phase-1-day-3` @ `39767a8`) · PR gegen `main` (gestapelt auf #4)

## 1. Ausgangszustand

| Prüfpunkt | Befund |
| --- | --- |
| Branch / HEAD | `phase-1-day-4`, erstellt von `phase-1-day-3` @ `39767a8`; Working Tree sauber |
| `main` | `29d82a9`, unverändert (auch nach Tag 4) |
| PR #1 / #2 / #3 / #4 | alle offen, nicht gemergt – nicht bearbeitet, nicht gemergt |
| CI auf PR #4 | alles grün außer „Dependency review“ (Dependency Graph deaktiviert, Owner-Einstellung) |
| Migrationen | 5 (`0000`–`0004`), kein Drift |
| Tests (Baseline, am Commit `39767a8` neu gemessen) | 496 Unit, 137 Integration, 11 E2E – alle grün |
| Schema | 36 Tabellen; `property` ohne Räume/Intervall/Status; keine Angebote; `customer_address` ohne Haupt-/Dublettenkennzeichen |

Stack: PR #1 → #2 → #3 → #4 → dieser PR. Keine Änderung an `main`, keine History-Rewrites,
kein Merge fremder PRs.

## 2. Änderungen

| Commit | Inhalt |
| --- | --- |
| `19c726c`, `0c060a3` | Fix: Einladung wird nicht angenommen, wenn die Rolle nicht vergeben werden konnte (+ Test) |
| `c426184` | Migration `0005`: Adressen (Haupt-/Dublettenschlüssel), Objekte, Anfrage ↔ Adresse/Objekt, Angebote |
| `18e136d` | `evaluatePaymentTerms` (reine Funktion) |
| `a926e0a` | RBAC: `quote:read`, `quote:write`, `quote:approve` |
| `a8354c7` | CRM: Kundenliste/-akte, Adress-/Objektverwaltung, Lead → Adresse/Objekt, Einladung, Identitäts-Lock |
| `8d1666e`, `d2d0018` | Paket `@isela/quotes`, Setting `quote.defaults` (+ Registry-Snapshot-Test) |
| `c8ee521` | Fix: Aggregationen der Kundenliste, PLZ-Prüfung je Land |
| `6b5b50d` | Integrations- und Security-Tests |
| `a0a8095`, `338c71e` | Web-UI (Kunden, Objekte, Angebote, Einladung, Lead-Aktionen) |
| `089aaec` | Fix: Loading-Boundary im Kundenbereich (HTTP 404 statt 200) |
| `85f5812` | E2E-Tests |
| `8452172` | Dokumentation (Status, Security, Architektur, Domänenmodell) |

Neues Paket `@isela/quotes`; neue Paketabhängigkeiten `crm → payment-risk, settings` und
`settings → quotes` (Allowlist der Modulgrenzen erweitert, kein Zyklus).

## 3. Customer CRM

- **`/admin/customers`:**
  - Suche nach Name, Firma, PLZ/Ort, exakter E-Mail (über den HMAC-Identitätshash, keine
    Klartext-E-Mail in der DB) oder Kunden-ID.
  - Filter: Kundenart, Status, Servicegebiet (PostGIS-Geometrie der Adressen oder
    zugeordnete Anfragen, keine Ortsnamen), Erstellungszeitraum.
  - Pagination max. 50.
  - Spalten: Ort, Lead-Anzahl, Objekt-Anzahl, offene Vorgänge (offene Leads, offene
    Angebote nur mit `quote:read`), letzte Aktivität.
  - Keine E-Mail/Telefon in der Liste.
- **`/admin/customers/[id]`:**
  - Stammdaten inkl. registrierter Identitätsarten (nur Art, nie Wert).
  - Zahlungsstatus mit Begründungen und Richtlinienversion.
  - Kontaktpersonen: verknüpfte Konten; E-Mail nur mit `customer:update`. Kontakte aus
    Anfragen nur mit `lead_contact:read`.
  - Adressen (Typ, Haupt, Geocoding, Servicegebiet, Prüfstatus) und Objekte.
  - Anfragen/Leads (`lead:read`), Angebote (`quote:read`), Consent (`consent:read`),
    Audit-Historie (`audit:read`).
- **Aktionen:** Stammdaten, Adresse anlegen/ändern/als Haupt, Objekt anlegen/ändern/
  (de)aktivieren, Angebotsentwurf.
- **Aufträge/Rechnungen:** Es gibt noch keine Tabellen. Die Akte zeigt dazu kein leeres
  Scheinmodul, sondern einen sachlichen Hinweis im Zahlungsstatus („noch nicht im System
  geführt → Vorkasse“).
- **Interne Notizen:** Am Kunden gibt es bewusst kein Notizfeld, weil noch kein
  abgesichertes Modell existiert (Zugriff, Löschfristen). Interne Notizen gibt es nur an
  Objekt und Angebot, sichtbar nur mit den jeweiligen Staff-Rechten.
- **Zugriff:** Beide Seiten und Services verlangen GLOBAL `customer:read`. CUSTOMER, STAFF
  und PARTNER erhalten `FORBIDDEN`. FINANCE liest und darf keine Stammdaten ändern.
- **Lesemodell:** Seite in einer Abfrage, Kennzahlen in 5 gruppierten Abfragen über die IDs
  der Seite (max. 50).
- **Keine Fake-Daten:** leere Zustände werden als solche benannt.

## 4. CustomerAddress

- **Typen:** `SERVICE` (Objekt-/Serviceadresse), `BILLING`, `OTHER` sowie `is_primary`
  (höchstens eine aktive Hauptadresse je Kunde, partieller Unique-Index). Mehrere Adressen je
  Kunde decken B2B mit mehreren Standorten ab.
- **Aus der Anfrage (Lead → Kunde):** `ensureAddressFromRequest` sucht eine gleichwertige
  aktive `SERVICE`-Adresse desselben Kunden über `normalizeAddress`, auch bei Altzeilen ohne
  Schlüssel.
  - Treffer: die Adresse wird wiederverwendet.
  - Sonst neue Adresse mit `normalized_key`; die erste wird Hauptadresse.
  - Race-sicher über `ON CONFLICT DO NOTHING` auf dem Unique-Index und erneutes Lesen.
- **Browser-Eingaben:** Die Kunden-ID stammt aus der verknüpften Anfrage, nie aus dem
  Browser.
- **Koordinaten:** Nur aus Anfragen mit Status `SUCCEEDED`/`MANUAL` (serverseitiges
  Geocoding bzw. menschliche Bestätigung), sonst `PENDING`. Formulare und Update-API nehmen
  keine Koordinaten an (strict schema). Eine Lageänderung setzt die Koordinaten zurück.
- **Eigentum:** Adress-ID der Anfrage wird per Trigger `service_request_owner` auf denselben
  Kunden geprüft; Update/Haupt-Setzen leitet den Eigentümer aus der Adresse ab.
- **Dubletten beim manuellen Anlegen:** werden gemeldet (`duplicateOfAddressId`), nicht
  verhindert. Der Tag‑1‑Vertrag, dass ein Kunde dieselbe Adresse erneut erfassen darf, bleibt
  unverändert.
- **Audit:** `customer_address.created` (mit Quelle), `.updated` (nur Feldnamen),
  `.primary_changed`, `lead.address_linked`.

## 5. Property

- **Felder:** Kunde, Adresse (derselbe Kunde: Service-Prüfung + Trigger
  `property_address_owner`), Name, Objektart, Fläche, Räume, Bäder, Intervall,
  Leistungsanforderungen, Notiz, aktiv/inaktiv, Zeitstempel. CHECKs für Wertebereiche und
  Textlängen.
- **Objektarten:** `PRIVATE_HOME`, `APARTMENT`, `OFFICE`, `PRACTICE`, `STAIRWELL`, `RETAIL`,
  `GASTRONOMY`, `GYM`, `HOLIDAY_RENTAL`, `COMMERCIAL`, `PROPERTY_MANAGEMENT` sowie das
  bestehende `OTHER`.
  - `HOUSE` wurde per `RENAME VALUE` zu `PRIVATE_HOME` (Formular-Label „Haus (privat)“
    unverändert).
- **Hausverwaltung:** beliebig viele Objekte je Kunde mit eigenen Adressen und Intervallen,
  Abrechnung zentral über den Kunden. Keine ortsspezifische Logik.
- **Objektsuche `/admin/properties`:** GLOBAL `property:read`, Filter Objektart/Status,
  escapte Suche, Pagination.
- **Audit:** `property.created`, `property.updated` (Feldnamen, aktiv-Flag).

## 6. Lead → Customer → CustomerAddress → Property

1. **`linkLeadToCustomer`** (Tag 3, erweitert):
   - Findet bestehende Kunden über eindeutige Identitäten (E-Mail, Steuer-ID,
     Zahlungsreferenz) und verknüpft danach die Adresse.
   - Die Historie wird nie zurückgesetzt.
   - Ein Identitätskonflikt (Merkmale zweier Kunden) → `CONFLICT`.
   - Rückgabeform unverändert (Tag‑3-Tests nutzen `toEqual`).
2. **Nebenläufigkeit:**
   - `registerCustomerInTransaction` nimmt je eindeutigem Identitätshash einen
     `pg_advisory_xact_lock`; die Locks werden sortiert genommen (kein Deadlock).
   - Der Unique-Index bleibt die letzte Verteidigung.
   - Getestet: 4 parallele Registrierungen und 2 parallele Lead-Verknüpfungen derselben
     E-Mail erzeugen genau einen Kunden.
3. **Zahlungshistorie:**
   - Neue Anfrage mit bekannter E-Mail eines gesperrten Kunden → derselbe Kunde, Status
     `BLOCKED`, `PREPAYMENT`.
   - Kein neuer Datensatz; getestet.
4. **`createPropertyFromLead`:**
   - Sperrt die Anfrage (`FOR UPDATE`) und ist idempotent (`ALREADY_CREATED`).
   - Setzt Kunde und Adresse voraus und übernimmt Objektart, Fläche und Intervall.
   - Audit: `property.created` (Quelle Anfrage), `lead.property_linked`.
5. **Transaktionen:** Kunde, Identitäten, Adresse, Anfrageverknüpfung und Audit liegen in
   einer Transaktion.

## 7. Invitation

- **Aktion:** „Kundenkonto einladen“ auf der Lead-Seite (`inviteLeadContact`).
- **Berechtigung:** nur `customer:link_account` (ADMIN/SUPER_ADMIN, MFA-pflichtig).
  DISPATCHER und FINANCE → `FORBIDDEN` (getestet).
- **Voraussetzungen:**
  - Lead ist mit einem Kunden verknüpft.
  - Kontakt hat eine E-Mail und ist nicht gesperrt (Widerspruch → `POLICY_VIOLATION`).
  - Die E-Mail ist eine registrierte Identität genau dieses Kunden. Sonst
    `POLICY_VIOLATION`, z. B. bei einem Lead, der über die Steuer-ID einem Kunden mit
    anderer E-Mail zugeordnet wurde.
  - Kein bereits verknüpftes Konto.
- **Token:** vorhandener Flow `createInvitation`.
  - 32 Byte `randomBytes`, base64url; in der DB nur der SHA-256-Hash.
  - 7 Tage gültig, einmalig; Rollenvergabe über `assertCanGrantRole`.
  - Ältere offene Einladungen für dieselbe Adresse/Kunde werden widerrufen
    (`auth.invitation_revoked`).
- **Rate-Limit:** 3/Tag je Kunde, 20/h je Mitarbeitendem. Schlüssel sind HMAC-gehasht, keine
  PII in der Rate-Limit-Tabelle.
- **Versand:** über den konfigurierten SMTP-Sender (kein Fake-Versand); Link
  `${APP_BASE_URL}/account/invitation?token=…`.
- **Annahme:** `/account/invitation` nur für angemeldete Konten, explizit per POST (GET nimmt
  nie an), `Referrer-Policy: no-referrer`, der Token kommt nie in die Ergebnis-URL.
  - Ungültig/abgelaufen/benutzt/fremde E-Mail ergeben dieselbe Meldung (keine Enumeration).
- **Befund B1 (behoben):** Die Annahme nutzte `ON CONFLICT DO NOTHING`. Das verschluckte die
  Regel „ein Kunde je Konto“, und die Einladung galt als angenommen, ohne dass die Rolle
  vergeben war. Jetzt wird die exakte Zuordnung geprüft, sonst `CONFLICT` und vollständiger
  Rollback.
- **Getestet:** Wiederverwendung, abgelaufener Token, widerrufener alter Token, Rate-Limit,
  Konflikt.
- **Logs:** nur Ereignis und Fehlercode, keine E-Mail-Adressen oder Tokens.

## 8. Quote Foundation

- **Tabellen:** `quote`, `quote_item`, `quote_status_transition` (append-only per Trigger).
  - Beträge in Cent; CHECK Brutto = Netto + Steuer.
  - `SENT` und später nur mit Gültigkeit und `sent_at`.
  - Positionsnummer eindeutig; Menge > 0 mit 3 Nachkommastellen.
  - Steuersatz 0–10 000 Basispunkte.
- **State Machine:**
  - Übergänge: `DRAFT → PENDING_REVIEW | CANCELLED`,
    `PENDING_REVIEW → DRAFT | SENT | CANCELLED`,
    `SENT → ACCEPTED | DECLINED | EXPIRED | CANCELLED`.
  - Endzustände ohne Ausgang; kein `DRAFT → SENT`.
  - Guards: Positionen für Prüfung/Freigabe; Gültigkeit nicht in der Vergangenheit; keine
    Annahme nach Ablauf; `EXPIRED` erst nach Ablauf.
  - Begründung Pflicht für `ACCEPTED`/`DECLINED`/`CANCELLED`; System darf nur `EXPIRED`.
- **Keine direkten Statuswrites:**
  - Alle Änderungen laufen über `transitionQuote`/`expireQuotes`: Zeilensperre plus
    Statusbedingung im `UPDATE`, Transition-Log und Audit `quote.status_changed`.
  - Bearbeitung nur im Entwurf.
- **Keine automatische Preiszusage:**
  - Preise erfasst berechtigtes Personal manuell; der Server rechnet (BigInt, half-up,
    Steuer je Satz auf die Nettosumme).
  - Freigabe nur mit `quote:approve`, optional Vier-Augen-Prinzip (`requireFourEyesApproval`).
  - Es gibt keinen E-Mail-Versand von Angeboten: „freigegeben“ macht das Angebot im
    Kundenbereich sichtbar.
  - Die Online-Annahme durch Kunden ist bewusst nicht gebaut (Vertragsschluss, rechtliche
    Prüfung); die Annahme wird von Mitarbeitenden mit Nachweis erfasst.
- **Konfiguration `quote.defaults`** (versioniertes Setting): USt-Sätze 19/7/0 %,
  Standard 19 %, Gültigkeit 30 Tage, max. 50 Positionen, Vier-Augen aus, Zeitzone.
- **Pricing Engine:** nur Schnittstelle.
  - `PricingEngine.propose(PricingInput)` mit strikt validierten Eingaben (Leistung, Objekt,
    m², Räume, Bäder, Fenster, Intervall, Extras, Dringlichkeit, Entfernung, Region,
    Arbeitszeit, Direktkosten).
  - `PricingProposal` mit Netto, Steuer, Brutto, Arbeitszeit, Direktkosten,
    Deckungsbeitrag, Tarifversion und `requiresReview: true`.
  - Dazu `contributionMargin` mit konfiguriertem Stundensatz als Eingabe.
  - Kein Algorithmus und keine Preise im Code, weil keine freigegebenen Tarifdaten
    existieren.
- **UI:** `/admin/quotes` (Liste, Statusfilter), `/admin/quotes/[id]` (Übersicht mit Steuer
  je Satz, Positionen, Angebotsdaten, Statusaktionen je Berechtigung, Verlauf),
  `/customer/quotes[/id]` (nur eigene, freigegebene Angebote, ohne interne Daten).

## 9. Security

| Anforderung | Umsetzung | Nachweis |
| --- | --- | --- |
| Kunde sieht keine fremden Angebote | `getQuote`/`listQuotes` über `scopeFilterFor`; fremd/Entwurf/Prüfung → `NOT_FOUND`; erzwungener `customerId`-Filter wirkungslos | Integration „customers only see own released quotes“, E2E 404 |
| Mitarbeitende nur erlaubte | Staff-Operationen verlangen GLOBAL-Recht; Freigabe `quote:approve` | Integration (DISPATCHER/FINANCE → `FORBIDDEN` bei Freigabe) |
| FINANCE: Finanzdaten, keine Stammdaten | `quote:read`, `customer:read`; kein `customer:update`/`property:write`/`quote:write` | Unit (Matrix), Integration |
| PARTNER/STAFF ohne Angebote/Kunden | keine Rechte | Unit, Integration, E2E |
| Keine `customerId`/`ownerId`/`createdBy`/Preise/Rollen aus dem Browser | strict schemas; Eigentümer aus Datensatz; Beträge serverseitig | Integration „mass assignment“ (createdBy, status, net/gross, customerId bei Update) |
| QuoteItems serverseitig validiert | Kategorie aktiv, Leistung gehört zur Kategorie und hat dieselbe Einheit, Steuersatz aus Konfiguration, Grenzen | Unit (Arithmetik-Grenzen), Integration |
| IDOR Adresse/Objekt/Angebot | Eigentümer aus DB; Trigger als Backstop | Integration (Kunde B ändert Objekt/Adresse A → `FORBIDDEN`; fremde IDs → `NOT_FOUND`; direkte DB-Manipulation → `23503`) |
| Privilege Escalation | Einladung nur `customer:link_account`; Rollenvergabe `assertCanGrantRole` | Integration |
| Payment-History-Bypass | Identitätsauflösung auf Bestandskunden; gesperrt → Vorkasse | Integration |
| Token-Wiederverwendung/Ablauf | Hash, Einmaligkeit, Ablauf, Widerruf | Integration, E2E |
| SQL-Injection/LIKE | parametrisierte Drizzle-Ausdrücke, Wildcards escaped, unbekannte Parameter abgewiesen | Integration (`%` literal, `orderBy`-Injection → `VALIDATION_FAILED`) |
| Keine PII in Logs/Audit | Audit nur Feldnamen/IDs/Beträge; Logger ohne PII | Code-Review |
| XSS/Ausgaben | React-Escaping, Ergebniscodes aus Whitelist | Unit (`crmNoticeText`/`crmErrorText`) |

RBAC-Matrix nur um `quote:read`/`quote:write`/`quote:approve` erweitert. Bestehende Rechte
wurden nicht verändert.

## 10. Migrationen

`0005_customer_property_quotes.sql`:

- **Neu:** Enum `quote_status` (neuer Typ, keine Neuerstellung eines bestehenden).
- **Neue Tabellen:** `quote`, `quote_item`, `quote_status_transition`.
- **Neue Spalten:**
  - `customer_address`: `is_primary`, `normalized_key`.
  - `property`: `rooms`, `bathrooms`, `service_frequency`, `service_requirements`, `notes`,
    `active`.
  - `service_request`: `customer_address_id`, `property_id`.
- **Weiteres:** neue Indizes/CHECKs; Trigger `quote_status_transition_append_only`,
  `quote_property_owner`, `service_request_owner`.
- **Enum `property_type`:**
  - drizzle-kit erzeugte `DROP TYPE`/`CREATE TYPE` mit Spalten-Casts (Befund B5).
  - Von Hand ersetzt durch `ALTER TYPE … RENAME VALUE 'HOUSE' TO 'PRIVATE_HOME'` und
    `ADD VALUE` für die neuen Werte. Das bereits existierende `request_frequency` wird
    wiederverwendet.
- **Prüfung:**
  - Keine `DROP`, `TRUNCATE`, `SET DATA TYPE` oder Enum-Neuerstellung (per `grep`
    geprüft).
  - `db:check`: Schema und Migrationen synchron.
- **Upgrade-Test:** Eine Datenbank auf Stand `0004` mit Bestandszeilen vom Typ `HOUSE` wurde
  auf `0005` migriert. Die Zeilen blieben erhalten und lauten `PRIVATE_HOME`.
- **Bestehende Tests:** Tag‑1-Tests enthalten `HOUSE` als Datenwert; in
  `db-constraints.test.ts` (1×) und `crm-security.test.ts` (2×) wurde nur der Literalwert auf
  `PRIVATE_HOME` geändert. Keine Assertion geändert.
- **Ergebnis:** 39 Tabellen, 6 Migrationen.
- **pg_trgm:** gemessen, aber nicht eingeführt.
  - Aufbau: 200 000 synthetische Kunden plus Adressen in einer temporären Bench-Datenbank,
    danach gelöscht.

  | Variante | Ohne Trigram | Mit Trigram-GIN (4 Indizes) |
  | --- | --- | --- |
  | aktuelle Abfrage (OR + EXISTS), Seite | ≈ 380 ms | ≈ 290–360 ms (Planer nutzt Indizes für `customer` nicht) |
  | UNION-Umbau, selektive Suche | ≈ 115 ms | ≈ 0,8 ms |
  | UNION-Umbau, unselektive Suche | ≈ 350 ms | ≈ 150 ms |
  | Indexgröße | – | 52 MB (Tabellen: 27 + 28 MB) |

  - Nutzen entsteht erst mit Abfrage-Umbau und großem Bestand; beim Startvolumen nicht
    messbar relevant.
  - Einführung, sobald > 50 000 Kunden oder p95 der Kundensuche > 200 ms (dokumentiert in
    `ARCHITECTURE.md` §2.5).

## 11. Tests

| Suite | Baseline Tag 3 | Tag 4 | Neu |
| --- | --- | --- | --- |
| Unit (inkl. Web-Unit) | 496 | **594** | +98 |
| Integration (PostgreSQL + PostGIS) | 137 | **166** | +29 |
| E2E (Playwright, Produktions-Build) | 11 | **13** | +2 |

Keine Tests gelöscht, deaktiviert, übersprungen oder abgeschwächt (`.skip`/`.only`/`.todo`:
keine; 0 pending). Per Datei hat keine bestehende Testdatei Fälle verloren.

**Neue Tests:**

- **Unit `test/unit/quotes.test.ts` (63):**
  - Alle unzulässigen Übergänge (parametrisiert), Endzustände, kein `DRAFT → SENT`.
  - Guards: Positionen, Gültigkeit, Vier-Augen, Ablauf, System nur `EXPIRED`,
    Pflichtbegründung, Freigaberecht.
  - RBAC-Matrix für Angebote.
  - Cent-Arithmetik: half-up, Float-Fallen, Steuer je Satz, Grenzen, Maximalwerte.
  - Deckungsbeitrag, Pricing-Input strikt, Konfiguration inkl. Zeitzone.
- **Unit `test/unit/payment-terms.test.ts` (14):**
  - Neukunde, Auftrag 1/2 Vorkasse, Rechnungsprüfung erst ab 3 bezahlten Aufträgen.
  - Manuelle Freigabe; überfällig/Chargeback/gesperrt/Dublette/Trust/Limit.
  - Viele bezahlte Aufträge heben Überfälligkeit nicht auf; B2C-Schalter; ungültige
    Historie.
- **Unit `apps/web/tests/unit/crm-ui.test.ts` (17):** Geld-/Mengen-Parsing inkl.
  Ablehnungen, Listenparameter über Domänenschema, Whitelist der Ergebniscodes.
- **Unit `admin.test.ts` (+1):** Modulsichtbarkeit je Rolle.
- **Unit `rbac-policy.test.ts` (+3):** parametrisiert über die neuen Rechte.
- **Integration `customer-crm.test.ts` (19):**
  - Lead → Kunde → Adresse (Wiederverwendung, zweiter Standort).
  - Parallele Registrierung/Verknüpfung.
  - Gesperrter Kunde (History-Bypass); Trigger gegen fremde Adresse.
  - Hauptadresse, Lageänderung/PLZ je Land/Koordinaten-Mass-Assignment, Adress-IDOR.
  - Lead → Objekt (idempotent, Voraussetzungen, Rechte), mehrere Objekte, fremde
    Adresse/Objekt/Mass Assignment/Kunde B.
  - Kundenliste (E-Mail-Hash, Name, ID, Wildcards, Pagination, Injection), Servicegebiet per
    Geometrie, Zugriff/Feldsichtbarkeit je Rolle.
  - Einladung (Hash, Ablauf, Widerruf, Wiederverwendung, Konflikt, Identitätsprüfung,
    Rechte, Rate-Limit).
- **Integration `quotes.test.ts` (9):**
  - Serverseitige Summen und Persistenz; Mass Assignment; fremde Objekte/Leads inkl.
    DB-Backstop.
  - Lebenszyklus mit Rechten und Append-only; Vier-Augen; parallele Übergänge.
  - Systemablauf; Kundensicht/IDOR; FINANCE/STAFF/PARTNER.
- **Integration `invitation-conflict.test.ts` (1):** Befund B1.
- **E2E `admin-customers.spec.ts` (2):**
  - Dispatcher: Anfrage → Lead → Kunde → Objekt aus Anfrage → Kundenliste (Suche,
    `aria-current`, keine E-Mails) → Kundenakte (Hauptadresse, Objekt, Vorkasse) → zweites
    Objekt → serverseitige Fehlermeldung.
  - Angebotsentwurf mit Position (82,25 € netto / 97,88 € brutto) → Prüfung, keine Freigabe
    ohne Recht → 404 für unbekannte IDs.
  - Eingeladenes Konto nimmt per POST an, Wiederverwendung abgelehnt, danach als Kunde 403
    auf CRM-Seiten und 404 auf fremdes Angebot.

**Angepasste bestehende Tests** (Erweiterung, keine Abschwächung):

- `settings-validation.test.ts`: Der Registry-Snapshot enthält jetzt zusätzlich
  `quote.defaults`.
- `admin.test.ts`: Die Liste der aktiven Module umfasst jetzt die implementierten Module
  Kunden/Objekte/Angebote; „Rechnungen“ und neu „Aufträge“ werden weiterhin als inaktiv
  geprüft.
- Die zwei Tag‑1-Fixtures mit `PRIVATE_HOME` sind in §10 beschrieben.

**Regression Request → Lead → Geocoding → ServiceArea:** alle Tag‑3-Tests unverändert grün
(`geocoding-flow`, `crm-backoffice`, `customer-linking`, `service-requests`, E2E
`request-form`, `admin-leads`).

## 12. CI

Lokal ausgeführt, alle grün:

- Typecheck, Lint (ESLint strict + Prettier), Unit, Integration, E2E (Produktions-Build).
- Paket-Build (`tsc`) und Web-Build (`next build`) mit Client-Bundle-Scan (Canary-Werte,
  keine Server-Secrets im Client).
- `db:check` (kein Drift), Modulgrenzen, Hardcoding-Guard, Forbidden-Files-Guard.
- `pnpm audit` (0 Schwachstellen), Lizenzen (199 Pakete erlaubt).
- markdownlint (0), actionlint.
- gitleaks:
  - Git-Historie: 0 Funde.
  - Getrackte Dateien: 0 Funde.
  - Der Verzeichnis-Scan meldet nur Funde in der gitignorierten Build-Ausgabe
    `apps/web/.next/` (generierte Next-Schlüssel, gebündelte Bibliotheks-Strings).

CI-Workflows unverändert; die neuen Tests laufen in den bestehenden Jobs. „Dependency review“
bleibt aktiv und scheitert nur an der Owner-Einstellung „Dependency Graph“. Es wurde nichts
umgangen. Das Ergebnis des CI-Laufs auf dem PR steht in §12.1.

### 12.1 CI-Lauf auf dem PR

PR #5, Head `2958ad5` (Push- und Pull-Request-Lauf), grün:

- Typecheck/Lint/Unit/Build und Integration (PostGIS).
- E2E (Playwright, Produktions-Build).
- Web-Build mit Client-Bundle-Scan.
- Secret-Scan (gitleaks), Repo-Guard.
- Markdown- und Workflow-Lint, Audit/Lizenzen.
- CodeQL (Analyse und Check).

„Dependency review“ schlägt mit `Dependency review is not supported on this repository.
Please ensure that Dependency graph is enabled` fehl. Das ist die Owner-Einstellung, wie auf
den PRs 2–4. Der Check wurde nicht umgangen; ein Kommentar auf dem PR dokumentiert das.

## 13. Bugs gefunden und behoben

| # | Befund | Schwere | Behebung |
| --- | --- | --- | --- |
| B1 | `acceptInvitation`: `ON CONFLICT DO NOTHING` verschluckte den Unique-Index „ein Kunde je Konto“; die Einladung wurde als angenommen markiert, ohne dass die Rolle vergeben war (stiller Fehlzustand) | hoch | exakte Zuordnung prüfen, sonst `CONFLICT` + Rollback; Regressionstest |
| B2 | Kundenliste: Drizzle rendert Spalten in Einzeltabellen-Selects ohne Tabellenpräfix; korrelierte Unterabfragen waren mehrdeutig (Fehler 42702) und hätten bei anderer Spaltenkonstellation still an die falsche Tabelle gebunden | hoch (vor Auslieferung durch Tests gefunden) | gruppierte Aggregatabfragen über die Seiten-IDs; Adress-Servicegebietsabfrage per Join qualifiziert |
| B3 | `updateCustomerAddress` prüfte die PLZ fest gegen „DE“ statt gegen das Land der Adresse | niedrig | Prüfung gegen gespeichertes Land |
| B4 | Loading-Boundary `app/customer/loading.tsx` ließ `notFound()` mit HTTP 200 streamen (gleiche Klasse wie Tag‑3-B1) | mittel | bestehende Seiten per `git mv` in Route-Group `(area)` mit Boundary; Angebotsdetail außerhalb; E2E prüft 404 |
| B5 | drizzle-kit erzeugte für `property_type` `DROP TYPE`/`CREATE TYPE` | hoch (Migration) | `RENAME VALUE`/`ADD VALUE`; Upgrade mit Bestandsdaten getestet |
| B6 | E2E-Erweiterung überschritt mit zusätzlichen Testkonten das Sign-up-Rate-Limit (5/min) und ließ Folgetests scheitern | – (Testaufbau) | weniger Sign-ups (einladende Person als credential-lose Testdatenzeile, Kundenprüfungen mit dem eingeladenen Konto); Limit unverändert |

Kein kritischer Security-, Auth- oder Datenbankfehler offen.

## 14. Offene Punkte

1. **Zahlungsrisiko – dokumentierte Lücke:**
   - Aufträge, Rechnungen, Zahlungen, Rücklastschriften und der Trust-Score existieren noch
     nicht. `evaluatePaymentTerms` rechnet daher mit leerer Historie → immer Vorkasse
     (fail-safe).
   - Nicht umgesetzt, weil ohne Datenbasis nicht sicher möglich: Anbindung an echte
     Auftrags-/Rechnungsdaten, Rückstufung bei Überfälligkeit, Mahnstufen, Umstellung
     wiederkehrender Aufträge. Das folgt an Tag 5/6.
   - Nicht simuliert.
2. **Preis-Engine:** nur Vertrag; Tarifdaten (Stundensätze, Flächenpreise, Zuschläge,
   Regionen) muss der Inhaber liefern und freigeben. Bis dahin manuelle Preise.
3. **Steuersätze und Gültigkeit** in `quote.defaults` durch Inhaber/Steuerberatung
   bestätigen. Kleinunternehmerregelung/Reverse-Charge sind nicht modelliert.
4. **Angebotsversand/Online-Annahme:** kein E-Mail-Versand von Angeboten und keine
   Online-Annahme. Vertragsschluss, AGB und Widerrufsbelehrung (B2C) brauchen eine
   rechtliche Prüfung.
5. **Vier-Augen-Freigabe:** standardmäßig aus (Einzelinhaber-tauglich); Inhaber entscheidet.
6. **Interne Kundennotizen:** bewusst nicht gebaut (Löschkonzept/Zugriff fehlen).
7. **pg_trgm:** siehe §10, Schwellwerte dokumentiert.
8. **LeadFinder:** an Tag 4 unverändert (modular, ohne Provider, nichts aktiv). Kein
   Scraping, keine automatische Ansprache.
9. **SEO:** keine öffentlichen Routen geändert; robots/sitemap/Canonical/Metadaten
   unverändert (E2E `public-site` grün). Alle neuen Bereiche sind geschützt und `noindex`.
   Das Landingpage-Modell wurde nicht genutzt (keine Route).
10. **Repository (Owner):** Dependency Graph aktivieren, Branch-Schutz, PRs #1 → #5 in
    Reihenfolge prüfen und mergen.

## 15. Risiken

- **Gestapelte PRs** (#1 → #5) erschweren das Review; Merge nur in dieser Reihenfolge.
- **`ALTER TYPE … ADD VALUE`** ist nicht per Down-Migration umkehrbar (PostgreSQL kann
  Enum-Werte nicht entfernen). Die neuen Werte sind harmlos, siehe §16.
- **Suche im großen Bestand:** Die OR/EXISTS-Suche skaliert linear (≈ 380 ms bei 200 000
  Kunden); Gegenmaßnahme dokumentiert.
- **Rechtliches:** Angebote enthalten noch keine AGB-/Widerrufs-Texte. Freigegebene Angebote
  sind für Kunden sichtbar, aber nicht online annehmbar.
- **Serverlog:** Beim E2E-Lauf erschien einmal „The destination stream closed early“ von
  `next start`. Es tritt auf, wenn der Browser während eines laufenden RSC-Streams
  weiternavigiert. Im Einzellauf nicht reproduzierbar, kein Testfehler, keine
  Funktionsauswirkung; bei Häufung zu beobachten.
- **`experimental.authInterrupts`** (seit Tag 2) bleibt ein Upgrade-Risiko.

## 16. Rollback

1. **Code:** den PR nicht mergen bzw. per Revert zurücknehmen. Tag 3 (`39767a8`) bleibt
   unverändert lauffähig.
2. **Datenbank:** Migration `0005` ist additiv. Bevorzugt ist Forward-Fix bzw. Code-Rollback;
   neue Tabellen und Spalten bleiben dann ungenutzt.
3. **Vollständiger Rückbau** (nur nach Backup und wenn keine Angebote/Objektdaten erhalten
   bleiben müssen), manuell in einer Transaktion:
   - Trigger `service_request_owner`, `quote_property_owner`,
     `quote_status_transition_append_only` und ihre Funktionen entfernen.
   - Tabellen `quote_status_transition`, `quote_item`, `quote` sowie Typ `quote_status`
     entfernen.
   - Neue Spalten und Indizes an `service_request`, `property`, `customer_address`
     entfernen.
   - `ALTER TYPE property_type RENAME VALUE 'PRIVATE_HOME' TO 'HOUSE'`.
   - Hinzugefügte Enum-Werte bleiben bestehen; zuvor prüfen, dass keine Zeile sie nutzt.
   - Den Eintrag `0005` aus `drizzle.__drizzle_migrations` entfernen.
4. **Setting `quote.defaults`:** nur Default im Code; ohne gespeicherte Werte ist nichts
   zurückzurollen.
5. **Produktionsdaten:** Es werden keine Produktionsdaten gelöscht; es existiert noch keine
   Produktionsumgebung.

## 17. Nächster Schritt

1. **Owner:** Review dieses Reports und der PRs #1 → #5, Dependency Graph aktivieren,
   Tarifdaten und Steuersätze bestätigen, Vier-Augen-Entscheidung, rechtliche Prüfung für
   Angebotsannahme/AGB.
2. **Tag 5** (ROADMAP): Aufträge, Mitarbeitende, Partnerprüfung, Zuweisung, Checklisten.
   Angenommenes Angebot → Auftrag; damit entsteht die Datenbasis, an die Tag 6 die
   Zahlungshistorie anbindet.
3. Erst nach Freigabe dieses Reports fortfahren.
