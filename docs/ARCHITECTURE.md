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
| Typecheck / Lint / Tests / Build | – (kein Code) | Phase 1 |
| Dependency Review, CodeQL | – | Phase 1 |
| E2E | – | Tag 9 |
| Deployment staging/prod | – | Tag 10 |

## 11. Beobachtbarkeit

Strukturierte JSON-Logs mit Korrelations-ID je Request/Job; Redaction für
personenbezogene und geheime Felder; Fehler-Tracking mit EU-Datenresidenz; Health-
und Readiness-Endpunkte für Web und Worker.
