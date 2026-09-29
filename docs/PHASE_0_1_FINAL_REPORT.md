# ISELA CLEAN – Phase 0.1 Final Report

| Feld | Wert |
| --- | --- |
| Datum | 2026-09-27 |
| Repository | `habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` |
| Foundation-Stand | `29d82a9bb6845b0c2be6c7a3f48a60185495a920` (`main`) |
| Arbeitsstand vor diesem Report | `91761310d161b05bf27d6f16ca471c3c50eb3858` |
| Ergebnis | **PHASE 0.1 FINALIZATION BLOCKED** – ausschließlich Owner-Aktionen offen (§10) |

Es wurde **kein** Anwendungscode, keine Datenbank, keine Auth, kein CRM erstellt.
Phase 0 wurde nicht wiederholt; keine Foundation-Datei wurde neu erstellt, verändert
oder dupliziert. `cleaning-platform-gelsenkirchen` wurde nicht angebunden.

## 1. Finaler Repository-Status

| Prüfung | Ergebnis |
| --- | --- |
| `git status` | Branch `claude/untitled-session-mhhecl`, up to date, Working Tree sauber |
| `git branch -a` | `claude/untitled-session-mhhecl`, `main`, `remotes/origin/claude/untitled-session-mhhecl`, `remotes/origin/main` |
| `git log --oneline --decorate -10` | `9176131` docs(phase-0.1) · `29d82a9` (tag: phase-0-complete, origin/main, main) docs(phase-0) · `1ed1737` docs(phase-0) |
| `git remote -v` | `origin` → `https://github.com/habibmoosavi1376-cell/reinigunnsfirma-isela-clean-` |
| `git rev-parse HEAD` | `91761310d161b05bf27d6f16ca471c3c50eb3858` |
| Commit `9176131` vorhanden? | Ja, auf dem Arbeitsbranch (lokal + remote); **nicht** auf `main` |

## 2. GitHub-Einstellungen

| Einstellung | Ist-Zustand | Status |
| --- | --- | --- |
| `main` vorhanden | ja, `29d82a9` | ✅ |
| `main` Default-Branch | nein – Default: `claude/untitled-session-mhhecl` | ⛔ Owner-Aktion |
| Visibility | `public` | ⛔ Owner-Aktion |
| Branch Protection / Ruleset `main` | `protected: false` | ⛔ Owner-Aktion |
| CI auf `main` | Lauf #3 auf `29d82a9`: success | ✅ |
| Tag `phase-0-complete` | lokal auf `29d82a9`; remote **nicht vorhanden** (GitHub API 404) | ⛔ Remote tag requires owner-side GitHub action. |
| Secret Scanning | mit den verfügbaren Werkzeugen **nicht auslesbar** | ⚠️ im UI prüfen |
| Push Protection | mit den verfügbaren Werkzeugen **nicht auslesbar** | ⚠️ im UI prüfen |

Die Session-Werkzeuge können Repository-Einstellungen nicht ändern; Tag-Pushes werden
von der Egress-Richtlinie der Umgebung mit HTTP 403 abgelehnt. Es wurde nichts
umgangen und kein erneuter Tag-Push versucht.

## 3. CI

| Lauf | Branch | Commit | Ergebnis |
| --- | --- | --- | --- |
| #1 | Arbeitsbranch | `1ed1737` | ✅ success |
| #2 | Arbeitsbranch | `29d82a9` | ✅ success |
| #3 | `main` | `29d82a9` | ✅ success |
| #4 | Arbeitsbranch | `9176131` | ✅ success |
| Dependabot (github-actions) | – | – | ✅ success, keine Updates nötig |

**CI: PASS.** Unit-, Integrations-, E2E-Tests, Typecheck und Application Build
existieren weiterhin nicht (kein Anwendungscode) und werden **nicht** als bestanden
gewertet.

## 4. Pull Request

