# ISELA CLEAN – Phase 1 / Tag 3: Geocoding, CRM-Backoffice, Lead-Management

Stand: 2026-09-27 · Repository: `habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` ·
Branch: `phase-1-day-3` · PR: #4 (gegen `main`)

## 1. Ausgangszustand

| Prüfpunkt | Befund |
| --- | --- |
| Branch / HEAD | `phase-1-day-3`, erstellt von `phase-1-day-2` @ `f971307`; Working Tree sauber |
| `main` | `29d82a9`, unverändert |
| PR #1 / #2 / #3 | alle offen, nicht gemergt – nicht bearbeitet |
| CI auf PR #3 | alles grün außer „Dependency review“ (Dependency Graph deaktiviert, Owner-Einstellung) |
| CodeQL | grün |
| Migrationen | 4 (`0000`–`0003`), kein Drift |
| Tests | 394 Unit, 99 Integration, 9 E2E – alle grün |
| Schema | 34 Tabellen; `service_request.service_area_status` = `UNKNOWN`/`IN_AREA`/`OUTSIDE`, immer `UNKNOWN` (kein Geocoding) |

Stack: PR #1 → #2 → #3 → #4 (dieser). Keine Änderung an `main`, keine History-Rewrites.

## 2. Geocoding-Entscheidung

Recherche vom 2026-09-27 über Websuche; die Anbieterseiten selbst waren im Container
durch die Netzwerk-Policy gesperrt. Die Angaben sind vor Vertragsabschluss gegen die
aktuellen AGB/AVV zu prüfen.

| Kriterium | Geoapify | OpenCage | HERE | Mapbox | Google | Nominatim (OSMF) | BKG (amtlich) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sitz / Datenhaltung | GmbH, Deutschland; EU-Rechenzentren | GmbH, Deutschland; Hosting Hetzner (DE) | NL; global | USA | USA | UK/Stiftung, Freiwilligenbetrieb | Bundesbehörde |
| DSGVO / AVV | AVV (Art. 28) veröffentlicht, Verarbeitung in EU/EWR | EU-Firma; Parameter `no_record` | Enterprise-Verträge | US-Transfer | US-Transfer | keine AVV | behördlich |
| Ergebnisse speichern | erlaubt (Attribution) | dauerhaft erlaubt | Standard: max. 30 Tage | nur „Permanent“ (5 $/1000) | nur 30 Tage Cache | Cache-Pflicht, Heavy Use verboten | lizenzpflichtig |
| Kommerzielle Nutzung | auch im Free-Plan (Attribution) | ja | ja | ja | nur mit Google-Maps-Kontext | nur moderat, keine Heavy Uses | gegen Gebühr (V ZSGT) |
| Kosten (Einstieg) | Free 3 000/Tag; ab ca. 59 $/Monat | Free-Trial 2 500/Tag; Pläne | 30 000/Monat frei | 100 000/Monat frei (temporär) | Pay-as-you-go | kostenlos | auf Anfrage |
| Rate Limit | Free 5 req/s, bezahlt bis 30 req/s | Trial 1 req/s, bezahlt 15–40 req/s | ca. 5 req/s (Freemium) | planabhängig | planabhängig | max. 1 req/s | – |
| DE/NRW-Abdeckung | OSM + OpenAddresses; in Städten nahe Gebäudegenauigkeit | OSM-basiert | sehr gut | gut | sehr gut | OSM | amtliche Hauskoordinaten (beste Genauigkeit) |
| Qualitätssignale | `result_type`, `rank.confidence_building_level`, `match_type` | `confidence` = Größe der Bounding Box (**kein** Genauigkeitsmaß), `_type` | Scoring | Relevanz | `location_type` | wenig | – |
| Strukturierte Suche | ja (Straße, Hausnummer, PLZ, Ort) | nein (Freitext) | ja | ja | ja | ja | ja |

**Entscheidung:** Geoapify als erster Adapter.

- Ausschlaggebend waren die EU-Verarbeitung laut AVV, die erlaubte Speicherung, die
  strukturierte Adresssuche und echte gebäudebezogene Konfidenz- und Match-Signale. Diese
  Signale sind für die automatische Übernahme bzw. die menschliche Prüfung nötig.
- OpenCage ist die dokumentierte Alternative (starker Datenschutz über `no_record`, aber ohne
  Genauigkeitssignal).
