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

Aktuell (Phase 0, kein Anwendungscode):

```bash
./scripts/check-forbidden-files.sh
npx markdownlint-cli2 "**/*.md"
```

Ab Phase 1 werden hier `pnpm`-Befehle für Typecheck, Lint, Test und Build ergänzt.

## Kurzfassung der wichtigsten Regeln

- Erst analysieren, dann ändern. Bestehende Dateien vor Änderung lesen.
- Nichts löschen, was funktioniert; keine Tests deaktivieren; CI nicht abschwächen.
- `.env`-Dateien nie lesen oder ausgeben; Secrets nie committen.
- Geschäftsregeln (Zahlungsbedingungen, Einsatzgebiete, Preise, Scoring) nie
  hartcodieren – sie sind konfigurierbare, versionierte Daten.
- Nach jeder Phase `docs/PHASE_STATUS.md` aktualisieren und einen Phasenbericht
  `docs/PHASE_<n>_REPORT.md` erstellen. Danach **stoppen** und auf Freigabe warten.