Commit `9176131` lag nur auf dem Arbeitsbranch, es existierte kein PR. Ein Pull Request
`claude/untitled-session-mhhecl` → `main` wird mit diesem Report erstellt. Inhalt
ausschließlich Dokumentation: `README.md` (offizielles Repository),
`docs/PHASE_STATUS.md` (Verweis), `docs/PHASE_0_1_REPORT.md`, dieser Report.
Merge durch den Owner nach Prüfung.

## 5. Security-Prüfung

| Bereich | Befund | Bewertung |
| --- | --- | --- |
| Secret Protection (Repo) | gitleaks in CI über gesamte Historie, Repo-Guard, `.gitignore`; lokal erneut PASS in Phase 0.1 | PASS |
| `.env` | keine `.env`-Datei versioniert; `.env.example` nur leere Platzhalter | PASS |
| GitHub Actions | SHA-gepinnt, `permissions: contents: read`, `persist-credentials: false`, Tools per SHA-256 verifiziert, Timeouts gesetzt | PASS |
| Dependency Policy | Actions via Dependabot; für npm existiert noch keine Richtlinie (keine Abhängigkeiten vorhanden) | Lücke für Phase 1 (§8.4) |
| Branch Strategy | in `AGENTS.md`/`README.md` dokumentiert (Feature-Branch + PR), serverseitig **nicht** erzwungen | FAIL bis Ruleset aktiv |
| Auditability | Conventional Commits mit Session-Trailer, Phasenberichte, CI-Historie; Release-Tag nur lokal | teilweise – Tag fehlt remote |

Hinweis für die Ruleset-Konfiguration: **„Require review from Code Owners“ nicht
aktivieren**, solange der Owner allein arbeitet – GitHub erlaubt keine Freigabe eigener
PRs, der Owner würde sich aussperren (CODEOWNERS enthält nur den Owner).

## 6. Phase-1-Architekturprüfung

### 6.1 Abdeckung der Phase-1-Entitäten in der Dokumentation

| Bereich | Entität | Abgedeckt? | Fundstelle / Lücke |
| --- | --- | --- | --- |
| Identity | User, Roles, Permissions | ✅ | PRODUCT_SPEC §3, SECURITY §3 |
| Identity | Authentication | ⚠️ teilweise | Sessions, Passwort-Hashing, MFA für Admins in SECURITY §4; **fehlt**: E-Mail-Verifizierung, Passwort-Reset-Flow, Konto-Sperre nach Fehlversuchen, Einladungsflow für B2B-/Partner-Nutzer |
| Identity | Authorization | ✅ | SECURITY §3 (Policy-Funktion, IDOR, RBAC-Matrix) |
| CRM | Customer | ✅ | PRODUCT_SPEC §4 |
| CRM | CustomerAddress | ❌ | nur „Property“ genannt; Rechnungs- vs. Einsatzadresse, Geocoding-Status nicht spezifiziert |
| CRM | Property | ✅ | PRODUCT_SPEC §4 |
| CRM | Lead, LeadSource | ✅ | PRODUCT_SPEC §5, ARCHITECTURE §7 |
| CRM | LeadContact | ❌ | Kontaktperson je Lead inkl. Herkunft/Rechtsgrundlage/Widerspruch nicht als Entität definiert |
| Business | Service | ✅ | PRODUCT_SPEC §1.1, §4 |
| Business | ServiceCategory | ❌ | Katalog datengetrieben beschrieben, Kategorie-Ebene fehlt |
| Business | ServiceArea | ✅ | PRODUCT_SPEC §2, ARCHITECTURE §5 |
| Business | City, PostalCode | ❌ | nicht spezifiziert (siehe §6.2) |
| Governance | AuditLog | ✅ (als `AuditEvent`) | Namensangleichung nötig |
| Governance | Settings | ⚠️ | Konfiguration als Prinzip (ARCHITECTURE §1.4) und PaymentPolicy, aber kein allgemeines, versioniertes Settings-Modell |
| Governance | Consent | ❌ | Rechtsgrundlage für Leads erwähnt; Einwilligungen (Marketing, Cookies, Bewertungsanfragen) mit Nachweis/Widerruf nicht modelliert |

