# ISELA CLEAN – Plattform

Softwareplattform für **ISELA CLEAN**: Reinigungsunternehmen mit eigener Reinigung,
Vermittlung geprüfter Reinigungspartner (Marketplace), wiederkehrenden Aufträgen und
B2B-Kundschaft.

> **Status:** Phase 0 (Foundation) – es existiert noch **kein** ausführbarer
> Anwendungscode. Siehe [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md).

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

## Lokale Prüfungen (aktueller Stand)

Solange kein Anwendungscode existiert, laufen nur Repository-Prüfungen:

```bash
./scripts/check-forbidden-files.sh      # verbotene Dateien (.env, Schlüssel, Dumps)
npx markdownlint-cli2 "**/*.md"         # Markdown-Lint
gitleaks git . --no-banner              # Secret-Scan (gitleaks >= 8.30)
```
