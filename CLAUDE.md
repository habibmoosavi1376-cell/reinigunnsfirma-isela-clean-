# CLAUDE.md – Arbeitsregeln für Claude Code

Dieses Repository enthält die Plattform **ISELA CLEAN** (Reinigung + Vermittlung,
Startmarkt Gelsenkirchen, bundesweit skalierbar). Die verbindlichen Regeln für alle
KI-Agenten stehen in [`AGENTS.md`](AGENTS.md) – sie gelten hier vollständig.

## Pflichtlektüre vor jeder Änderung

1. [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md) – aktueller Stand, nächste Phase
2. [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) – Fachlogik und Geschäftsregeln
3. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) – Modulgrenzen und Entscheidungen
4. [`docs/SECURITY.md`](docs/SECURITY.md) – Sicherheitsanforderungen

## Befehle

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint                 # ESLint (strict, typbasiert) + Prettier
pnpm run test:unit
pnpm run test:integration     # benötigt TEST_DATABASE_URL (PostgreSQL + PostGIS, DB-Name mit "test")
pnpm run build
pnpm run db:generate          # neue Migration aus Schemaänderung – SQL immer reviewen
pnpm run db:check             # Drift zwischen Schema und Migrationen
pnpm run check:boundaries && pnpm run check:hardcoding
pnpm run check:audit && pnpm run check:licenses
./scripts/check-forbidden-files.sh
npx markdownlint-cli2 "**/*.md"
```

Pflichtlektüre zusätzlich: [`docs/DOMAIN_MODEL.md`](docs/DOMAIN_MODEL.md).

## Kurzfassung der wichtigsten Regeln

- Erst analysieren, dann ändern. Bestehende Dateien vor Änderung lesen.
- Nichts löschen, was funktioniert; keine Tests deaktivieren; CI nicht abschwächen.
- `.env`-Dateien nie lesen oder ausgeben; Secrets nie committen.
- Geschäftsregeln (Zahlungsbedingungen, Einsatzgebiete, Preise, Scoring) nie
  hartcodieren – sie sind konfigurierbare, versionierte Daten.
- Nach jeder Phase `docs/PHASE_STATUS.md` aktualisieren und einen Phasenbericht
  `docs/PHASE_<n>_REPORT.md` erstellen. Danach **stoppen** und auf Freigabe warten.