**Bewertung:** Die Dokumentation reicht für die Richtung von Phase 1 aus, ist aber
**nicht vollständig**. Die sieben Lücken sollten als **erster Schritt von Phase 1**
in `PRODUCT_SPEC.md` ergänzt werden, bevor Schema-Code entsteht. In Phase 0.1 wurden
die Spezifikationen bewusst nicht geändert.

### 6.2 Architektur-Check: keine feste Kopplung an Gelsenkirchen

| Prüfpunkt | Befund |
| --- | --- |
| Vorkommen von „Gelsenkirchen“ | nur als Startmarkt in README, CLAUDE.md, PRODUCT_SPEC (Metadaten, Expansionsstufen) – nicht als Regel |
| Einsatzgebiete | als Daten (`CIRCLE` oder `POLYGON`), aktivierbar, Prüfung per PostGIS (`ST_DWithin`/`ST_Covers`) |
| Expansion | Datensatz-Update statt Deployment (ARCHITECTURE §5) |
| Preise/Leistungen/Partner | je Einsatzgebiet konfigurierbar (PRODUCT_SPEC §2) |
| Zeitzone/Währung/Sprache | als Konfiguration gefordert |
| Anfragen außerhalb des Gebiets | werden als Lead mit Kennzeichen erfasst (Nachfragesignal) |

**Ergebnis: PASS.** Die Kette Gelsenkirchen → 25 km → 50 km → Ruhrgebiet → NRW →
Deutschland ist ohne Architekturumbau abbildbar. Empfehlungen für Phase 1:

1. `City` und `PostalCode` sind **Referenzdaten**, nicht die Grundlage der
   Gebietszugehörigkeit. Postleitzahlen und Gemeinden stehen in einer
   **n:m-Beziehung** (eine PLZ kann mehrere Gemeinden umfassen und umgekehrt).
   Gebietszugehörigkeit wird über den geokodierten Punkt der Adresse bestimmt.
2. Gelsenkirchen existiert nur als **Seed-Datensatz** eines `ServiceArea`.
3. Ergänzung des Repo-Guards in Phase 1: CI-Prüfung, dass Städtenamen nicht in
   Quellcode unter `packages/modules/**` vorkommen (Ausnahmen: Seeds, Tests, Inhalte).

## 7. Technische Entscheidungen (Bewertung)

Bewertet anhand des tatsächlichen Projekts: Einzel-Owner, 10-Tage-MVP, DSGVO-Pflicht,
Geo-Anforderungen, Marketplace-Perspektive. Versionen per npm-Registry am 2026-09-27
geprüft.

### 7.1 Architekturstil: Modularer Monolith

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Annehmen** |
| Begründung | Ein Team, ein Deployment, eine Datenbank; Transaktionen über Module (Rechnung + Zahlungsbedingung) bleiben einfach |
| Alternative | Microservices – für MVP unverhältnismäßig (verteilte Transaktionen, Betrieb) |
| Skalierbarkeit | Horizontale Skalierung von Web/Worker ausreichend bis weit über NRW; einzelne Module später auslagerbar |
| Wartbarkeit | Hoch, **sofern** Modulgrenzen per Lint erzwungen werden |
| Sicherheit | Kleinere Angriffsfläche, zentrale Autorisierung |
| Entwicklungszeit | Am schnellsten |

### 7.2 Sprache: TypeScript (strict)

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Annehmen** |
| Begründung | Ein Typsystem von DB-Schema bis UI; Zod-Schemas erzeugen Typen |
| Alternative | Python/Django oder PHP/Laravel – stark bei Admin/CRUD, aber zwei Sprachen für Web-Frontend und Backend |
| Skalierbarkeit | neutral |
| Wartbarkeit | Hoch (Refactoring-Sicherheit) |
| Sicherheit | Weniger Typfehler an Grenzen; ersetzt keine Laufzeitvalidierung |
| Entwicklungszeit | Schnell, großes Ökosystem |

