# ISELA CLEAN – Phase 0 Report (Foundation Audit)

| Feld | Wert |
| --- | --- |
| Datum | 2026-09-26 |
| Repository | `habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` |
| Branch | `claude/untitled-session-mhhecl` |
| Foundation-Commit | `1ed1737f2b81f8694fc4874390e7829ea4d1c38c` |
| Ergebnis | **PHASE 0 COMPLETE** (Bedingungen siehe §15) |

## 1. Zusammenfassung

Das für diese Session verbundene Repository war **vollständig leer** (keine Commits,
keine Branches, keine Dateien). Das im Auftrag genannte Repository
`cleaning-platform-gelsenkirchen` existiert unter dem Account nicht bzw. ist für diese
Session nicht zugänglich. Nach Rückfrage wurde entschieden, `reinigunnsfirma-isela-clean-`
als Plattform-Repository zu verwenden.

Da keine bestehenden Dateien existierten, wurde **nichts verändert oder gelöscht**.
Es wurde eine professionelle Foundation angelegt: Dokumentation, Agenten-Regeln,
Sicherheitsrichtlinie, Repository-Schutz, `.env.example` und eine CI mit
Sicherheits- und Qualitätsprüfungen. Es wurde bewusst **keine Business-Logik** und kein
Anwendungscode erstellt.

## 2. Was wurde gefunden?

### 2.1 Git und GitHub

| Befehl / Prüfung | Ergebnis |
| --- | --- |
| `git status` | `On branch claude/untitled-session-mhhecl`, `No commits yet`, nichts zu committen |
| `git branch -a` | leer |
| `git log --oneline --decorate -20` | `fatal: your current branch 'claude/untitled-session-mhhecl' does not have any commits yet` |
| `git remote -v` | `origin https://github.com/habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` (fetch/push) |
| `git ls-remote origin` | leer |
| GitHub API – Inhalte | `409 Git Repository is empty` |
| GitHub API – Branches | `[]` |
| Sichtbarkeit | **öffentlich** |
| Verfügbare Repositories des Accounts | nur `reinigunnsfirma-isela-clean-` |
| `cleaning-platform-gelsenkirchen` | Suche: 0 Treffer; Anbindung: „not found or no access“ |

### 2.2 Repository-Inhalt (Audit-Checkliste)

Struktur, `package.json`, Lockfiles, Framework, Node-Version, TypeScript, Datenbank,
ORM, Authentifizierung, Apps, Packages, Tests, CI/CD, Deployment,
Umgebungsvariablen, Docker/Infrastructure, Dokumentation, GitHub-Konfiguration:
**jeweils nicht vorhanden.** Keine `.env`-Dateien, keine aktiven Git-Hooks.

### 2.3 Entwicklungsumgebung (Container)

Node.js 22.22.2, npm 10.9.7, pnpm 10.33.0, Yarn 1.22.22, Bun 1.3.11, Docker 29.3.1,
PostgreSQL-Client 16.13, Python 3.11.15. Nicht vorinstalliert: gitleaks, actionlint,
shellcheck (für die Prüfungen mit verifizierter Prüfsumme bzw. per pip nachgeladen,
außerhalb des Repositorys).

## 3. Was war bereits vorhanden?

Nichts außer dem leeren Git-Repository mit konfiguriertem Remote `origin`.

## 4. Was wurde geändert?

- Keine bestehende Datei verändert oder gelöscht (es gab keine).
- 21 Dateien im Foundation-Commit neu angelegt, dieser Report in einem Folgecommit.
- Branch `claude/untitled-session-mhhecl` erstmals nach GitHub gepusht. **Nebenwirkung:**
  Da das Repository leer war, hat GitHub diesen Branch automatisch zum
  Default-Branch gemacht (`git ls-remote` zeigt `HEAD` → dieser Branch). Siehe §11.

## 5. Erstellte Dateien

