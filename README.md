# ISELA CLEAN – Plattform

Softwareplattform für **ISELA CLEAN**: Reinigungsunternehmen mit eigener Reinigung,
Vermittlung geprüfter Reinigungspartner (Marketplace), wiederkehrenden Aufträgen und
B2B-Kundschaft.

> **Status:** Phase 1 / Tag 1 – Datenbank-, Auth-, RBAC- und CRM-Fundament (Pakete unter
> `packages/*`, noch **keine** Benutzeroberfläche). Siehe [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md).

## Offizielles Repository

```text
Official Project Repository:
reinigunnsfirma-isela-clean-

Project:
ISELA CLEAN
```

Dies ist das **einzige** Repository für ISELA CLEAN. Es werden keine weiteren
Repositories, Kopien oder parallelen Foundations angelegt. Entwicklung erfolgt
ausschließlich über Feature-Branches und Pull Requests gegen `main`.

## Markt

Startmarkt ist **Gelsenkirchen**. Die Architektur ist von Beginn an **nicht** auf
eine Stadt beschränkt. Einsatzgebiete werden als Daten (Geo-Radius bzw. Polygon)
gepflegt, nicht als Code:

```text
Gelsenkirchen → 25 km → 50 km → Ruhrgebiet → NRW → Deutschland
```

## Dokumentation

| Dokument | Inhalt |
| --- | --- |
| [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) | Fachliche Spezifikation, Domänen, Geschäftsregeln |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Zielarchitektur, Module, Architekturentscheidungen |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Sicherheitsanforderungen, Meldeweg für Schwachstellen |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 10-Tage-MVP-Plan mit Definition of Done |
| [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md) | Aktueller technischer Zustand (Baseline) |
| [`docs/PHASE_0_REPORT.md`](docs/PHASE_0_REPORT.md) | Abschlussbericht Phase 0 |
| [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) | Arbeitsregeln für KI-Agenten und Mitwirkende |

## Mitwirken

- Keine direkten Commits auf den Default-Branch – ausschließlich über Feature-Branches
  und Pull Requests.
- Jede Änderung muss die CI bestehen (Secret-Scan, Repo-Guard, Lint).
- Secrets gehören **niemals** ins Repository. Vorlage: [`.env.example`](.env.example).

## Entwicklung

Voraussetzungen: Node.js 24 (`.nvmrc`), pnpm 10.33 (`packageManager`), PostgreSQL 16 mit
PostGIS 3.4 für Integrationstests.

```bash
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm run lint && pnpm run build
pnpm run test:unit
TEST_DATABASE_URL=postgres://…/isela_test pnpm run test:integration   # DB-Name muss "test" enthalten
DATABASE_URL=… pnpm run db:migrate && DATABASE_URL=… pnpm run db:seed
pnpm run db:check                      # Migrations-Drift
pnpm run check:boundaries              # Modulgrenzen
pnpm run check:hardcoding              # keine standortspezifische Logik
pnpm run check:audit && pnpm run check:licenses
./scripts/check-forbidden-files.sh     # verbotene Dateien (.env, Schlüssel, Dumps)
npx markdownlint-cli2 "**/*.md"        # Markdown-Lint
gitleaks git . --no-banner             # Secret-Scan (gitleaks >= 8.30)
```

Fachliches Datenmodell: [`docs/DOMAIN_MODEL.md`](docs/DOMAIN_MODEL.md).