- Google, Mapbox und HERE scheiden wegen Speicher- und Transferbeschränkungen aus.
- Nominatim (OSMF) ist für den Produktivbetrieb nicht zulässig.
- BKG liefert die beste Genauigkeit, ist aber lizenz- und gebührenpflichtig und
  mittelfristig zu prüfen.

Der Anbieter ist austauschbar: CRM und UI kennen nur den Vertrag `GeocodingProvider`.

### Umsetzung (`@isela/geocoding`)

- `GeocodingProvider` mit `geocode(address)` und optional `reverse(point)`.
- Normalisierung (Straßenabkürzungen, Hausnummer, PLZ) und Vergleichsschlüssel (Umlaute,
  „Str.“/„Straße“).
- Qualitätsbewertung: automatisch übernommen wird nur `BUILDING`-Präzision mit
  Konfidenz ≥ 0,8, gleicher PLZ, Straße und Hausnummer im selben Land. Sonst
  `NEEDS_REVIEW` mit Gründen; andere Länder → `NO_MATCH`. Die Schwellen sind technische
  Qualitätsparameter und im Code dokumentiert.
- Geoapify-Adapter:
  - fester HTTPS-Endpunkt, Eingaben nur als kodierte Query-Parameter,
  - `redirect: "error"`, Timeout, max. 256 KB Antwort, strikte Zod-Validierung
    (Koordinatenbereiche, Typen, Längen, max. 10 Treffer, Ländercode),
  - HTTP 401/403/429/5xx werden auf `UNAVAILABLE` mit Grund abgebildet,
  - keine Exceptions nach außen, kein Logging von URL, API-Key oder Adresse.
- Env: `GEOCODING_PROVIDER=geoapify` und `GEOCODING_API_KEY` müssen gemeinsam gesetzt
  sein; dazu Timeout und Budget pro Minute.
  - Ohne Konfiguration ist Geocoding aus: `PENDING`/`UNKNOWN`, kein Fake-Geocoding.
  - Der Test-Double existiert nur in Tests.

**Offen (Owner):** Konto, API-Key und AVV mit Geoapify; Eintrag in die
Datenschutzerklärung. Der Entwurf beschreibt die Übermittlung bereits faktisch, abhängig
von der Konfiguration.

## 3. ServiceArea

- `checkServiceAvailability(db, point | null)` nutzt die bestehende generische PostGIS-Suche
  (Kreis `ST_DWithin`, Polygon `ST_Covers`, nur aktive Gebiete, nach Priorität).
- Ergebnis: `AVAILABLE` (mit Gebiet), `NOT_AVAILABLE` oder `UNKNOWN`, wenn keine
  vertrauenswürdigen Koordinaten vorliegen.
- Enum `service_area_status` per `RENAME VALUE` von `IN_AREA`/`OUTSIDE` auf
  `AVAILABLE`/`NOT_AVAILABLE` umbenannt (verlustfrei).
- CHECK-Constraints:
  - `AVAILABLE` ⇔ `service_area_id` gesetzt.
  - Koordinaten nur bei `SUCCEEDED`/`MANUAL`.
- Kein `if city === …`; Gelsenkirchen kommt weiterhin nur in Seed-Daten vor (Hardcoding-Guard
  grün, jetzt auch für `apps/`).
- Getestet:
  - Kreis innen und außen, Polygon, mehrere Gebiete mit Priorität, inaktives Gebiet.
  - Fehlende Koordinaten, Polygon-Kante inklusive, ungültige Koordinaten.

## 4. Anfragefluss

```text
Formular → Validierung (Kundenart) → Lead (DISCOVERED) + Kontakt + Anfrage + ggf. Consent
  → Audit lead.created / service_request.submitted          [Transaktion 1]
  → Normalisierung → Provider (außerhalb der Transaktion, Budget-Rate-Limit)
  → Bewertung → geocoding_attempt (append-only) → nur ACCEPTED setzt Koordinaten
  → PostGIS-Gebiet → Audit service_request.geocoded / service_area_changed   [Transaktion 2]
```

- Keine Preiszusage, keine Buchung, keine Partnerzuweisung.
- Der Besucher bekommt unabhängig von der Verfügbarkeit dieselbe Antwort; die Mitarbeitenden
  entscheiden.
