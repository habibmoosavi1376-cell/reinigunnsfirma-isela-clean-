# Phase 1 – Integration Gate (Tag 1–7)

Letzte Prüfung: **2026-10-20**, live über GitHub-API und Git. Erstprüfung 2026-10-13 (§1–§8);
§1–§3 und §9–§10 sind **historische Ergebnisse** und gelten nur für die dort genannten Commits.
Maßgeblich ist §0. Es wurde nichts gemergt, kein Branch gelöscht, kein Force-Push ausgeführt
und keine Repository-Einstellung verändert.

**Status: `BLOCKED`** – Dependency Graph, Dependency Review und Default-Branch sind jetzt
erfüllt (§0). Offen ist allein der wirksame Schutz von `main`: Das Ruleset „main“ ist aktiv und
enthält die richtigen Regeln, gilt aber für **keinen** Branch (leere Zielauswahl). Im Code gibt
es keinen offenen kritischen oder hohen Befund; F6 ist auf `phase-1-day-7` behoben.

## 0. Aktueller Stand (maßgeblich, 2026-10-20, zweiter Recheck)

Geprüfter PR-#8-Head: `c245c4ea3a55ae5526c6962ac04d667d13acebe3` (offen, nicht gemergt). Der
Commit, der diesen Abschnitt schreibt, ist ein reiner Doku-Commit; seine CI wird im Chat-Bericht
bzw. im nächsten Recheck belegt.

| Owner-Einstellung | Live-Befund | Ergebnis |
| --- | --- | --- |
| O1 Dependency Graph | SBOM-Endpunkt liefert Daten; Dependency Review läuft und ist grün | PASS |
| O3 Default-Branch | `default_branch=main` | PASS |
| O2 Schutz `main` | Ruleset 25481587 „main“, `enforcement=active`, Regeln korrekt (Löschen verboten, kein Force-Push, PR erforderlich mit 0 Approvals, 11 Pflicht-Checks aus §7, App GitHub Actions, `strict=false`); **`conditions.ref_name.include = []`** → `GET /rules/branches/main` liefert 0 Regeln; klassischer Schutz `protected=false` | **BLOCKED** |

Korrekturversuch der Session: `PUT /rulesets/25481587` mit `include: ["~DEFAULT_BRANCH"]` →
HTTP 403 „Write access to this GitHub API path is not permitted through this proxy“ (die
Session-Credentials zeigen `admin: true`, der Proxy sperrt jedoch Schreibzugriffe auf
Einstellungen). Nichts wurde geändert.

| Workflow-Run (Head `c245c4e`) | Job | Job-ID | Ergebnis |
| --- | --- | --- | --- |
| CI pull_request 39439999231 | Dependency review (pull requests) | 118687003267 | PASS |
| | Typecheck, lint, unit tests, build | 118687003389 | PASS |
| | Integration tests (PostgreSQL + PostGIS) | 118687003325 | PASS |
| | E2E (Playwright, production build, PostgreSQL + PostGIS) | 118687003677 | PASS |
| | Web build (production) and client-bundle secret scan | 118687003186 | PASS |
| | Dependency audit and license policy | 118687003768 | PASS |
| | Secret scan (gitleaks) | 118687002621 | PASS |
| | Repo guard (forbidden files) | 118687003679 | PASS |
| | Markdown lint | 118687003198 | PASS |
| | Workflow lint (actionlint) | 118687003113 | PASS |
| CI push 39439990298 | alle Jobs; Dependency review per `if: pull_request` übersprungen | – | PASS / NOT RUN |
| CodeQL 39439999241 | Analyze (JavaScript/TypeScript) | 118687001807 | PASS |

Pflichtprüfungen sind echt blockierend: kein `continue-on-error` in `ci.yml`/`codeql.yml`;
Dependency Review mit `fail-on-severity: moderate` und Lizenz-Denylist. Der Vorlauf auf
`c1b76a5` (Run 39424123975, Attempt 2, Job 118685711917) meldete keine verwundbaren und keine
verbotenen Pakete; 97 Einträge ohne erkannte Lizenz sind ausschließlich interne
`@isela/*`-Workspace-Pakete.