### 7.3 Web-Framework: Next.js (aktuell 16.x)

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Annehmen**, mit Einschränkung: Fachlogik bleibt außerhalb von Next.js |
| Begründung | SSR/SSG für Local SEO (Tag 7), Portale und Admin in einem Deployment |
| Alternative | Astro (Website) + separates API (Fastify/NestJS) – bessere Trennung, aber zwei Apps; Remix/React Router |
| Skalierbarkeit | Gut; stateless Server skalieren horizontal |
| Wartbarkeit | Mittel – häufige Major-Releases; Risiko durch Framework-Kopplung, daher Domain-Code framework-frei |
| Sicherheit | Server Actions sind öffentliche Endpunkte → jede Action braucht Validierung + Autorisierung; Framework-Sicherheitsupdates zeitnah einspielen |
| Entwicklungszeit | Schnell |

### 7.4 Datenbank: PostgreSQL

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Annehmen** (Version 16 oder neuer) |
| Begründung | Transaktionen für Rechnungen/Zahlungen, Constraints, JSONB, Volltext, Row-Level-Security als Option |
| Alternative | MySQL – schwächere Geo-/JSON-Funktionen; MongoDB – ungeeignet für Buchhaltungsintegrität |
| Skalierbarkeit | Bis Deutschland-Ebene mit Indizes/Read-Replicas ausreichend |
| Wartbarkeit | Hoch, Standard-Know-how |
| Sicherheit | Rollen/Least Privilege, RLS möglich, verschlüsselte Verbindungen |
| Entwicklungszeit | Neutral |

### 7.5 PostGIS

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Annehmen** – Geo-Funktionen sind fachlich erforderlich (Radius 25/50 km, Polygone Ruhrgebiet/NRW, Partnerzuweisung nach Entfernung) |
| Begründung | Korrekte, indizierte Distanz- und Enthaltensein-Abfragen in der DB |
| Alternative | Haversine in Anwendungscode + PLZ-Listen – ungenau, kein Polygon-Support, schlecht skalierbar |
| Skalierbarkeit | Hoch (GiST-Indizes) |
| Wartbarkeit | Gut; erfordert Hoster mit PostGIS-Unterstützung (Auswahlkriterium!) |
| Sicherheit | neutral |
| Entwicklungszeit | Gering höher (Setup), spart Aufwand bei Expansion |

### 7.6 ORM: Drizzle

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Drizzle annehmen** (aktuell 0.45.x) |
| Begründung | SQL-nah, typsicher, eigene Spaltentypen (PostGIS `geography`) sauber abbildbar, generiert reviewbare SQL-Migrationen |
| Alternative | Prisma – sehr gute DX, aber Geo-Typen nur als `Unsupported` + Raw-SQL; Kysely – Query-Builder ohne Schema-Verwaltung |
| Skalierbarkeit | Gut (dünne Abstraktion, kontrollierbare Queries) |
| Wartbarkeit | Mittel-hoch; **Risiko:** Versionsreihe noch vor 1.0 → Version im Lockfile fixieren, Updates bewusst |
| Sicherheit | Parametrisierte Queries; `sql`-Template-Tag korrekt verwenden, keine String-Konkatenation |
| Entwicklungszeit | Schnell |

### 7.7 Authentifizierung: Better Auth

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Better Auth** (aktuell 1.7.x, aktiv gepflegt) mit Datenbank-Sessions |
| Begründung | Self-hosted (Daten bleiben in eigener EU-DB), E-Mail/Passwort, Verifizierung, Reset, 2FA, Organisationen, Drizzle-Adapter |
| Alternative | Auth.js – v5 weiterhin nicht als stabile Hauptversion veröffentlicht (`next-auth` stable = 4.x), Credentials-Flow eingeschränkt; Lucia – als Bibliothek **deprecated**; externe Anbieter (Clerk, Auth0) – schnell, aber Personendaten beim Drittanbieter, Kosten pro Nutzer |
| Skalierbarkeit | Gut; DB-Sessions skalieren mit Postgres |
| Wartbarkeit | Mittel-hoch; RBAC-Logik bleibt **eigene** Policy-Schicht, nicht Plugin-gebunden |
| Sicherheit | HttpOnly-Cookies, Session-Rotation, Rate Limiting; Konfiguration per Integrationstests absichern |
| Entwicklungszeit | Schnell |