- Schlägt der zweite Schritt unerwartet fehl, bleibt die Anfrage gespeichert
  (`PENDING`). Das Scheitern wird ohne personenbezogene Daten geloggt; ein erneuter Lauf ist
  im Backoffice möglich.
- Kundenarten (bestehende Werte):
  - `PRIVATE` = Privatkunde.
  - `BUSINESS` = Firma Pflicht, `fullName` = Ansprechpartner.
  - `PROPERTY_MANAGEMENT` = Firma Pflicht, optional `numberOfProperties` (nur hier erlaubt).
  - Rechnungsdaten werden noch nicht erzwungen.
  - `customer_kind` kennt nun auch `PROPERTY_MANAGEMENT`.

## 5. CRM (Backoffice)

- **Navigation:** Dashboard und Leads sind aktiv. Kunden, Objekte, Angebote, Aufträge,
  Kalender, Mitarbeitende, Partner, Rechnungen, Zahlungen, Bewertungen, Reklamationen, SEO,
  Marketing, Berichte, Einstellungen und Audit-Log erscheinen als „kommt später“ (nach
  Berechtigung sichtbar, ohne Platzhalterdaten).
- **`/admin/leads`:**
  - Filter (serverseitig, Zod-validiert): Status, Kundenart, Leistung, Servicegebiet,
    Verfügbarkeit, Quelle, Zeitraum.
  - Suche nach Name, Firma, E-Mail und Lead-ID; LIKE-Wildcards werden escaped.
  - Pagination Pflicht (max. 50 pro Seite, max. Seite 10 000).
  - Spalten: Lead-ID, Status, Quelle, Kundenart, Kontakt (nur Name), Ort, Leistung, Gebiet,
    Score, Eingang. Keine E-Mail- oder Telefonanzeige in der Liste.
- **`/admin/leads/[id]`:**
  - Kontakt, Anfrage, Adresse, Geocoding (letztes Ergebnis, normalisierte Adresse, Region,
    Präzision, Konfidenz, Gründe), Servicegebiet, Einwilligungen und Datenschutzhinweis
    (getrennt), Historie, Audit (nur mit `audit:read`), nächste Aktion.
  - Aktionen: Statuswechsel, Geocoding erneut ausführen, Treffer bestätigen/verwerfen,
    Adresse korrigieren, Kunde anlegen/zuordnen, Konto verknüpfen, Widerruf dokumentieren.
  - Alle Aktionen sind Server Actions mit Whitelist-Feldern. Ergebnisse werden nur als
    Whitelist-Codes angezeigt, nie als rohe Fehlertexte.
- **Consent:**
  - Marketing-Einwilligung und Datenschutzhinweis (Information, keine Einwilligung) werden
    getrennt dargestellt.
  - Sichtbar nur mit `consent:read`.
  - Ein Widerruf erzeugt einen neuen, unveränderlichen Datensatz (Trigger verhindert
    `UPDATE`); der Kontaktstatus folgt; auditiert.

## 6. Lead-Pipeline

- Die bestehende State Machine (DISCOVERED → … → WON/LOST/FOLLOW_UP) wird unverändert
  genutzt. Status werden nie direkt geschrieben; `transitionLead` prüft Übergänge, Guards,
  Begründungspflicht und optimistische Sperre.
- Jede Änderung hält Nutzer, Zeitpunkt, alten und neuen Status sowie den Grund in
  `lead_status_transition` (append-only) fest und wird im Audit-Log protokolliert.
- Die UI bietet nur erlaubte Übergänge an (`offeredTransitions`); der Server validiert
  erneut.
- Die Abkürzung `DISCOVERED → QUOTE_REQUEST` gilt nur für Inbound-Leads.

## 7. Kundenverknüpfung

- **Lead → Kunde** (`linkLeadToCustomer`, Recht `customer:create`):
  - Daten stammen aus dem Lead; ausschließlich Steuer- und Zahlungsreferenz dürfen
    zusätzlich eingegeben werden.
  - Die bestehende Dublettenerkennung (HMAC-Identitäten; E-Mail, Steuer-ID und neu die
    Zahlungsreferenz normalisiert) führt wiederkehrende Kunden auf den **bestehenden**
    Datensatz; Signale lösen eine Dublettenprüfung aus.
  - Widersprüchliche Identitäten führen zu `CONFLICT`; es wird nichts angelegt
    (Transaktion).
