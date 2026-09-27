# ISELA CLEAN – Architektur

| Feld | Wert |
| --- | --- |
| Status | Zielarchitektur – Entscheidungen **vorgeschlagen**, Freigabe in Phase 1 |
| Grundlage | [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md), [`SECURITY.md`](SECURITY.md) |
| Stand Codebasis | Kein Anwendungscode vorhanden (siehe [`PHASE_STATUS.md`](PHASE_STATUS.md)) |

## 1. Leitprinzipien

1. **Modularer Monolith.** Ein deploybares System mit strikt getrennten Fachmodulen.
   Einzelne Module können später ausgelagert werden, ohne Fachlogik umzuschreiben.
2. **Fachlogik ist framework-unabhängig.** Geschäftsregeln (Preise, Zahlungsbedingungen,
   Scoring, Zuweisung) liegen in reinen TypeScript-Modulen ohne Abhängigkeit zu Next.js,
   HTTP oder Datenbanktreibern und sind isoliert testbar.
3. **Ports & Adapters.** Externe Systeme (Zahlung, E-Mail, Geocoding, Lead-Quellen)
   werden über Interfaces angebunden. Es gibt keine Fake-Implementierungen im
   Produktionspfad; Test-Doubles existieren ausschließlich im Testcode.
4. **Konfiguration statt Hartcodierung.** Einsatzgebiete, Leistungen, Preise,
   Zahlungsrichtlinien und Scoring-Gewichte sind versionierte Daten.
5. **Secure by Default.** Autorisierung serverseitig, Validierung an jeder Grenze,
   Auditierung sicherheits- und finanzrelevanter Aktionen.
6. **Nachvollziehbarkeit.** Jede automatisierte Entscheidung (Zahlungsbedingung,
   Lead-Score, Zuweisung) speichert Eingaben, Regelversion und Begründung.

## 2. Technologie-Entscheidungen (vorgeschlagen)

| ID | Entscheidung | Begründung | Status |
| --- | --- | --- | --- |
| ADR-001 | pnpm-Workspaces + Turborepo (Monorepo) | Klare Modulgrenzen, inkrementelle Builds, ein Lockfile | Vorgeschlagen |
| ADR-002 | TypeScript `strict`, Node.js 24 LTS | Typsicherheit über alle Schichten; LTS-Support | Vorgeschlagen |
| ADR-003 | Next.js (App Router) für Website, Portale, Admin | SSR/SSG für SEO, ein Deployment für MVP | Vorgeschlagen |
| ADR-004 | PostgreSQL 16+ mit PostGIS | Relationale Integrität, Transaktionen, Geo-Radius/Polygone für Einsatzgebiete | Vorgeschlagen |
| ADR-005 | Drizzle ORM, versionierte SQL-Migrationen | SQL-nah, typsicher, PostGIS-tauglich, reviewbare Migrationen | Vorgeschlagen |
| ADR-006 | Better Auth mit serverseitigen DB-Sessions (Alternative: Auth.js) | HttpOnly-Session-Cookies, Organisationen, erweiterbar für RBAC | Vorgeschlagen – Evaluierung Tag 2 |
| ADR-007 | Zod für Validierung (Env, Requests, Formulare) | Ein Schema für Laufzeitvalidierung und Typen | Vorgeschlagen |
| ADR-008 | pg-boss als Job-Queue auf PostgreSQL | Keine Zusatz-Infrastruktur im MVP; transaktionale Jobs | Vorgeschlagen |
| ADR-009 | Vitest, Testcontainers (PostgreSQL), Playwright | Unit/Integration gegen echte DB, E2E im Browser | Vorgeschlagen |
| ADR-010 | Zahlungsanbieter über `PaymentProvider`-Port | Anbieter noch offen (PRODUCT_SPEC §10) | **Offen** |
| ADR-011 | Hosting in der EU, getrennte Umgebungen dev/staging/prod | DSGVO, Datenresidenz | **Offen** (Anbieter) |
| ADR-012 | Strukturiertes Logging (pino) mit PII-Redaction | Betriebsfähigkeit ohne unnötige personenbezogene Daten | Vorgeschlagen |