### 7.8 Job-Queue: pg-boss

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Annehmen** (aktuell 12.x) |
| Begründung | Jobs transaktional in derselben PostgreSQL; keine Zusatzinfrastruktur |
| Alternative | BullMQ + Redis – höherer Durchsatz, aber zusätzlicher Dienst |
| Skalierbarkeit | Ausreichend für Follow-ups, Wiederholungen, Mahnwesen; bei Bedarf später Redis |
| Wartbarkeit | Hoch |
| Sicherheit | Keine zusätzliche Angriffsfläche |
| Entwicklungszeit | Schnell |

**Konsequenz für Hosting:** Ein **dauerhaft laufender Worker-Prozess** ist nötig.

### 7.9 Hosting: Vercel vs. EU-Container-Hosting

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Portabel bauen, EU-Hosting wählen.** Build als Standard-Node-/Docker-Artefakt. Bevorzugt: **ein EU-Anbieter** für Web + Worker + verwaltete PostgreSQL mit PostGIS. Vercel ist für die Web-App möglich (EU-Region), aber **nicht** für den Worker |
| Begründung | pg-boss-Worker braucht einen Dauerprozess; ein Anbieter vereinfacht AV-Vertrag, Netzwerk, Backups |
| Alternative | Vercel (Web) + separater EU-DB-Anbieter + separater Worker-Host – beste Next.js-DX, aber drei Verträge/Datenflüsse und US-Anbieter (Drittlandtransfer prüfen) |
| Skalierbarkeit | Beide ausreichend; Container horizontal skalierbar |
| Wartbarkeit | Container: etwas mehr Betriebsaufwand; Vercel: weniger Betrieb, mehr Lock-in |
| Sicherheit/Datenschutz | EU-Anbieter vereinfachen DSGVO; bei Vercel DPA/Transfermechanismus prüfen |
| Entwicklungszeit | Vercel minimal schneller für Web; Unterschied gering, wenn Deployment an Tag 1 vorbereitet wird |

Entscheidung liegt beim Owner (Kosten, Verträge); **Auswahlkriterien:** EU-Region,
AV-Vertrag, PostgreSQL ≥ 16 **mit PostGIS**, Point-in-Time-Recovery, Dauerprozesse,
Secret-Store.

### 7.10 n8n für externe Automationen

| Aspekt | Bewertung |
| --- | --- |
| Empfehlung | **Nicht im MVP; nicht für Kernlogik.** Später optional für nicht-kritische Integrationen |
| Begründung | Geschäftsregeln (Payment Risk, Rechnungen, Zuweisung, Follow-up-Regeln) müssen versioniert, getestet und auditiert im Code liegen; n8n-Workflows liegen außerhalb von Tests/Code-Review und sind ein zweiter Ort für Secrets und personenbezogene Daten |
| Alternative | Eigene Automation über Outbox + pg-boss (im Plan); später n8n **self-hosted in der EU**, angebunden nur über signierte Webhooks aus der Outbox |
| Lizenz | n8n steht unter einer eigenen Lizenz („SEE LICENSE IN LICENSE.md“, fair-code) – vor Einsatz rechtlich prüfen, ob die geplante Nutzung abgedeckt ist |
| Skalierbarkeit | neutral |
| Wartbarkeit | Risiko „Schatten-Logik“ außerhalb des Repos |
| Sicherheit | Zusätzliche Angriffsfläche (Admin-UI, Credentials-Store) |
| Entwicklungszeit | Kurzfristig schneller für Integrationen, langfristig teurer |

## 8. Fachliche Prüfungen

### 8.1 LeadFinder-Architektur