- **Konto ↔ Kunde** (`linkAccountToCustomer`, Recht `customer:link_account`, nur
  ADMIN/SUPER_ADMIN mit MFA):
  - Nur ein verifiziertes Konto, dessen E-Mail eine registrierte Identität genau dieses
    Kunden ist.
  - Höchstens ein Kunde pro Konto (Unique-Index plus Prüfung).
  - Die Rollenvergabe läuft über `assertCanGrantRole`; auditiert (`customer.account_linked`).
  - Es werden keine Kunden- oder Nutzer-IDs aus dem Browser angenommen.
- **Zahlungs-/Risikohistorie:** Ein neues Konto einer wiederkehrenden Person wird dem
  bestehenden Kunden zugeordnet; dessen Status (z. B. `BLOCKED`) bleibt erhalten (getestet).
- **Getestet:** gleiche E-Mail (Groß-/Kleinschreibung), gleiche Steuerreferenz und
  Zahlungsreferenz (unterschiedliche Formatierung), Telefon-Varianten (Unit), bestehender
  Kunde mit neuem Konto, widersprüchliche Identitäten.

## 8. Security

### Rechte (Matrix erweitert, keine neue Rollenlogik)

- `lead:update`: DISPATCHER, ADMIN, SUPER_ADMIN.
- `customer:link_account`: ADMIN, SUPER_ADMIN.
- FINANCE, STAFF, PARTNER und CUSTOMER haben keinen Lead-Zugriff.
- Die MFA-Regeln sind unverändert.

### Browser bestimmt nichts Sicherheitsrelevantes

- Koordinaten, Servicegebiet, Geocoding-Status, Kunden- und Nutzerzuordnung, Owner, Status
  und Risikostatus sind in allen Schemas nicht erlaubt (strict).
- Request- und Kontakt-IDs werden serverseitig aus der Lead-ID ermittelt bzw. gegen sie
  geprüft.

### Explizit getestet

| Bereich | Test |
| --- | --- |
| IDOR | `/admin/leads/[id]` für CUSTOMER, STAFF, PARTNER, FINANCE → 403 bzw. `FORBIDDEN`; Customer ↔ Lead (eigene vs. fremde Anfragen) |
| Rechteausweitung | DISPATCHER darf keine Konten verknüpfen; ADMIN ohne MFA → `MFA_REQUIRED` |
| Mass Assignment / gefälschte Felder | gefälschte `customer_id`, `service_area_id`, Koordinaten, Lead-Status und `ownerUserId` abgelehnt |
| Consent-Zugriff | unberechtigter Zugriff auf Consent-Daten abgelehnt |
| SQL-Injection und LIKE | Suche ist literal |
| XSS | E2E: Nachricht mit `<script>`/`onerror` wird als Text gerendert, kein Dialog, keine Ausführung |
| SSRF | Adressfelder mit URLs/`&apiKey=` ändern Host und Parameter nicht; keine Redirects |
| Manipulierte Provider-Antworten | 10 Varianten → `INVALID_RESPONSE` |
| Rate Limit | Provider-Budget |
| Pagination-Missbrauch | Grenzen, Fallback bei ungültigen URL-Parametern |

### Datenminimierung

- Audit-Einträge ohne Namen, E-Mail oder Adresswerte (Adressänderung: nur Feldnamen).
- Keine personenbezogenen Daten in Logs.

### Weitere Prüfungen

- Client-Bundle-Scan mit 6 Canary-Secrets (neu: `GEOCODING_API_KEY`) → keine Funde.
- gitleaks über History und Arbeitsverzeichnis → keine echten Funde (siehe §11).

## 9. Tests

| Suite | Tag 2 | Tag 3 | Ergebnis |
| --- | --- | --- | --- |
| Unit | 394 | **496** | alle bestanden |
| Integration | 99 | **137** | alle bestanden |
| E2E (Playwright, Produktions-Build) | 9 | **11** | alle bestanden, lokal 3 von 3 Läufen stabil |

**Baseline-Vergleich:** Die Testdateien von Tag 1 und Tag 2 laufen separat ausgeführt grün.

| Baseline | Unit | Integration |
| --- | --- | --- |
| Tag 1 | 309 (vorher 307) | 73 |
| Tag 2 | 403 (vorher 394) | 99 |