| Datei | Zweck |
| --- | --- |
| `README.md` | Projektüberblick, Markt, Dokumentationsindex, lokale Prüfungen |
| `CLAUDE.md` | Einstieg und Kurzregeln für Claude Code |
| `AGENTS.md` | Verbindliche Regeln für alle KI-Agenten und Mitwirkenden |
| `docs/PRODUCT_SPEC.md` | Geschäftsmodell, Rollen, Module, Acquisition Engine, Payment Risk Engine, Partner, NFRs |
| `docs/ARCHITECTURE.md` | Leitprinzipien, vorgeschlagene ADRs, Zielstruktur, Datenmodell-Regeln, Teststrategie |
| `docs/SECURITY.md` | Meldeweg, RBAC, Anforderungskatalog, Datenschutz, Secrets, Supply Chain |
| `docs/ROADMAP.md` | 10-Tage-Plan mit Definition of Done und Entscheidungsfristen |
| `docs/PHASE_STATUS.md` | Baseline und aktueller Zustand |
| `docs/PHASE_0_REPORT.md` | Dieser Bericht (Folgecommit) |
| `.env.example` | Variablen-Vorlage, ausschließlich leere Platzhalter |
| `.gitignore` | Schutz vor `.env`, Schlüsseln, Dumps, Uploads, Build-Artefakten |
| `.gitattributes` | LF-Zeilenenden, Binärdateien |
| `.editorconfig` | Einheitliche Formatierung |
| `.markdownlint-cli2.jsonc` | Markdown-Lint-Konfiguration |
| `scripts/check-forbidden-files.sh` | Repo-Guard: bricht ab, wenn verbotene Dateien versioniert sind |
| `.github/workflows/ci.yml` | CI: Secret-Scan, Repo-Guard, Markdown-Lint, Workflow-Lint |
| `.github/dependabot.yml` | Wöchentliche Updates der gepinnten GitHub Actions |
| `.github/CODEOWNERS` | Review-Pflicht durch den Owner |
| `.github/pull_request_template.md` | PR-Checkliste (Tests, RBAC, Validierung, Secrets, PII) |
| `.github/ISSUE_TEMPLATE/*.yml` | Bug-/Feature-Formulare, vertraulicher Security-Meldeweg |

## 6. Veränderte Dateien

Keine. Es existierten keine Dateien, die hätten verändert werden können.

## 7. Ausgeführte Prüfungen und Ergebnisse