Versionen werden in Phase 1 über das Lockfile fixiert. Jede Abweichung von dieser
Tabelle wird hier mit Begründung dokumentiert.

### 2.1 Stack Gate Phase 1 (geprüft am 2026-09-27 gegen die npm-Registry)

| Komponente | Geprüft | Entscheidung | Begründung |
| --- | --- | --- | --- |
| Node.js | 24.21.0 LTS | `.nvmrc` = 24, `engines` `>=24.11 <25` | LTS; pg-boss verlangt ≥ 22.12 |
| pnpm | 10.33.0 | `packageManager` exakt | `minimumReleaseAge` (48 h) und blockierte Install-Skripte |
| TypeScript | 7.0.2 verfügbar | **6.0.3** gepinnt | TS 7 (nativer Port) wird von `typescript-eslint` 8.70 nicht unterstützt (Peer `<6.1.0`) |
| Next.js | 16.3.6 | Major 16 bestätigt, **noch nicht installiert** | Tag 1 enthält keine UI; exakter Pin mit `apps/web` |
| PostgreSQL / PostGIS | 16.13 / 3.4.2 lokal; CI `postgis/postgis:16-3.4` per Digest | bestätigt | Geo-Typen als Domains `geo_point`/`geo_multipolygon` (drizzle-kit quotet Typen mit Klammern) |
| Drizzle ORM / Kit | 0.45.3 / 0.31.11 | exakt gepinnt | vor 1.0 – Updates nur bewusst; Better-Auth-Peer `^0.45.2` erfüllt |
| Better Auth | 1.7.6 | bestätigt, API gegen Typdefinitionen geprüft | Plugin `admin` bewusst **nicht** genutzt (zweites Rollensystem); `twoFactor` für MFA |
| pg | 8.23.0 | exakt | Treiber für Drizzle und Better Auth |
| Zod | 4.6.5 | exakt | Validierung und Typen |
| pg-boss | 12.35.0 | bestätigt, **noch nicht installiert** | erst mit `apps/worker`; benötigt Dauerprozess |
| Vitest | 5.0.2 verfügbar | **5.0.1** | 5.0.2 jünger als 48 h (`minimumReleaseAge`) |

Abweichungen von der Zielstruktur (§3) an Tag 1: flache Pakete unter `packages/*` statt
`packages/modules/*` (weniger Indirektion, gleiche Grenzen); kein Turborepo (ein Build-
Schritt genügt, keine unnötige Abhängigkeit); keine Testcontainers (kein Docker-Daemon in
der Entwicklungsumgebung) – Integrationstests nutzen `TEST_DATABASE_URL`, in CI einen
PostGIS-Service-Container.

### 2.2 Umgesetzte Module (Phase 1, Tag 1)

| Paket | Inhalt | Server-only |
| --- | --- | --- |
| `@isela/shared` | Fehler, Clock, Redaction | nein |
| `@isela/validation` | Zod-Helfer, Normalisierung (E-Mail, Telefon, PLZ) | nein |
| `@isela/notifications` | Port `EmailSender` (ohne Default-Implementierung) | ja |
| `@isela/database` | Drizzle-Schema, Migrationen, Seeds, Client | ja |
| `@isela/audit` | Append-only Audit-Log mit Redaction | ja |
| `@isela/auth` | Better Auth, RBAC-Matrix, `authorize`, Lockout, Einladungen, Sessions | ja |
| `@isela/catalog` | Leistungen, Einsatzgebiete, Geo-Dienste | ja |
| `@isela/crm` | Kunden, Adressen, Objekte, Leads, Kontakte, Consent | ja |
| `@isela/lead-finder` | Provider-Vertrag, Gating, SSRF-Schutz, Scoring-Schema | ja |
| `@isela/payment-risk` | Richtlinien-Schema mit Invarianten | ja |
| `@isela/settings` | Typisierte, versionierte Settings | ja |
| `@isela/config` | Typisiertes Server-Env-Schema (Tag 2), Fail-fast | ja |
| `@isela/partners` | Partner-Lesezugriff mit Scope-Prüfung (Tag 2) | ja |
| `@isela/geocoding` | Geocoding-Vertrag, Normalisierung, Qualitätsbewertung, Geoapify-Adapter (Tag 3) | ja |