Die Unit-Zahlen steigen nur durch zwei neue Fälle der property-basierten RBAC-Matrix (neue
Rechte) und sieben neue Geocoding-Env-Tests in `env.test.ts`. Kein Test wurde gelöscht oder
deaktiviert.

### Neu – Unit

- Geocoding: Normalisierung, Bewertung (8 Review-Gründe, Land), Adapter (SSRF, 10
  manipulierte Antworten, HTTP-Fehler, Timeout/Netzwerk, Reverse).
- Lead-Übergänge (Happy Path bis WON, gefälschte Sprünge, Begründungspflicht).
- CRM-Filter (12 Missbrauchsfälle, LIKE-Escaping), Kundenart-Regeln, gefälschte Felder,
  Identitätsvarianten.
- LeadFinder-Pipeline.
- Admin-Filterparser, Navigation je Rolle, Next-Action, Ergebnis-Code-Whitelist,
  Geocoding-Env.

### Neu – Integration

- Verfügbarkeit (PostGIS).
- Anfrage → Lead → Geocoding → Servicegebiet inkl. Audit ohne personenbezogene Daten.
- Unsichere Treffer, Bestätigen und Verwerfen.
- Anbieter nicht verfügbar, wirft Fehler oder ist nicht konfiguriert.
- Provider-Budget.
- Erneuter Lauf und Adresskorrektur.
- Append-only-Historie.
- Gefälschte Eingaben.
- Rechte `lead:update`.
- Lead-Liste und -Detail, RBAC/IDOR je Rolle, Statuswechsel mit Historie und Audit.
- Kundenverknüpfung und Dubletten.
- Consent-Widerruf.
- Landingpage-Veröffentlichungsprüfung.

### Neu – E2E

- Öffentliche Anfrage → Lead in `/admin/leads` → Detail → Statuswechsel.
- Ungültige IDs → 404.
- Staff → `/customer` 403; Customer → `/admin/*` 403.

**Hinweis E2E:** Admin-Rollen werden als **Testdaten** per SQL vergeben (stellvertretend für
den Einladungs-Flow), nur in der dedizierten E2E-Datenbank. Geocoding ist in E2E nicht
konfiguriert (keine Credentials); der Geocoding-Pfad ist über Integrationstests mit einem
Test-Double abgedeckt.

## 10. CI

- Bestehende Jobs sind unverändert. Die neuen Tests laufen in den vorhandenen Jobs (Unit,
  Integration, E2E).
- Client-Bundle-Scan mit `GEOCODING_API_KEY`-Canary erweitert.
- **CI-Stand auf PR #4** (Head `90f8a6e`) – grün:
  - Typecheck/Lint/Unit/Build, Integration (PostGIS)
  - Web-Build mit Client-Bundle-Scan
  - Secret-Scan (gitleaks), Repo-Guard
  - Markdown- und Workflow-Lint
  - Audit/Lizenzen
  - CodeQL (Analyse und Check)
  - E2E (siehe PR-Checks)
- „Dependency review“ schlägt weiterhin nur wegen des deaktivierten Dependency Graph fehl
  (Owner-Einstellung). Der Check ist nicht abgeschaltet.

## 11. Bugs gefunden und behoben

| # | Befund | Schwere | Behebung |
| --- | --- | --- | --- |
| B1 | Die Loading-Boundary `app/admin/loading.tsx` ließ `notFound()`/`forbidden()` aus Seiten mit HTTP 200 streamen (unbekannte Lead-ID lieferte 200 statt 404). Inhalte blieben geschützt, der Statuscode war falsch. | mittel | Boundary nur noch im Dashboard; E2E prüft 404 |
| B2 | drizzle-kit erzeugte für die Enum-Umbenennung `DROP TYPE`/`CREATE TYPE`; das wäre bei vorhandenen Zeilen gescheitert bzw. riskant | hoch (Migration) | von Hand durch `RENAME VALUE` ersetzt; Upgrade-Pfad 0003 → 0004 mit Bestandsdaten getestet |
| B3 | Die Dublettenerkennung konnte Zahlungsreferenzen nicht nutzen (`PAYMENT_REFERENCE` war im Schema, aber nie befüllbar) | mittel | normalisierte Zahlungsreferenz als eindeutige Identität |
| B4 | Kontoverknüpfung (offener Punkt von Tag 2) fehlte; E2E vergab Rollen nur per SQL | – | serverseitiger, auditierter Flow mit Identitätsprüfung |
| B5 | gitleaks meldete den Dummy-API-Key eines Unit-Tests (False Positive; der Push lief vor der Auswertung) | niedrig | exakter Fingerprint in `.gitleaksignore` plus `gitleaks:allow`; Regeln unverändert, keine History-Änderung |
| B6 | Ein eigener Konflikt-Test war zunächst so formuliert, dass er Fehler verschluckt hätte (Scheingrün) | – | vor dem Commit durch einen eindeutigen Test ersetzt |
| B7 | Die Lead-Liste hatte keinen Index für die Sortierung nach Eingang und den Gebietsfilter | niedrig | Indizes `lead_created_idx`, `service_request_service_area_idx` |