| # | Prüfung | Befehl | Ergebnis |
| --- | --- | --- | --- |
| 1 | Baseline-Secret-Scan (leeres Repo) | `gitleaks dir .` | ✅ 0 Funde |
| 2 | Repo-Guard (Positivfall, 21 Dateien) | `./scripts/check-forbidden-files.sh` | ✅ Exit 0 |
| 3 | Repo-Guard Negativtest (Test-Repo mit `.env`, `.env.local`, `.key`, `.dump`, `.sqlite`, `.tfstate`, `id_ed25519`) | wie oben | ✅ alle 7 erkannt, Exit 1; `.env.example` korrekt erlaubt |
| 4 | Markdown-Lint (9 Dateien) | `npx markdownlint-cli2@0.23.3 "**/*.md"` | ✅ 0 Probleme |
| 5 | Shell-Lint | `shellcheck 0.10.0 scripts/check-forbidden-files.sh` | ✅ 0 Befunde |
| 6 | Workflow-Lint (inkl. shellcheck der `run`-Blöcke) | `actionlint 1.7.12` | ✅ 0 Fehler |
| 7 | YAML-Syntax (Dependabot, CI, Issue-Templates) | `yaml.safe_load` | ✅ 5/5 gültig |
| 8 | `.gitignore`-Wirksamkeit | `git check-ignore` | ✅ `.env`, `.env.local`, verschachtelte `.env.*`, `*.pem`, `node_modules` ignoriert; `.env.example` nicht |
| 9 | Secret-Scan Arbeitsverzeichnis | `gitleaks dir . --redact` | ✅ 0 Funde (~55 KB) |
| 10 | Secret-Scan Git-Historie (nach Commit) | `gitleaks git . --redact` | ✅ 0 Funde |
| 11 | CI auf GitHub ([Lauf #1](https://github.com/habibmoosavi1376-cell/reinigunnsfirma-isela-clean-/actions/runs/36280776179), Commit `1ed1737`) | GitHub Actions | ✅ 4/4 Jobs erfolgreich: Secret-Scan, Repo-Guard, Markdown-Lint, Workflow-Lint |

**Unit-, Integrations- und E2E-Tests:** nicht vorhanden, da kein Anwendungscode
existiert. Status **N/A** – ausdrücklich nicht als „bestanden“ gewertet.

## 8. Build-Status

**N/A.** Es gibt kein Build-Ziel (kein `package.json`, kein Framework). Typecheck und
Build werden in Phase 1 als verpflichtende CI-Stufen eingeführt.

## 9. Security-Status

| Bereich | Status |
| --- | --- |
| Secrets im Repository / in der Historie | keine (gitleaks) |
| `.env`-Dateien | keine vorhanden, keine gelesen; per `.gitignore` + Repo-Guard + CI geschützt |
| CI-Supply-Chain | Actions auf Commit-SHA gepinnt; Tools per SHA-256 verifiziert; `permissions: contents: read`; `persist-credentials: false` |
| Sicherheitsrichtlinie | `docs/SECURITY.md` (wird von GitHub als Security Policy erkannt) |
| Branch-Schutz | **nicht aktiv** (manuelle Einstellung durch Owner erforderlich) |
| Secret Scanning / Push Protection / Private Vulnerability Reporting | **nicht verifiziert** – über GitHub-Einstellungen zu aktivieren |
| Repository-Sichtbarkeit | **öffentlich** – Risiko, siehe §12 |
| Anwendungssicherheit | N/A – Anforderungen spezifiziert (`SECURITY.md` §4), Umsetzung ab Phase 1/2 |

## 10. Werkzeug-Inventar Kundenakquise

Geprüft wurden die **in dieser Arbeitssession tatsächlich verfügbaren** Skills und
Connectoren. Es wurde nichts erfunden und in Phase 0 nichts davon ausgeführt.

| Bereich | Verfügbar | Bewertung |
| --- | --- | --- |
| Client Finder | Skill `client-finder` (identisch: `kunde-finder`) | Zweck laut Beschreibung: Marken physischer Produkte für Motion-Design-Werbung finden und öffentliche Kontakt-E-Mails sammeln. **Nicht** auf lokale Reinigungs-B2B-Akquise ausgerichtet; nur der Compliance-Ansatz ist als Referenz nutzbar |
| Lead Finder | – | kein Werkzeug vorhanden |
| Business Search / Local Business Search | – | kein Werkzeug (keine Places-/Karten-/Branchenbuch-Anbindung) |
| Company Research | Skill `deep-research`, generische Websuche/-abruf | für **assistierte manuelle** Recherche nutzbar, keine Plattform-Integration |
| Contact Research | – | kein Werkzeug |
| Prospecting | nur `client-finder` (falsche Domäne) | nicht geeignet |
| Auftragssuche (Ausschreibungen) | – | kein Werkzeug |
| Sales Intelligence | – | kein Werkzeug |
| Angrenzend: SEO | Ahrefs-Connector (Keywords, SERP, Wettbewerber) | relevant für Local SEO (Tag 7) und Wettbewerbsanalyse, liefert keine Kontaktdaten |
| Angrenzend: Kommunikation | Gmail-Connector (u. a. Entwürfe) | passt zum Prinzip „Entwurf statt Automatik“ |
| Angrenzend: Finanzen | Qonto-Connector (Rechnungen, Angebote, Payment Links) | relevant für Tag 6, **falls** ISELA CLEAN Qonto nutzt |
| Angrenzend: Sonstiges | Google Drive/Calendar, Notion, Slack, Coupler.io, GoDaddy | Organisation, Reporting, Domain-Prüfung |

**Wichtig:** Diese Werkzeuge stehen dem Assistenten zur Verfügung, **nicht** der
Plattform zur Laufzeit. Authentifizierung/Funktionsfähigkeit der Connectoren wurde
nicht getestet.

**Konsequenz:** Wie vorgesehen wird eine eigene, modulare `LeadFinder`-Architektur
gebaut (`ARCHITECTURE.md` §7, `PRODUCT_SPEC.md` §5): `LeadSource`-Port mit
austauschbaren Adaptern, rechtliche Freigabe je Quelle, keine automatische
Massenansprache.

## 11. Offene Fragen und Entscheidungen

| # | Frage | Empfehlung | Benötigt bis |
| --- | --- | --- | --- |
| 1 | Default-Branch: aktuell `claude/untitled-session-mhhecl` | Nach Review `main` aus Commit dieses Reports anlegen, als Default setzen, Branch-Schutz aktivieren (Push nach `main` erfordert deine ausdrückliche Freigabe) | Tag 1 |
| 2 | Repository-Sichtbarkeit: öffentlich | Auf **privat** stellen | Tag 1 |
| 3 | Freigabe der ADRs (`ARCHITECTURE.md` §2), insbesondere Node 24 LTS, Next.js, PostgreSQL/PostGIS, Drizzle, Auth-Bibliothek | Freigeben oder Änderungen benennen | Tag 1 |
| 4 | Lizenz: keine Lizenzdatei (= alle Rechte vorbehalten) | Bewusst so belassen, solange proprietär | Tag 1 |
| 5 | GitHub-Einstellungen: Secret Scanning, Push Protection, Private Vulnerability Reporting | Aktivieren | Tag 1 |
| 6 | Zahlungsanbieter, Buchhaltungs-/Rechnungsweg (inkl. E-Rechnung) | Entscheidung + Testzugang | Tag 6 |
| 7 | Payment-Policy-Defaults (`PRODUCT_SPEC.md` §6.3) | Bestätigen | Tag 6 |
| 8 | Rechtliche Prüfung: Akquise-Kanäle (§ 7 UWG), Partner-Modell, AGB, BFSG | Rechtsberatung | Tag 3 / 5 |
| 9 | Zulässige Lead-Quellen mit API-Zugang | Auswahl + Nutzungsbedingungen | Tag 3 |
| 10 | Hosting (EU), Domain, E-Mail-Versand | Entscheidung | Tag 10 |
| 11 | Soll `cleaning-platform-gelsenkirchen` noch eine Rolle spielen? | Nein – dieses Repository ist maßgeblich (Entscheidung in dieser Session) | – |

## 12. Risiken

| Risiko | Wahrscheinlichkeit | Auswirkung | Gegenmaßnahme |
| --- | --- | --- | --- |
| Öffentliches Repository legt Geschäftsregeln/Architektur offen | hoch (Ist-Zustand) | mittel | Auf privat stellen |
| Feature-Branch ist Default-Branch; kein Branch-Schutz | hoch (Ist-Zustand) | mittel | Punkt 11.1 |
| 10-Tage-Ziel bei Start ohne Code | mittel | hoch | Umfang reduzieren, Qualitätsschranken fix (ROADMAP) |
| Offene Anbieter- und Rechtsfragen blockieren Tag 3/6/10 | mittel | hoch | Fristen aus §11 einhalten |
| Keine Lead-Datenquelle vereinbart | hoch | mittel | Tag 3 mit manuellen Quellen + Website-Anfragen starten |
| Scheinselbstständigkeit/Arbeitnehmerüberlassung im Partner-Modell | unbekannt | hoch | Rechtliche Prüfung vor Tag 5 |
| Abweichung Node 22 (Container) vs. Node 24 (ADR) | niedrig | niedrig | `.nvmrc` + CI in Phase 1 |

## 13. Empfohlener nächster Schritt

1. Offene Punkte **11.1 – 11.5** entscheiden (Default-Branch, Sichtbarkeit, ADRs,
   Lizenz, GitHub-Sicherheitseinstellungen).
2. Danach **Phase 1 (Tag 1)** gemäß `PHASE_STATUS.md` §7 starten: Monorepo, TypeScript
   strict, Lint/Format, Vitest, Env-Validierung, `packages/core` testgetrieben,
   CI-Erweiterung um Typecheck/Lint/Test/Build, Dependency Review und CodeQL.

Phase 1 wird **nicht** ohne Freigabe gestartet.

## 14. Git-Referenzen

| Objekt | ID |
| --- | --- |
| Foundation-Commit | `1ed1737f2b81f8694fc4874390e7829ea4d1c38c` |
| Report-Commit | Folgecommit auf `claude/untitled-session-mhhecl` (ein Commit kann seine eigene ID nicht enthalten; die ID steht in der Abschlussmeldung und in `git log`) |
| Vorheriger Stand | kein Commit (leeres Repository) |

## 15. Statusmeldung

```text
PHASE 0 COMPLETE
```

Bedingungen: Die Foundation ist erstellt und verifiziert. Die in §11 genannten
Entscheidungen (insbesondere Default-Branch, Sichtbarkeit, ADR-Freigabe) sind
Voraussetzung für den Start von Phase 1, blockieren aber nicht den Abschluss von
Phase 0.