Die Grenzen werden per `scripts/check-module-boundaries.mjs` (Abhängigkeits-Allowlist,
keine Deep-Imports, client-sichere Pakete nicht von Server-only-Paketen abhängig) und
ESLint (`no-restricted-imports`) in CI geprüft. Die sensiblen Module `auth`,
`payment-risk` und künftig `payments`, `invoicing`, `booking`, `jobs` sind `serverOnly`.

### 2.3 Web-App (`apps/web`, Phase 1, Tag 2)

- Next.js 16.3 (App Router, Turbopack), React 19.3, TypeScript strict. Fachlogik liegt
  ausschließlich in den Paketen; Seiten und Server Actions rufen nur Paketfunktionen mit
  einem `ServiceContext` auf. UI-Komponenten greifen nie direkt auf die Datenbank zu.
- Composition Root: `lib/server/composition.ts` baut aus dem validierten Env (DB, SMTP,
  Better Auth, CRM-Konfiguration) einmal pro Prozess die Dienste. `instrumentation.ts`
  validiert beim Start und beendet den Prozess bei Fehlkonfiguration (Exit 1).
- `proxy.ts` (ehem. Middleware): CSP-Nonce, Request-ID, Login-Redirect für geschützte
  Bereiche ohne Session-Cookie. Rechteprüfung ausschließlich serverseitig in Layout-Guards
  und in den Paketfunktionen.
- Auth-Route `app/api/auth/[...all]` delegiert an die bestehende Better-Auth-Instanz aus
  `@isela/auth` (keine zweite Auth-Implementierung).
- Landingpages `/<leistung>-<ort>` werden später aus `service_category.url_slug` und aktiven
  Einsatzgebieten erzeugt (`lib/seo/seo.ts`: `buildLandingPath`/`parseLandingPath`);
  kein Ort ist im Code verankert.
- Grenzen: `scripts/check-module-boundaries.mjs` prüft auch Apps – nur deklarierte Pakete,
  nur öffentliche Exports, und `"use client"`-Dateien dürfen weder Server-only-Pakete noch
  `@/lib/server` importieren.

### 2.4 Adress-Pipeline und Backoffice (Phase 1, Tag 3)

```text
Formular → Validierung (Zod, Kundenart-Regeln) → Lead + Kontakt + Anfrage (Transaktion)
  → Normalisierung → GeocodingProvider (außerhalb der Transaktion, austauschbar)
  → Bewertung (Präzision, Konfidenz, PLZ/Straße/Hausnummer) → geocoding_attempt (append-only)
  → nur ACCEPTED/MANUAL_CONFIRMED setzen Koordinaten → PostGIS-Servicegebiet
  → AVAILABLE | NOT_AVAILABLE | UNKNOWN (+ Audit)
```

- Unsichere Treffer (`NEEDS_REVIEW`) setzen **keine** Koordinaten; ein Mensch bestätigt oder
  verwirft im Backoffice.
- Ohne konfigurierten Anbieter bleibt der Status `PENDING`/`UNKNOWN` (kein Fake-Geocoding).
- Backoffice `/admin/leads` und `/admin/leads/[id]`: Lesemodelle in `@isela/crm`
  (`listLeads`, `getLeadDetail`), Änderungen nur über Domänenfunktionen (State Machine,
  Geocoding-Prüfung, Adresskorrektur, Kunden-/Kontoverknüpfung, Widerruf).
