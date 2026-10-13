# Phase 1 – Integration Gate (Tag 1–7)

Stand: 2026-10-13, live über GitHub-API und Git geprüft (nicht aus älteren Berichten
übernommen). Es wurde nichts gemergt, kein Branch gelöscht, kein Force-Push ausgeführt und
keine Repository-Einstellung verändert.

**Status: `BLOCKED`** – Grund: Owner-Einstellungen (Dependency Graph, Branch-Schutz) fehlen.
Im Code gibt es keinen offenen kritischen oder hohen Befund, solange der Stapel wie in §6
beschrieben integriert wird.

## 1. Repository-Zustand

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

## 2. PR-Stapel (tatsächliche Abhängigkeiten)

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
| #8 | `phase-1-day-7` | dieser Commit² | #7 `5188c43` | 62 | unstable¹ |

¹ `unstable` = konfliktfrei mergebar, aber ein Check rot (Dependency Review).
² Vor diesem Bericht `b37675b`; der Bericht ist ein reiner Doku-Commit obendrauf.

Keine Merge-Konflikte, keine doppelten Commits, keine widersprüchlichen Änderungen (lineare
Historie). Migrationen `0000`–`0008` sind append-only: Jede SQL-Datei ist auf allen späteren
Branches byte-identisch; jeder Tag fügt genau eine Migration hinzu.

## 3. CI je aktuellem Head-SHA

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
vorübergehend rot (Audit, F1); jeder Schritt muss vor dem nächsten erneut geprüft werden.
Nicht empfohlen. Squash- oder Rebase-Merges sind für beide Varianten ausgeschlossen, weil sie
die Basis der darüberliegenden PRs zerstören.

## 7. Owner-Aktionen (offen)

| # | Aktion | Wo | Blockiert |
| --- | --- | --- | --- |
| O1 | Dependency Graph aktivieren, CI-Run von #8 neu starten | Settings → Code security | Merge |
| O2 | Branch-Schutz `main` | Settings → Branches / Rules | Merge |
| O3 | Default-Branch → `main` | Settings → General | Merge (empfohlen) |
| O4 | Merge-Freigabe gemäß §6 | PR #8 | Day 8 |

## 8. Entscheidung

`BLOCKED` – O1 (Dependency Review) ist ein Pflicht-Gate und derzeit nicht erfüllbar; O2/O3
fehlen. Nach O1–O3 und grüner CI auf dem Head von #8 ist der Stapel über den Merge von #8
(§6) bereit für eine kontrollierte Integration. Day 8 beginnt erst danach.