Aktueller Stand (ARCHITECTURE §7): ein `LeadSource`-Port mit `id`, `legalBasis`,
`discover()`, idempotente Pipeline-Stufen, Entwürfe statt Versand. **Mehrere Quellen
sind grundsätzlich unterstützt.** Abgleich mit der gewünschten Struktur:

| Provider | Zweck | Heute verfügbare Quelle | Bewertung |
| --- | --- | --- | --- |
| `BusinessSearchProvider` | Firmen nach Branche/Region finden | **keine** vereinbart | Nur lizenzierte APIs, deren Nutzungsbedingungen **Speicherung im CRM erlauben** (viele Karten-/Places-APIs beschränken das). Vor Tag 3 prüfen |
| `PublicOpportunityProvider` | Öffentliche Ausschreibungen/Aufträge | keine angebunden | Kandidaten: offizielle Ausschreibungsportale mit dokumentierten Schnittstellen; Verfügbarkeit und Bedingungen in Phase 3 verifizieren |
| `WebsiteResearchProvider` | Öffentliche Website eines bereits bekannten Unternehmens auswerten | – | Nur öffentlich zugängliche Seiten, `robots.txt` beachten, Rate Limit, SSRF-geschützter HTTP-Client; **keine** Login-, CAPTCHA- oder ToS-Umgehung |
| `ReferralProvider` | Empfehlungen von Kunden/Partnern | intern | Einwilligung/Information der empfohlenen Person dokumentieren |
| `InternalInboundProvider` | Website-Formular, Telefon, E-Mail | intern (ab Website) | Höchste Datenqualität; zuerst umsetzen |

**Lücken (für Phase 1/3 dokumentieren):** Provider-Kategorie (`kind`) am Port;
Compliance-Metadaten je Quelle (`termsReviewedAt`, `allowedUse`, `retentionDays`,
`rateLimit`); Entität `LeadContact` mit eigener Rechtsgrundlage und Widerspruchsstatus;
Dedupe-Schlüssel (Name + Adresse + Domain); Freigabe-Status je Quelle
(„nicht freigegeben“ = Adapter deaktiviert). Automatische Massenansprache bleibt
ausgeschlossen (PRODUCT_SPEC §5.3).

### 8.2 Payment Risk

| Regel | Dokumentiert? |
| --- | --- |
| Neukunde → Vorkasse | ✅ PRODUCT_SPEC §6.1 |
| Auftrag 1 und 2 → Vorkasse | ✅ §6.1; ergibt sich zudem aus `minSuccessfulPaidOrders = 3` |
| Nach 3–4 bezahlten Aufträgen → Risikoprüfung | ✅ §6.1, Parameter §6.3 |
| Gute Historie + keine Überfälligkeit + keine Zahlungsprobleme → Rechnung möglich | ✅ §6.2 (inkl. Chargebacks, Trust Score, Kreditlimit) |
| Überfällige Rechnung → wieder Vorkasse | ✅ §6.1, sofort wirksam (§6.4, ARCHITECTURE §6) |
| Konfigurierbar, nicht hartcodiert | ✅ versionierte `PaymentPolicy` (§6.3) |

**Ergebnis: PASS**, mit Ergänzungsbedarf vor Tag 6:

1. **Invariante:** Validierung der Richtlinie, sodass keine Konfiguration Rechnungskauf
   für Auftrag 1 oder 2 erlaubt (z. B. `minSuccessfulPaidOrders` ≥ 3).
2. **Umgehung durch Neuanlage:** Neukunden-Erkennung über Identitätsmerkmale
   (E-Mail, Telefon, Adresse, Zahlungsmittel-Referenz), damit ein neues Konto die
   Historie nicht zurücksetzt.
3. **Wiederkehrende Aufträge:** Bei Überfälligkeit müssen bereits geplante künftige
   Termine neu bewertet werden.
4. **Definitionen:** Teilzahlungen, Mahnstufen und B2C vs. B2B (ob Rechnungskauf für
   Privatkunden überhaupt angeboten wird) fachlich festlegen.

### 8.3 Dependency Policy (Lücke für Phase 1)