- LeadFinder: Provider-Verträge und reine Pipeline-Stufen (Compliance → Normalisierung →
  Deduplizierung → Scoring → menschliche Prüfung); kein Provider implementiert.
- Landingpages: Tabelle `landing_page` + Veröffentlichungsprüfung (echter Service, Standort
  im aktiven Servicegebiet per PostGIS, geprüfter Inhalt); noch keine Seiten.

### 2.5 Kunden-CRM, Objekte und Angebote (Phase 1, Tag 4)

```text
Lead/Anfrage → linkLeadToCustomer (Identitäts-Lock, Dublettenerkennung)
  → ensureAddressFromRequest (gleichwertige Adresse wiederverwenden, Koordinaten nur aus
    vertrauenswürdigem Geocoding) → optional createPropertyFromLead
  → Angebotsentwurf (@isela/quotes) → Prüfung → Freigabe (quote:approve)
```

- **`@isela/crm`:** Lesemodelle `listCustomers`/`getCustomerDetail` (Aggregation je Seite in
  gruppierten Abfragen über max. 50 IDs statt korrelierter Unterabfragen),
  Adress-/Objektverwaltung, Lead → Objekt, Einladung aus dem Lead. Neue Abhängigkeiten:
  `@isela/payment-risk` (Zahlungsbedingung) und `@isela/settings` (versionierte Richtlinie).
- **`@isela/quotes` (neu):** State Machine, Cent-Arithmetik, `PricingEngine`-Schnittstelle
  (nur Vertrag, kein Preisalgorithmus), Services für Entwurf/Positionen/Übergänge/Ablauf.
  Abhängigkeiten: `audit`, `auth`, `database`, `shared`, `validation`. Die Konfiguration
  `quote.defaults` liegt im Settings-Register (`settings → quotes`); die Web-App lädt sie und
  übergibt sie den Services (kein Zyklus).
- **`@isela/payment-risk`:** reine Funktion `evaluatePaymentTerms(history, policy)`.
- **Web:** `/admin/customers`, `/admin/customers/[id]`, `/admin/properties`, `/admin/quotes`,
  `/admin/quotes/[id]`, `/account/invitation`, `/customer/quotes[/id]`. Server Actions lesen
  nur Whitelist-Felder und melden Ergebnisse über Whitelist-Codes.
- **Suche:** ILIKE mit escapten Wildcards. `pg_trgm` wurde gemessen (200 000 synthetische
  Kunden): Mit der aktuellen OR/EXISTS-Abfrage nutzt der Planer die Trigram-Indizes nicht
  (≈ 380 ms → ≈ 330 ms, im Rauschen) bei +52 MB Indexgröße (Tabellen: 55 MB). Nur mit
  umgebauter UNION-Abfrage sinkt eine selektive Suche von ≈ 115 ms auf < 1 ms. Entscheidung:
  **noch nicht eingeführt**; Einführung (Migration `CREATE EXTENSION pg_trgm` + GIN-Indizes +
  UNION-Abfrage) sobald > 50 000 Kunden oder p95 der Kundensuche > 200 ms.

## 3. Ziel-Repository-Struktur

