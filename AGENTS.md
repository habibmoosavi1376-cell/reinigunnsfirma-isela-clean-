# AGENTS.md – Regeln für KI-Agenten und Mitwirkende

Gilt für alle automatisierten Agenten (Claude Code, Codex, Copilot u. a.) und für
menschliche Mitwirkende. Bei Widerspruch zu anderen Dokumenten gilt: **Sicherheit vor
Geschwindigkeit, Dokumentation des Konflikts vor Änderung.**

## 1. Absolute Regeln

Es ist untersagt:

- funktionierende Dateien oder Funktionen zu löschen oder zu entfernen,
- Datenbanken, Migrationen oder Produktionsdaten zu verändern oder zu zerstören,
- Secrets zu überschreiben, `.env`-Dateien auszulesen oder Geheimnisse auszugeben,
- APIs ohne Prüfung der Aufrufer zu verändern,
- Tests zu löschen, zu überspringen (`skip`/`only`) oder zu deaktivieren,
- CI/CD, Linter, Secret-Scans oder Sicherheitsprüfungen abzuschalten oder zu umgehen,
- Fake-APIs, Fake-Zahlungen oder Fake-Daten als produktive Implementierung einzusetzen,
- wegen Zeitdrucks Qualität oder Tests zu opfern,
- automatisierte Massenansprache (E-Mail, Telefon, Messenger) zu implementieren.

## 2. Arbeitsablauf

1. **Analysieren:** `git status`, Branch, betroffene Dateien lesen, Tests ausführen.
2. **Konflikte dokumentieren**, bevor etwas geändert wird.
3. **Auf einem Feature-Branch arbeiten**; nie direkt auf den Default-Branch pushen.
4. **Kleine, nachvollziehbare Commits** mit aussagekräftiger Nachricht.
5. **Vor jedem Push:** `git diff` prüfen, Tests, Typecheck, Lint, Build, Secret-Scan.
6. **Phasenabschluss:** `docs/PHASE_STATUS.md` aktualisieren, Bericht
   `docs/PHASE_<n>_REPORT.md` mit Commit-ID erstellen, dann stoppen.

## 3. Architekturregeln

- Fachlogik liegt in `packages/modules/*` und ist framework-unabhängig.
- Module kommunizieren nur über öffentliche APIs oder Domain-Events.
- Externe Systeme nur über Ports/Adapter; Test-Doubles nur im Testcode.
- Konfigurierbare Geschäftsregeln (Payment Policy, Einsatzgebiete, Preise, Scoring)
  werden als versionierte Daten gespeichert, nicht als Konstanten.
- Geldbeträge in Cent als Ganzzahl; Zeitstempel in UTC.
- Jede automatisierte Entscheidung speichert Eingaben, Regelversion und Begründung.

## 4. Sicherheitsregeln (Kurzfassung von `docs/SECURITY.md`)

- Serverseitige Autorisierung inkl. Objektbesitz in jedem Use Case.
- Eingaben per Schema validieren; keine Request-Bodies direkt ins ORM.
- Keine personenbezogenen Daten oder Secrets in Logs.
- Webhooks: Signatur, Zeitfenster, Idempotenz.
- Neue Abhängigkeiten nur mit Begründung; Lockfile wird mitcommittet.

## 5. Code-Konventionen

- Sprache im Code (Bezeichner, Kommentare): **Englisch**. Fachdokumentation: Deutsch.
- TypeScript `strict`; kein `any` ohne begründeten Kommentar.
- Dateinamen `kebab-case`; Typen/Klassen `PascalCase`; Funktionen/Variablen `camelCase`.
- Tests liegen neben dem Code (`*.test.ts`) bzw. unter `e2e/` für Playwright.

## 6. Commit-Nachrichten

Format nach Conventional Commits, z. B.:

```text
feat(payment-risk): evaluate invoice eligibility from versioned policy
fix(auth): rotate session id after role change
docs(phase-0): add foundation audit report
```
