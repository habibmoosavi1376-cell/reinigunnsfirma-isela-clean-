## Zusammenfassung

<!-- Was ändert dieser PR und warum? -->

## Betroffene Module

<!-- z. B. payment-risk, billing, auth -->

## Checkliste

- [ ] Bestehende Dateien vor Änderung geprüft; nichts Funktionierendes entfernt
- [ ] Tests ergänzt/angepasst – keine Tests gelöscht oder deaktiviert
- [ ] Typecheck, Lint, Tests und Build lokal grün
- [ ] Serverseitige Autorisierung inkl. Objektbesitz geprüft (RBAC-Matrix erweitert)
- [ ] Eingaben per Schema validiert; keine Mass-Assignment-Pfade
- [ ] Keine Secrets, `.env`-Dateien oder Produktionsdaten im Diff
- [ ] Keine personenbezogenen Daten in Logs
- [ ] Geschäftsregeln konfigurierbar statt hartcodiert
- [ ] Dokumentation aktualisiert (`docs/PHASE_STATUS.md`, Specs)

## Tests

<!-- Welche Tests wurden ausgeführt? Ergebnis? -->

## Risiken / Rollback

<!-- Migrationen? Breaking Changes? Wie wird zurückgerollt? -->