```text
.
├── apps/
│   ├── web/                 Next.js: Website, Kunden-, Partner-, Mitarbeiterportal, Admin
│   └── worker/              Hintergrundjobs (Follow-ups, Wiederkehrende Aufträge,
│                            Mahnwesen, Lead-Import, Payment-Risk-Neubewertung)
├── packages/
│   ├── core/                Shared Kernel: Money, IDs, Result, Fehler, Clock
│   ├── config/              Env-Validierung (Zod), Feature-Flags
│   ├── db/                  Schema, Migrationen, Repositories, Seeds (nur Entwicklung)
│   ├── auth/                Sessions, Permissions, Policy-Checks
│   ├── modules/
│   │   ├── crm/
│   │   ├── acquisition/     Lead Management, LeadFinder, Scoring
│   │   ├── catalog/         Leistungen, Einsatzgebiete
│   │   ├── pricing/         Preisregeln, Angebote
│   │   ├── booking/
│   │   ├── recurring/
│   │   ├── fulfillment/     Aufträge, Mitarbeitende, Partner, Zuweisung
│   │   ├── quality/
│   │   ├── billing/         Rechnungen, Zahlungen, Partnerabrechnung
│   │   ├── payment-risk/    Payment Risk Engine
│   │   └── audit/
│   ├── integrations/        Adapter: payment, email, geocoding, lead-sources
│   └── ui/                  Design-System-Komponenten
├── docs/
└── .github/
```

### 3.1 Abhängigkeitsregeln

```text
apps/*  →  packages/modules/*  →  packages/core
                 │
                 └→ Ports (Interfaces)  ←  packages/integrations/* (Adapter)
```

- Module dürfen sich **nicht** gegenseitig in Interna importieren – nur über die
  öffentliche API (`index.ts`) oder Domain-Events.
- `packages/core` hat keine Laufzeitabhängigkeiten zu Framework oder Datenbank.
- Regeln werden in Phase 1 per Lint-Regel (z. B. `dependency-cruiser` oder
  ESLint-Boundaries) automatisiert geprüft.

## 4. Datenmodell-Grundsätze

| Thema | Regel |
| --- | --- |
| IDs | UUID (v7 bevorzugt, zeitlich sortierbar); keine fortlaufenden IDs nach außen |
| Geld | Ganzzahlig in Cent (`bigint`) + Währung; niemals `float` |
| Zeit | `timestamptz` in UTC; Darstellung in `Europe/Berlin` |
| Mandanten | Fachdaten tragen `organization_id`; jede Query ist mandantengebunden |
| Nebenläufigkeit | Optimistic Locking (`version`) für Buchungen, Rechnungen, Zuweisungen |
| Rechnungen | Nach Ausstellung unveränderlich; Korrektur nur per Storno/Gutschrift |
| Löschung | Löschkonzept je Datenkategorie (DSGVO vs. Aufbewahrungspflichten) |
| Geo | `geography`-Spalten (PostGIS) für Adressen und Einsatzgebiete |

## 5. Einsatzgebiete und Expansion

`ServiceArea` = `CIRCLE(center, radiusMeters)` oder `POLYGON`. Die Prüfung
„Adresse liegt im Gebiet“ erfolgt in der Datenbank (`ST_DWithin` / `ST_Covers`).
Eine Expansion (25 km → 50 km → Ruhrgebiet → NRW → Deutschland) ist ein Datensatz-
Update, kein Deployment. Geocoding läuft über einen austauschbaren Adapter mit Cache.

## 6. Payment Risk Engine

```text
             ┌────────────────────┐
Trigger ───▶ │ PaymentRiskService │ ──▶ PaymentTermsDecision (persistiert, auditiert)
(Zahlung,    └─────────┬──────────┘
 Fälligkeit,           │ lädt
 Chargeback,           ▼
 Policy-      PaymentPolicy (versioniert)  +  CustomerPaymentHistory
 Änderung)             │
                       ▼
              evaluatePaymentTerms(history, policy, now)   ← reine Funktion
```

- `evaluatePaymentTerms` ist **deterministisch** und seiteneffektfrei → vollständig
  per Unit-Tests (inkl. Grenzwerten und Property-Based-Tests) abgesichert.
- Überfällige Rechnungen setzen die Bedingung für **neue** Aufträge sofort auf
  `PREPAYMENT`; die Checkout-/Buchungsstrecke fragt die aktuelle Entscheidung
  serverseitig ab und vertraut nie einem Client-Wert.
- Richtlinien sind versioniert; jede Entscheidung referenziert `policyVersion`.