Kein kritischer Security-, Auth- oder Datenbankfehler aus Tag 2 gefunden.

## 12. Offene Punkte

1. **Geocoding aktivieren (Owner):** Geoapify-Konto und API-Key, AVV/DPA abschließen,
   Datenschutzerklärung ergänzen (rechtlich prüfen). Bis dahin ist Geocoding aus und die
   Verfügbarkeit wird manuell geklärt.
2. **Impressum und Datenschutz:** weiterhin Entwurf; echte Angaben und rechtliche Prüfung
   durch den Owner. Es wurden keine Verantwortlichen, Datenschutzbeauftragten oder
   Rechtsgrundlagen erfunden.
3. **Einladungs-Flow im Backoffice:** Die Kontoverknüpfung setzt ein bereits registriertes,
   verifiziertes Konto voraus. Eine Einladung aus dem Lead heraus ist noch keine UI-Aktion
   (die Domänenfunktion existiert seit Tag 1).
4. **Kundenadresse aus der Anfrage:** Beim Verknüpfen wird noch keine `customer_address`
   angelegt; das kommt mit dem Kundenmodul.
5. **Suche im großen Maßstab:** `ILIKE` ohne Trigram-Index. Ab größeren Datenmengen
   `pg_trgm` einführen.
6. **Landingpages:** Datenmodell und Prüfung existieren; eine Route und Inhalte fehlen
   bewusst. Die Sitemap nimmt erst mit einer Route veröffentlichte Seiten auf.
7. **LeadFinder:** nur Verträge und Pipeline, kein Provider (jeder braucht eine eigene
   rechtliche Prüfung).
8. **Repository (Owner):** Dependency Graph aktivieren, Branch-Schutz, Tag
   `phase-0-complete`.

## 13. Risiken

- **Gestapelte PRs** (#1 → #2 → #3 → #4) erschweren das Review; Merge in dieser
  Reihenfolge.
- **Anbieter-API ungetestet gegen den Live-Dienst:** Das Antwortformat ist nach
  Dokumentation und Recherche implementiert und strikt validiert. Weicht die echte API ab,
  entsteht `INVALID_RESPONSE`/`PENDING` statt falscher Koordinaten (fail safe). Vor dem
  Go-live einen Kontrolltest mit echtem Key durchführen.
- **OSM-Abdeckung:** In ländlichen Gebieten mehr `NEEDS_REVIEW`; das bedeutet mehr manuelle
  Prüfung, aber keine Fehlentscheidung.
- **Qualitätsschwellen:** 0,8 und Gebäudegenauigkeit sind konservativ; die Wirkung ist nach
  Echtbetrieb zu beobachten und die Schwellen ggf. als Setting zu führen.
- **`experimental.authInterrupts`** (seit Tag 2) bleibt ein Upgrade-Risiko.

## 14. Nächster Schritt

1. Owner: PRs #1 → #4 mergen, Geocoding-Credentials und AVV, Rechtstexte, Dependency Graph.
2. Kundenmodul im Backoffice: Kundenliste und -detail, Adressen/Objekte aus Anfragen,
   Einladung aus dem Lead.
3. Angebotsmodul (manuell erstellt, keine automatische Preiszusage) mit Anbindung an
   `QUOTE_REQUEST`/`QUOTE_SENT`.
4. Audit-Log-Ansicht und Einstellungs-UI (Geocoding-Schwellen, Lead-Scoring).

PHASE 1 DAY 3 COMPLETE