**Verbleibender Blocker (Owner):** Ruleset auf `main` ausrichten – *Settings → Rules →
Rulesets → „main“ → Target branches → Add target → „Include default branch“* (oder „Include by
pattern“ `main`) → *Save changes*. Danach muss `GET /repos/{repo}/rules/branches/main` die
Regeln `deletion`, `non_fast_forward`, `pull_request`, `required_status_checks` liefern.
Empfohlen: erlaubte Merge-Methoden auf „Merge“ beschränken (§6).

## 0a. Stand vor den Owner-Änderungen (historisch, Head `819cb59`)

Geprüfter PR-#8-Head: `819cb5912ac057666eb002150cca02ba188e2ba9` (offen, kein Draft, nicht
gemergt, `mergeable_state=unstable`, d. h. konfliktfrei, aber ein Check rot). Ein späterer
reiner Doku-Commit mit diesem Abschnitt löst einen neuen CI-Lauf aus; dessen Ergebnis ist hier
nicht enthalten und muss im Recheck geprüft werden.

| Workflow-Run | Job | Job-ID | Ergebnis |
| --- | --- | --- | --- |
| CI pull_request 39423000790 | Typecheck, lint, unit tests, build | 118628416378 | PASS |
| | Integration tests (PostgreSQL + PostGIS) | 118628416328 | PASS |
| | E2E (Playwright, production build, PostgreSQL + PostGIS) | 118628416607 | PASS |
| | Web build (production) and client-bundle secret scan | 118628416748 | PASS |
| | Dependency audit and license policy | 118628416539 | PASS |
| | Secret scan (gitleaks) | 118628416021 | PASS |
| | Repo guard (forbidden files) | 118628416443 | PASS |
| | Markdown lint | 118628416603 | PASS |
| | Workflow lint (actionlint) | 118628416427 | PASS |
| | Dependency review (pull requests) | 118628416448 | **BLOCKED** (Repository-Einstellung) |
| CI push 39422992841 | alle Jobs; Dependency review per `if: pull_request` übersprungen | – | PASS / NOT RUN |
| CodeQL pull_request 39423000695 | Analyze (JavaScript/TypeScript) | 118628414198 | PASS |

Weitere Runs für diesen Head: keine.

**Bestätigte Ursache Dependency Review** (Log Job 118628416448): „Dependency review is not
supported on this repository. Please ensure that Dependency graph is enabled“. Der Job lief mit
`contents: read`, `metadata: read`; das reicht für die Action (Schreibrechte bräuchte sie nur
für `comment-summary-in-pr`, das nicht genutzt wird). Workflow-Konfiguration geprüft: Action
per SHA gepinnt (v5.0.0), `fail-on-severity: moderate`, Lizenz-Denylist, kein
`continue-on-error`. Der Fehler liegt ausschließlich an der Repository-Einstellung; der
Workflow bleibt unverändert.

**Einstellungen (verifiziert):** `default_branch` = `claude/untitled-session-mhhecl`;
`main` `protected=false`; 0 Rulesets; SBOM-Endpunkt 404; Dependabot-Alerts „disabled“. Die
Repository-Metadaten zeigen für das Session-Konto `admin: true`, der GitHub-Proxy der
Claude-Code-Session blockiert Schreibzugriffe auf Einstellungen jedoch mit HTTP 403 (§10).
Keine dieser Einstellungen wurde geändert.

## 1. Repository-Zustand (historisch, 2026-10-13)