## 7. LeadFinder / Acquisition

Da kein passender, produktiv nutzbarer Lead-Finder für Reinigungsleistungen als
Werkzeug verfügbar ist (siehe [`PHASE_0_REPORT.md`](PHASE_0_REPORT.md)), wird eine
eigene modulare Architektur gebaut:

```ts
// Port – jede Quelle ist ein austauschbarer Adapter
interface LeadSource {
  readonly id: string;               // z. B. "manual", "website-form", "tender-ted"
  readonly legalBasis: LegalBasis;   // dokumentierte Rechtsgrundlage
  discover(query: DiscoveryQuery): AsyncIterable<RawLead>;
}
```

Pipeline-Stufen sind einzelne, idempotente Jobs: `discover → normalize → dedupe →
enrich → qualify → score → review`. Outreach erzeugt ausschließlich **Entwürfe**;
Versand nur nach menschlicher Freigabe (siehe PRODUCT_SPEC §5.3). Quellen werden
einzeln rechtlich und technisch (Nutzungsbedingungen, API-Zugang) freigegeben.

## 8. Integrationen, Webhooks, Jobs

- **Webhooks:** Signaturprüfung, Zeitstempel-Toleranz, Replay-Schutz, Idempotenz über
  gespeicherte Event-IDs; Verarbeitung asynchron über die Job-Queue.
- **Outbox-Pattern:** Domain-Events werden transaktional gespeichert und vom Worker
  zuverlässig ausgeliefert (E-Mails, Neubewertungen, Benachrichtigungen).
- **Idempotency-Keys** für alle zahlungs- und buchungsrelevanten Schreib-Endpunkte.
- **Ausgehende Requests** nur an konfigurierte Hosts (SSRF-Schutz).

## 9. Teststrategie

| Ebene | Werkzeug | Fokus |
| --- | --- | --- |
| Unit | Vitest | Fachregeln (Preise, Payment Risk, Scoring, Wiederholungsregeln) |
| Integration | Vitest + Testcontainers | Repositories, Migrationen, Autorisierung gegen echte PostgreSQL |
| E2E | Playwright | Kritische Flows: Anfrage → Angebot → Buchung → Rechnung → Zahlung |
| Security | CI-Scans + gezielte Tests | IDOR/RBAC-Matrix, Validierung, Webhook-Signaturen |

Qualitätsschranken (ab Phase 1 in CI verbindlich): Typecheck, Lint, Unit- und
Integrationstests grün; Fachmodule mit hoher Abdeckung (Ziel ≥ 90 % für
`payment-risk`, `pricing`, `billing`).

## 10. CI/CD

| Stufe | Stand Phase 0 | Ziel |
| --- | --- | --- |
| Secret-Scan (gitleaks) | ✅ aktiv | bleibt |
| Repo-Guard (verbotene Dateien) | ✅ aktiv | bleibt |
| Markdown-Lint | ✅ aktiv | bleibt |
| Workflow-Lint (actionlint) | ✅ aktiv | bleibt |
| Typecheck / Lint / Unit-Tests / Build | ✅ aktiv (Phase 1, Tag 1) | bleibt |
| Integrationstests gegen PostgreSQL + PostGIS, Migrations-Drift | ✅ aktiv (Phase 1, Tag 1) | bleibt |
| Modulgrenzen, Standort-Hardcoding, Audit, Lizenzen | ✅ aktiv (Phase 1, Tag 1) | bleibt |
| Dependency Review, CodeQL | ✅ aktiv (Phase 1, Tag 1) | bleibt |
| E2E | – | Tag 9 |
| Deployment staging/prod | – | Tag 10 |

## 11. Beobachtbarkeit

Strukturierte JSON-Logs mit Korrelations-ID je Request/Job; Redaction für
personenbezogene und geheime Felder; Fehler-Tracking mit EU-Datenresidenz; Health-
und Readiness-Endpunkte für Web und Worker.