Beim Anlegen von `package.json`: `pnpm install --frozen-lockfile` in CI,
Dependabot für npm, Dependency Review im PR, Lizenz-Allowlist, Schwachstellen-Scan
(z. B. `pnpm audit`/OSV), exakte Versionen für Kernbibliotheken; optional
Mindestalter neuer Paketversionen gegen Supply-Chain-Angriffe (Paketmanager-Option in
Phase 1 prüfen).

## 9. Risiken

| Risiko | Auswirkung | Gegenmaßnahme |
| --- | --- | --- |
| Repo öffentlich, `main` ungeschützt, Arbeitsbranch ist Default | Offenlegung, versehentliche Direkt-Pushes | Owner-Aktionen §10 |
| Release-Tag nur lokal | Phase-0-Stand nicht unveränderlich markiert | Owner legt Tag an (§10) |
| Sieben Spezifikationslücken (§6.1) | Nacharbeit am Schema | Spec-Ergänzung als erster Phase-1-Schritt |
| Drizzle vor 1.0, Next.js-Major-Takt | Breaking Changes | Versionen fixieren, Domain-Code framework-frei |
| Hosting nicht entschieden, Worker benötigt Dauerprozess | Verzögerung Tag 10 | Entscheidung nach Kriterien §7.9 bis spätestens Tag 2 |
| Keine lizenzierte Lead-Quelle | Tag 3 nur mit Inbound/manuell | Quellen + Nutzungsbedingungen vor Tag 3 klären |

## 10. Blocker und offene GitHub-Einstellungen

Alle Blocker erfordern **Owner-Aktion** in der GitHub-Weboberfläche. Kein Blocker ist
technisch im Repository lösbar.

| # | Was fehlt | Warum | Owner-Aktion | Konkreter nächster Schritt |
| --- | --- | --- | --- | --- |
| 1 | `main` als Default | Session-Werkzeuge ohne Settings-Zugriff | ja | Settings → General → Default branch → `main` |
| 2 | Visibility privat | wie 1 | ja | Settings → General → Danger Zone → Change visibility → Private |
| 3 | Ruleset für `main` | wie 1 | ja | Settings → Rules → Rulesets → Branch ruleset für `main`: Restrict deletions, Block force pushes, Require PR (0 Approvals, Conversation resolution), Required status checks (4 CI-Jobs); Admin-Bypass nur „for pull requests“; **ohne** Code-Owner-Review-Pflicht |
| 4 | Remote-Tag `phase-0-complete` | Tag-Push durch Umgebungsrichtlinie blockiert (403). Remote tag requires owner-side GitHub action. | ja | GitHub → Releases → Draft a new release → Tag `phase-0-complete`, Target Commit `29d82a9` – oder lokal `git tag -a phase-0-complete 29d82a9 -m "Phase 0 complete" && git push origin phase-0-complete` |
| 5 | Tag-Schutz | Repository-Einstellung | ja | Tag ruleset `phase-*`: Restrict updates, Restrict deletions |
| 6 | Secret Scanning / Push Protection bestätigt | nicht auslesbar | ja | Settings → Code security: Status prüfen und aktivieren |
| 7 | PR-Merge | Merge nach `main` ist Owner-Entscheidung | ja | PR prüfen, CI grün abwarten, mergen |

Hinweis: Bei privaten Repositories im kostenlosen GitHub-Plan sind Rulesets
möglicherweise nicht verfügbar – dann Plan prüfen oder bewusst dokumentiert ohne
serverseitigen Schutz arbeiten.

## 11. Änderungen in dieser Finalisierung

| # | Änderung |
| --- | --- |
| 1 | `docs/PHASE_0_1_FINAL_REPORT.md` erstellt (dieses Dokument) |
| 2 | Pull Request Arbeitsbranch → `main` erstellt (nur Dokumentation) |

Keine bestehende Datei verändert, gelöscht oder umbenannt. **No application changes made.**

## 12. Abschlussstatus

```text
PHASE 0.1 FINALIZATION BLOCKED
```