| Punkt | Befund |
| --- | --- |
| Default-Branch | `claude/untitled-session-mhhecl` (Head von PR #1) |
| `main` | `29d82a9bb6845b0c2be6c7a3f48a60185495a920` – nur Phase-0-Doku, Guards, CI |
| `main` geschützt | **nein** (`protected=false`); Schutzregeln/Rulesets per Integration nicht lesbar (403) |
| Dependency Graph | **deaktiviert** (Dependency Review: „not supported … ensure that Dependency graph is enabled“; Dependabot-Alerts: „disabled“; SBOM-Endpunkt 404) |
| Code-Scanning-Alerts | per Integration nicht lesbar (403); CodeQL-Checks auf allen Heads grün |

### Warum `claude/untitled-session-mhhecl` Default-Branch ist

Der Branch wurde bei der ersten Session (Phase 0.1) als Arbeitsbranch angelegt und ist seither
Default. Die Session-Werkzeuge haben keinen Zugriff auf Repository-Einstellungen; die
Umstellung ist seit `docs/PHASE_0_1_REPORT.md` (B1) als Owner-Aktion offen. `main` ist
vollständig vorhanden, Vorfahre jedes PR-Branches und damit als Integrationsziel geeignet.

## 2. PR-Stapel (tatsächliche Abhängigkeiten, Stand 2026-10-13)

Alle PRs zielen auf `main` @ `29d82a9`, alle offen, keiner Draft, keiner gemergt. Die
Abhängigkeit wurde per `git merge-base --is-ancestor` geprüft, nicht aus Nummern abgeleitet:
jeder Head ist Vorfahre des nächsten – eine streng lineare Kette ohne Abzweigungen.

| PR | Branch | Head | Basis (= Head des Vorgängers) | Commits ggü. `main` | Mergeability |
| --- | --- | --- | --- | --- | --- |
| #1 | `claude/untitled-session-mhhecl` | `9c0ffdc` | `main` `29d82a9` | 2 | clean |
| #2 | `phase-1-foundation` | `619c38c` | #1 `9c0ffdc` | 7 | unstable¹ |
| #3 | `phase-1-day-2` | `f971307` | #2 `619c38c` | 14 | unstable¹ |
| #4 | `phase-1-day-3` | `39767a8` | #3 `f971307` | 23 | unstable¹ |
| #5 | `phase-1-day-4` | `b798531` | #4 `39767a8` | 41 | unstable¹ |
| #6 | `phase-1-day-5` | `51d8110` | #5 `b798531` | 49 | unstable¹ |
| #7 | `phase-1-day-6` | `5188c43` | #6 `51d8110` | 55 | unstable¹ |
| #8 | `phase-1-day-7` | aktueller Head² | #7 `5188c43` | 62 | unstable¹ |

¹ `unstable` = konfliktfrei mergebar, aber ein Check rot (Dependency Review).
² Geprüft wurde `b37675b`; darauf folgen der Bericht (`c49c1f0`) und der Fix für F6.

Keine Merge-Konflikte, keine doppelten Commits, keine widersprüchlichen Änderungen (lineare
Historie). Migrationen `0000`–`0008` sind append-only: Jede SQL-Datei ist auf allen späteren
Branches byte-identisch; jeder Tag fügt genau eine Migration hinzu.

## 3. CI je Head-SHA (historisch, 2026-10-13)

| PR | Head | CI (push) | CI (pull_request) | CodeQL | Rot |
| --- | --- | --- | --- | --- | --- |
| #1 | `9c0ffdc` | 36281477835 ✅ | 36281487869 ✅ | – | – |
| #2 | `619c38c` | 36283784104 ✅ | 36283810921 ❌ | 36283811004 ✅ | Dependency review |
| #3 | `f971307` | 36286308179 ✅ | 36286310967 ❌ | 36286310984 ✅ | Dependency review |
| #4 | `39767a8` | 36288489056 ✅ | 36288491831 ❌ | 36288491812 ✅ | Dependency review |
| #5 | `b798531` | 36291480485 ✅ | 36291482417 ❌ | 36291482419 ✅ | Dependency review |
| #6 | `51d8110` | 36641692613 ✅ | 36641699171 ❌ | 36641699180 ✅ | Dependency review |
| #7 | `5188c43` | 36713987113 ✅ | 36713993436 ❌ | 36713993431 ✅ | Dependency review |
| #8 | `b37675b` | 38336146489 ✅ | 38336151731 ❌ | 38336151777 ✅ | Dependency review |
| #8 | `c49c1f0` (Doku) | 38475194646 ❌ | 38475200166 ❌ | 38475200106 ✅ | E2E (F6, zeitabhängig), Dependency review |

Je Head: alle übrigen Jobs grün (Typecheck/Lint/Unit/Build, Integration, E2E, Web-Build +
Client-Bundle-Secret-Scan, Audit/Lizenzen, gitleaks, actionlint, markdownlint, Forbidden Files).
Die einzige Ursache für Rot ist bei allen identisch: Dependency Graph deaktiviert.

**Wichtig:** Die grünen Audit-Jobs von #2–#7 stammen vom 27.–30.09. Sie belegen **nicht** den
heutigen Stand – siehe Befund F1.

## 4. Reviews und Threads

- Keine menschlichen Reviews, keine „changes requested“, keine offenen Review-Threads.
- #3: CodeQL „Incomplete string escaping“ (`apps/web/tests/support/smtp-sink.ts`) – der
  betroffene Code ist im Stapel ersetzt (kein Regex aus Eingaben mehr); CodeQL auf allen
  späteren Heads grün.
- #6: CodeQL „Replacement of a substring with itself“ – behoben in `0eed7a7`, im Thread beantwortet.

## 5. Befunde

| ID | Schwere | Befund | Beleg | Behandlung |
| --- | --- | --- | --- | --- |
| F1 | **Hoch** | Heads #3–#7 (`next` 16.3.6, `source-map-js` < 1.2.2) fallen **heute** durch `pnpm audit --audit-level=moderate`: 7 Advisories, davon 2 high (Next.js SSRF im Image-Optimizer, source-map-js Event-Loop-DoS). Behoben erst in #8 (`next` 16.3.8, Override `source-map-js` 1.2.2). | `pnpm audit` im Worktree von `origin/phase-1-day-6` am 2026-10-13 | Integrationsplan §6: kein Zwischenstand #3–#7 darf einzeln auf `main` landen; sonst wird `main` rot und angreifbar. Kein Code-Fix in den unteren PRs nötig, wenn §6 befolgt wird. |
| F2 | **Hoch (Owner)** | Dependency Review läuft nicht (Dependency Graph aus) – Lizenz- und Advisory-Prüfung neuer Abhängigkeiten auf PR-Ebene fehlt. | Log Job 115095448104 | Owner-Aktion O1. Wird nicht deaktiviert oder umgangen. |
| F3 | Mittel (Owner) | `main` ohne Branch-Schutz; Default-Branch ist ein Arbeitsbranch. Direkt-Pushes und Merges ohne grüne Checks möglich. | `branches/main` → `protected=false` | Owner-Aktionen O2, O3 |
| F4 | Niedrig | `pg`-Deprecation „client.query() when the client is already executing a query“ im E2E-Log: Lesezugriffe per `Promise.all` auf demselben Client (z. B. `operations/bookings.ts` `getBooking`, `billing/invoices.ts` `getInvoice`, `billing/risk.ts`). Heute von `pg` serialisiert, also korrekt; bricht mit `pg@9`. Nur Lesezugriffe, kein Finanzschreibpfad. | E2E-Log Day 7 | Follow-up vor einem `pg@9`-Upgrade (sequenzielle Reads); kein Merge-Blocker |
| F5 | Info | Next-Server-Log „destination stream closed early“ in E2E – abgebrochene Streams bei Navigation, keine Testfehler, keine Daten betroffen. | E2E-Log Day 7 | beobachten |
| F6 | **Mittel (behoben)** | Zahlungseingang „heute“ wurde zwischen lokaler und UTC-Mitternacht (Europe/Berlin 00:00–02:00) als Zukunftsdatum abgelehnt: Das Formular liefert das Geschäftsdatum, die Action machte daraus `YYYY-MM-DDT00:00:00Z`. Zusätzlich lag `received_at` 1–2 h neben dem lokalen Tagesbeginn. Eingeführt in Tag 6 (#7). | CI-Runs 38475194646/38475200166 (E2E rot um 22:05 UTC); lokal reproduziert um 00:1x MESZ gegen den unveränderten Build | Fix auf `phase-1-day-7`: `businessDayStartIso` (Tagesbeginn in der Geschäftszeitzone) in `recordPaymentAction`; Regressionstests `apps/web/tests/unit/business-time.test.ts`; E2E 26/26 im Fehlerfenster (00:14 MESZ) |
| F7 | Niedrig | Weitere Datumsfilter interpretieren `YYYY-MM-DD` als UTC-Mitternacht (Lead-/Kunden-/Job-Listenfilter, Berichtszeitraum, `quotes/config.ts`, `format.ts`). Grenzen um bis zu 2 h verschoben; keine Finanz-Schreibpfade. | `grep T00:00:00` | Follow-up: einheitlich `businessDayStartIso` verwenden |

### Geprüfte Schutzregeln (kein Befund)

- **Vorkasse:** `evaluatePaymentTerms` (`packages/payment-risk/src/evaluate.ts`) – 0 bezahlte
  Aufträge → `NEW_CUSTOMER`, < Minimum → `INSUFFICIENT_PAID_ORDERS` ⇒ `VORKASSE_REQUIRED`
  für Neukunden sowie Aufträge 1 und 2.
- **Kreditbedingungen:** `minSuccessfulPaidOrders` ≥ 3 (Schema-Untergrenze); gezählt werden
  nur Buchungen `COMPLETED` **und** Rechnung `PAID` (`history.ts`); `requireManualApproval`
  ist Literal `true` – ohne genehmigte Kreditentscheidung bleibt es bei Vorkasse.
- **Überfällige Forderungen:** `maxOpenOverdueInvoices` = Literal 0,
  `revertToPrepaymentOnOverdue` = Literal `true`; Chargebacks Literal 0; Teilzahlung zählt nie
  als bezahlt.
- **Finanz-Idempotenz (DB-erzwungen):** `payment_idempotency_key_uq`,
  `payment_provider_payment_uq`, `payment_reference_provider_uq`, `payment_provider_event_uq`
  (Webhook-Replays), `invoice_booking_active_uq` (eine aktive Rechnung je Buchung),
  `booking_quote_uq`, `job_booking_uq`; 23505-Rennen werden auf das Bestandsobjekt aufgelöst.
- **Formular-Idempotenz:** Einmal-Token, nur HMAC gespeichert, Unique-Index für Anfrage und
  Rückruf (Migration 0008).
- **Anbieter:** `PAYMENT_PROVIDER` muss leer sein („not supported yet“),
  `ANALYTICS_PROVIDER` nur `none`, Geocoding nur optional `geoapify` mit Schlüssel. Kein aktiver
  Zahlungs- oder Analytics-Anbieter.
- **Rechtstexte/Firmendaten:** Impressum und Datenschutz als Entwurf gekennzeichnet; keine
  erfundenen Firmendaten.
- **Secrets:** gitleaks grün auf allen Heads; Forbidden-Files-Guard grün.

## 6. Geprüfte Merge-Reihenfolge und Voraussetzungen

Voraussetzungen (Owner, vor jedem Merge):

1. **O1** Dependency Graph aktivieren: *Settings → Code security → Dependency graph → Enable*.
   Danach in PR #8 „Re-run failed jobs“ für den CI-Run auslösen; Dependency Review muss grün
   sein (bei Befunden: beheben, nicht umgehen).
2. **O2** Branch-Schutz für `main`: *Settings → Branches → Add rule* (oder Ruleset) – PR
   erforderlich, erforderliche Checks inkl. „Dependency review (pull requests)“, keine
   Force-Pushes, keine Löschung.
3. **O3** Default-Branch auf `main`: *Settings → General → Default branch → `main` → Update*.

Empfohlene Integration (eine kontrollierte Zusammenführung):

1. Nach O1–O3: CI auf dem aktuellen Head von #8 vollständig grün (inkl. Dependency Review).
2. **PR #8 per Merge-Commit** (kein Squash, kein Rebase) in `main` mergen. #8 enthält
   #1–#7 vollständig (lineare Kette); GitHub markiert #1–#7 dann automatisch als gemergt.
   So landet kein durch F1 verwundbarer Zwischenstand auf `main`, und die Commit-Historie
   aller Tage bleibt erhalten.
3. CI auf `main` nach dem Merge prüfen (push-Run grün).
4. Migrationen `0000`–`0008` in Staging gegen eine Kopie anwenden (append-only; Upgrade-Test
   0000–0007 → 0008 mit Daten ist lokal belegt, siehe `PHASE_1_DAY_7_REPORT.md`).

Alternative (nur wenn eine Einzelfreigabe je Tag gewünscht ist): #1 → #2 → … → #8 jeweils per
Merge-Commit, **ohne** Deployment zwischen den Schritten. Dann ist `main` zwischen #3 und #8
vorübergehend rot (Audit, F1) und enthält zwischen #7 und #8 den Zahlungsdatumsfehler F6; jeder Schritt muss vor dem nächsten erneut geprüft werden.
Nicht empfohlen. Squash- oder Rebase-Merges sind für beide Varianten ausgeschlossen, weil sie
die Basis der darüberliegenden PRs zerstören.

## 7. Owner-Aktionen (offen)

| # | Aktion | Wo | Blockiert |
| --- | --- | --- | --- |
| O1 | Dependency Graph aktivieren, CI-Run von #8 neu starten | Settings → Code security | Merge |
| O2 | Branch-Schutz `main` | Settings → Branches / Rules | Merge |
| O3 | Default-Branch → `main` | Settings → General | Merge (empfohlen) |
| O4 | Merge-Freigabe gemäß §6 | PR #8 | Day 8 |

Links: O1 [Security analysis](https://github.com/habibmoosavi1376-cell/reinigunnsfirma-isela-clean-/settings/security_analysis),
O2 [Branches](https://github.com/habibmoosavi1376-cell/reinigunnsfirma-isela-clean-/settings/branches),
O3 [General](https://github.com/habibmoosavi1376-cell/reinigunnsfirma-isela-clean-/settings).

Erforderliche Status-Checks für O2 – exakt die `name:`-Werte aus `.github/workflows/ci.yml`
und `codeql.yml`, abgeglichen mit den Check-Runs auf `819cb59`:

- `Typecheck, lint, unit tests, build`
- `Integration tests (PostgreSQL + PostGIS)`
- `E2E (Playwright, production build, PostgreSQL + PostGIS)`
- `Web build (production) and client-bundle secret scan`
- `Dependency audit and license policy`
- `Secret scan (gitleaks)`
- `Repo guard (forbidden files)`
- `Markdown lint`
- `Workflow lint (actionlint)`
- `Analyze (JavaScript/TypeScript)` (CodeQL-Workflow)
- `Dependency review (pull requests)` – läuft nur bei `pull_request`; als Pflicht-Check
  geeignet, weil Merges nach `main` nur per PR erfolgen. Erst wählbar/grün nach O1.

Nicht verlangen: den von GitHub Advanced Security erzeugten Sammel-Check `CodeQL` zusätzlich
zu `Analyze …` (doppelt) und keine Checks, die es nicht gibt. Pull Request erforderlich,
0 Pflicht-Approvals (sonst blockiert sich der einzige Maintainer), „Require branches to be up to
date“ aus, Force-Push und Löschen verboten.

Nach O1–O3 notwendige Prüfungen: (1) SBOM-/Dependency-Graph-Endpunkt liefert Daten;
(2) Job „Dependency review (pull requests)“ auf dem dann aktuellen PR-#8-Head neu starten → PASS
oder Findings regulär beheben; (3) alle übrigen Jobs und CodeQL auf diesem Head PASS;
(4) `main` `protected=true` mit genau den obigen Checks; (5) `default_branch=main`.
Erst dann `READY FOR CONTROLLED MERGE`.

## 8. Entscheidung

`BLOCKED` – O1 (Dependency Review) ist ein Pflicht-Gate und derzeit nicht erfüllbar; O2/O3
fehlen. Nach O1–O3 und grüner CI auf dem Head von #8 ist der Stapel über den Merge von #8
(§6) bereit für eine kontrollierte Integration. Day 8 beginnt erst danach.

## 9. Recheck 2026-10-20 (historisch, Head `0ced9af`)

Live geprüft; Head von PR #8 unverändert `0ced9afcd8262979e5d2a6be6918a7c7ab3a543a`.

| Gate | Ergebnis |
| --- | --- |
| Dependency Graph | **weiterhin deaktiviert** (SBOM-Endpunkt 404, Dependabot-Alerts „disabled“) |
| `main` geschützt | **nein** (`protected=false`) |
| Default-Branch | **weiterhin** `claude/untitled-session-mhhecl` |
| CI pull_request, Run 38476763094, Attempt 2 (neu gestartet) | alle Jobs grün außer Dependency review (Job 118623189451: „Dependency review is not supported on this repository“) |
| CI push, Run 38476755768 | grün |
| CodeQL, Run 38476763090 | grün |
| `pnpm audit --audit-level=moderate` (lokal, heute) | „No known vulnerabilities found“ |
| Regressionstests F6 (`business-time.test.ts`) | 4/4 grün; Unit gesamt 924/924 |

Status bleibt **`BLOCKED`**. Verbleibende Maßnahmen: O1 (Dependency Graph aktivieren, danach
Job „Dependency review“ in Run 38476763094 neu starten), O2 (Branch-Schutz `main`), O3
(Default-Branch → `main`). Danach ist PR #8 der Merge-Commit-Kandidat.

## 10. Versuch, die Owner-Einstellungen zu übernehmen (2026-10-20, historisch, Head `8423c2d`)

Das Konto der Session hat auf dem Repository `admin`-Rechte, aber der GitHub-Proxy der
Claude-Code-Session lässt Schreibzugriffe auf Repository-Einstellungen grundsätzlich nicht zu
(HTTP 403). Keine der drei Einstellungen wurde geändert:

| Einstellung | API-Aufruf | Ergebnis |
| --- | --- | --- |
| Dependency Graph / Alerts | `PUT /vulnerability-alerts`, `PATCH /repos/{repo}` (`security_and_analysis`) | 403 „not permitted through this proxy“ |
| Branch-Schutz `main` | `PUT /branches/main/protection`, `POST /rulesets` | 403 „Write access … not permitted through this proxy“ |
| Default-Branch | `PATCH /repos/{repo}` (`default_branch`) | 403 „Repository settings writes are not permitted“ |

Nachgeprüft: `default_branch` = `claude/untitled-session-mhhecl`, `main` `protected=false`,
0 Rulesets, SBOM-Endpunkt 404.

CI auf PR-#8-Head `8423c2d`: CI push 39421712727 ✅; CI pull_request 39421725038 – alle Jobs grün,
Dependency review nach Neustart (Attempt 2, Job 118627675775) weiterhin rot (Dependency
Graph aus); CodeQL 39421724982 ✅.

Status bleibt **`BLOCKED`** – O1–O3 müssen manuell in den GitHub-Einstellungen erfolgen.
