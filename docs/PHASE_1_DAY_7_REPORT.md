# ISELA CLEAN – Phase 1 / Tag 7: Website, SEO, Conversion, Analytics

Branch `phase-1-day-7`, gestapelt auf `phase-1-day-6` @ `5188c43`. Basis aller PRs bleibt
`main` @ `29d82a9`. Nichts wurde gemergt, Tag 8 wurde nicht begonnen.

## 1. Ausgangszustand (§0)

| Prüfung | Ergebnis |
| --- | --- |
| Git | Arbeitsbaum sauber, HEAD `5188c43` = `origin/phase-1-day-6` |
| PRs | #1–#7 offen, nicht gemergt, Basis `main` @ `29d82a9`; #7 Head `5188c43` |
| CI #7 | alle Gates grün außer „Dependency review“ (Owner-Einstellung „Dependency graph“, bekannt, nicht umgangen) |
| Datenbank | 65 Tabellen, 8 Migrationen |
| Test-Baseline (gemessen) | 896 Unit, 232 Integration, 15 E2E – alle grün |

Abhängigkeit: Weil #1–#7 nicht gemergt sind, enthält dieser PR den gesamten Stack. Er ist
fachlich auf #7 gestapelt und sollte erst nach #1–#7 geprüft/gemergt werden.

## 2. Website-Audit (§1) – gemessen vor den Änderungen

Methode: Produktions-Build (`next build` + `next start`), Chromium (Playwright), Viewports
390×844 (mobil) und 1366×900 (Desktop), Kennzahlen per `PerformanceObserver`
(Layout-Shift, LCP) und DOM-Auswertung. Skript im Scratchpad, Zahlen unten unverändert.

| Befund | Messung / Beobachtung | Maßnahme |
| --- | --- | --- |
| Mobiler Header | 259 px hoch (Navigation umgebrochen, ~31 % des Viewports) | natives `<details>`-Menü, eine Kopfzeile: **79 px** |
| Horizontales Scrollen | `/datenschutz` mobil 401 px > 390 px | `overflow-wrap`/Silbentrennung: **kein Überlauf** auf allen Seiten |
| Canonicals | fehlten auf `/impressum`, `/datenschutz`, `/auth/login` | `pageSeo()` auf allen öffentlichen Seiten |
| Meta-Descriptions | auf allen Unterseiten identisch (Layout-Standard) | eindeutige Beschreibungen (E2E prüft Eindeutigkeit) |
| OpenGraph | nur `og:title` | `og:url` = Canonical, `og:description`, `og:title` |
| Leistungen | nur Anker auf der Startseite, keine Leistungsseiten | `/leistungen`, `/leistungen/<slug>` |
| „Rückruf anfordern“ | nicht vorhanden | `/rueckruf` |
| Doppelte Übermittlung | Doppelklick/Retry → zwei Leads (nur Ratelimit) | Formular-Token, idempotent, Race-getestet |
| robots.txt | `/team` nicht gesperrt | ergänzt |
| Layout-Verschiebung (CLS) | 0 auf allen Seiten | unverändert 0 |
| Formular-Labels | alle Felder beschriftet | beibehalten, E2E-Prüfung ergänzt |
| Fremd-Requests | keine | weiterhin keine (E2E-Prüfung) |
| Kundenportal/Admin | serverseitig geschützt, robots `Disallow` | unverändert, `/admin/reports` ergänzt |
| Fehler-/Ladezustände | 404 ohne Interna, Ladezustände vorhanden | Leistungsseiten unbekannt/ungültig → 404 |

## 3. Änderungen

| Bereich | Inhalt |
| --- | --- |
| Startseite | drei Haupt-CTAs („Reinigung anfragen“, „Leistungen ansehen“, „Rückruf anfordern“), Ablauf „So funktioniert es“ (exakt der implementierte Prozess), Zielgruppen, Vertrauensfakten ausschließlich über die Plattform (unverbindlich, kein Automatikpreis, Kundenbereich), FAQ, Servicegebiet nur aus aktiven Gebieten |
| Navigation | Desktop einzeilig; mobil natives `<details>`-Menü ohne JavaScript, CTA in der Kopfzeile bzw. unter 30 rem im Menü |
| Leistungsseiten | `@isela/catalog`: `listPublicServicePages`, `getPublicServicePage` (nur öffentliche Felder); Seiten aus Katalogdaten, Qualitäts-Gate ≥ 120 Zeichen Beschreibung für Indexierung; Admin-Formular für die Beschreibung in `/admin/services` |
| Anfragefluss | bestehende Validierung; neues einmaliges Formular-Token (nur HMAC gespeichert, Unique-Index); Bestätigungstext nennt Prüfung von Angaben und Servicegebiet, keine Preis-/Terminzusage |
| Rückruf | `submitCallbackRequest` (strict schema, Ratelimit je Client und Telefonnummer, Suppression-Prüfung, Audit ohne Kontaktdaten, idempotent), Seite `/rueckruf`, Anzeige in der Lead-Akte |
| SEO | `pageSeo`, Breadcrumbs (sichtbar + JSON-LD), `Service`-JSON-LD nur bei indexierbaren Seiten, Sitemap aus `buildSitemapPaths`, robots mit `DISALLOWED_PATHS`; Strategie in `docs/SEO_STRATEGY.md` |
| Analytics | Event-Liste, Allowlist-Sanitizer, Einwilligungs-Cookie, Provider-Interface, No-op-Anbieter (`ANALYTICS_PROVIDER=none`), `trackServerEvent` bei `request_submitted`, `callback_requested`, `quote_viewed` |
| Einwilligungen | `/datenschutz/einstellungen` (noindex): Stand anzeigen, jederzeit widerrufen; „Statistik erlauben“ nur, wenn ein Anbieter aktiv ist |
| Berichte | `@isela/reporting` + `/admin/reports` (Recht `report:read`) |
| Rechtstexte | Impressum als Entwurf gekennzeichnet; Datenschutzhinweise um Rückruf, Missbrauchsschutz/Formular-Token und Einwilligungen ergänzt (weiterhin Entwurf) |
| Datenbank | Migration `0008_day7_request_idempotency_callback` (additiv) |
| Konfiguration | `APP_ENVIRONMENT` (Kennzeichnung echter Daten), `ANALYTICS_PROVIDER` (nur `none`); `.env.example` ergänzt |
| Supply Chain | `next` 16.3.6 → 16.3.8, Override `source-map-js` 1.2.2 (neue Advisories, siehe §11) |

## 4. Leistungsseiten (§3)

Es gibt Seiten nur für **aktive Kategorien des Service-Katalogs mit URL-Slug** (Seed-Daten:
Gebäude-, Büro-, Unterhalts-, Fenster-, Grund-, Treppenhaus-, Wohnungs-, Praxis-,
Gastronomiereinigung, Hausverwaltung/Objektbetreuung, Ferienwohnungsreinigung, gewerbliche
Reinigung). Es wurden **keine Texte erfunden**: Ohne Beschreibung zeigt die Seite einen
neutralen Hinweis und die Anfrage-/Rückruf-CTAs und ist `noindex`. Keine Stadt-Doorway-Seiten.

## 5. Anfrage- und Rückruffluss (§4)

- Validierung ausschließlich über die Domänenschemas (`serviceRequestInputSchema`,
  `callbackRequestInputSchema`, beide `strictObject`).
- Kundenart und Leistungswunsch werden erfasst; der Servicegebietsstatus wird nach dem
  Speichern geprüft – die Antwort an Besuchende ist davon unabhängig (keine Zusage).
- Doppelte Übermittlung: Token je Formularaufruf, HMAC in `submission_key_hash` (Unique);
  Wiederholung liefert das gespeicherte Ergebnis, verbraucht kein Ratelimit, erzeugt keinen
  zweiten Lead – auch bei parallelen Requests (Integrationstest mit 3 gleichzeitigen Aufrufen,
  E2E mit doppeltem `requestSubmit`).
- Datensparsamkeit: Rückruf braucht nur Name und Telefonnummer; E-Mail ist nicht nötig.

## 6. Lokale SEO (§5)

Gelsenkirchen/25 km bleibt ein inaktiver Seed-Datensatz (`check:hardcoding` grün). Öffentliche
Seiten nennen nur aktive Servicegebiete. Sitemap enthält nur existierende Routen; jede
gelistete URL liefert im E2E-Test 200, unbekannte Leistungsslugs 404. Details:
`docs/SEO_STRATEGY.md`.

## 7. Analytics und Conversion (§6)

| Event | Auslöser | Stand |
| --- | --- | --- |
| `request_submitted` | Server-Aktion nach erfolgreichem, nicht doppeltem Speichern | verdrahtet (No-op) |
| `callback_requested` | Server-Aktion Rückruf | verdrahtet (No-op) |
| `quote_viewed` | Kundenportal, Angebotsdetail (Pfad als `/customer/quotes/:id`) | verdrahtet (No-op) |
| `page_view`, `service_view`, `request_started` | clientseitig | definiert; Client-Adapter erst mit freigegebenem Anbieter (kein Skript ohne Zweck) |
| `quote_accepted` | – | definiert; Kunden nehmen Angebote derzeit nicht online an (Annahme erfasst das Team), daher kein Besucher-Event; im Bericht aus der Datenbank gezählt |

Kein Anbieter ist freigegeben: Es wird **nichts gemessen**, kein Banner gezeigt, kein
Tracking-Cookie gesetzt. Ohne Einwilligung werden Events auch mit aktivem Anbieter verworfen
(Unit-Tests mit Test-Anbieter), Widerruf wirkt sofort.

## 8. Conversion-Berichte (§7)

`/admin/reports` zeigt je Zeitraum (UTC-Tage, max. 400): abgesendete Anfragen, Rückrufwünsche,
qualifizierte Website-Leads, versendete und angenommene Angebote, Buchungen, bezahlte Aufträge
(vollständig bezahlte Rechnung, Zahlungseingang im Zeitraum), Wiederholungskunden. Seitenbesuche
und gestartete Anfragen erscheinen als **„nicht gemessen“**. Verhältnisse nur, wenn beide Werte
gemessen und der Nenner > 0 ist; ausdrücklich keine Kohorten. Testdaten: Ist `APP_ENVIRONMENT`
nicht `production`, trägt der Bericht den Hinweis „Testdaten“ (E2E geprüft).

## 9. Rechtstexte und Vertrauen (§8)

| Text | Stand | Offen (Owner/Recht) |
| --- | --- | --- |
| Impressum | Entwurf, nur konfigurierte Daten; ohne Daten Fehlermeldung, Produktion startet nicht | echte Firmendaten, Registereintrag, USt-IdNr., rechtliche Prüfung |
| Datenschutzhinweise | Entwurf (Version `2026-09-entwurf`), beschreibt tatsächliche Verarbeitung inkl. Tag 7 | Verantwortlicher, Rechtsgrundlagen-/Speicherdauer-Texte, Betroffenenrechte, Prüfung |
| Widerrufsbelehrung / AGB | **nicht vorhanden** – bewusst kein Platzhalter | Muster-Widerrufsbelehrung für Verbraucherverträge, AGB, Einbindung in Angebot/Annahme |
| Einwilligungen | `/datenschutz/einstellungen` | bei Einführung eines Anbieters: Banner-Texte, Anbieterangaben |

Kein Text behauptet, final oder geprüft zu sein.

## 10. Tests (§9)

| Suite | Baseline Tag 6 | Tag 7 | Neu |
| --- | --- | --- | --- |
| Unit | 896 | **920** | Analytics-Events/Allowlist, Pfad-Sanitizer, Consent (Ablauf, Zukunft, ungültig), Dispatch ohne Anbieter/ohne Einwilligung/Widerruf/Fehler, Rückrufformular (Whitelist, Honeypot, Echo), Token im Anfrageformular, SEO (Canonical, noindex, Breadcrumb, Service ohne Preis, XSS in JSON-LD), Sitemap/robots, Routen-Klassifizierung, Berichtszeitraum, Recht `report:read` |
| Integration | 232 | **249** | idempotente Anfrage (sequenziell, parallel, Ratelimit, Hash statt Klartext, ungültige Tokens), Rückruf (Speichern, Idempotenz, strikte Validierung inkl. Mass-Assignment, Ratelimit je Telefon, Audit ohne Kontaktdaten), Leistungsseiten (Gate, inaktiv, ungültige Slugs, nur aktive Leistungen), Bericht (Rechte, Zeitraum, echte Deltas über die ganze Kette, keine Verhältnisse ohne Nenner) |
| E2E | 15 | **26** | CTAs/keine erfundenen Belege/keine Fremd-Requests, mobiler Header + Tastaturmenü + kein Überlauf auf 6 Seiten, Labels + Fokus, Leistungsseiten + 404, eindeutige Titel/Beschreibungen/Canonicals, Sitemap (alle URLs 200), mobile Doppel-Absendung → 1 Datensatz, Rückruf, Query-XSS, Consent/Widerruf ohne Anbieter, Bericht (Finance, Testdaten-Hinweis, anonym → Login) |

Kein bestehender Test wurde gelöscht, deaktiviert oder abgeschwächt. Zwei Anpassungen:
(1) `admin.test.ts` erwartet das neue aktive Modul „Berichte“; (2) `env.test.ts` war rot, bis
`.env.example` die neuen Variablen dokumentierte. **Ursachenbehebung:** Die Test-Hilfsfunktion
`payInvoice` erzeugte Zahlungsreferenzen aus UUIDs; in ~2 % bilden die UUID-Ziffern über die
Bindestriche eine 13–19-stellige Folge, die bei jeder zehnten den Luhn-Check besteht und vom
Kartennummern-Schutz (korrekt) abgelehnt wird – ein sporadischer Day-6-Testfehler. Die
Referenz enthält jetzt keine Ziffern mehr; der Schutz selbst ist unverändert.

## 11. Performance und Accessibility (§10) – gemessen nach den Änderungen

Methode wie §2 (Produktions-Build, lokaler Server, Chromium; Werte sind lokale Labormessungen,
**keine Lighthouse-Werte** – Lighthouse ist in der Umgebung nicht installiert).

| Seite | CLS mobil/desktop | LCP mobil/desktop (ms) | Header mobil/desktop (px) | Überlauf |
| --- | --- | --- | --- | --- |
| `/` | 0 / 0 | 472¹ / 176 | 79 / 87 | nein |
| `/leistungen` | 0 / 0 | 116 / 152 | 79 / 87 | nein |
| `/leistungen/bueroreinigung` | 0 / 0 | 148 / 132 | 79 / 87 | nein |
| `/anfrage` | 0 / 0 | 192 / 176 | 79 / 87 | nein |
| `/rueckruf` | 0 / 0 | 160 / 164 | 79 / 87 | nein |
| `/impressum`, `/datenschutz`, `/datenschutz/einstellungen` | 0 / 0 | 104–160 | 79 / 87 | nein |

¹ erster Aufruf nach Serverstart (kalter Cache).

JavaScript (Startseite, gemessen per `curl`): 8 Dateien, 563 KB unkomprimiert, **173 KB gzip**;
`/anfrage` 176 KB, `/rueckruf` 175 KB gzip. Das ist die Next.js/React-Laufzeit; alle
öffentlichen Seiten sind Server-Komponenten, nur die beiden Formulare sind Client-Komponenten
(+~3 KB gzip). Kein Analytics-Skript, keine Fremdressourcen, keine Bilder (keine
Alt-Text-Lücken; Bildmaterial ist Owner-Entscheidung). Accessibility: genau ein `h1` je Seite,
alle Formularfelder beschriftet (Mobil + Desktop, 0 Befunde), sichtbarer Fokus-Rahmen,
Skip-Link, Menü per Tastatur bedienbar, Touch-Ziele im Mobilmenü ≥ 44 px. Kontraste nutzen
die bestehende Palette (Primär `#0b6e6e`/`#075454` auf Weiß); ein automatisierter
Kontrast-Scanner (axe) ist nicht installiert und wurde nicht ergänzt (neue Abhängigkeit).

## 12. Sicherheit

Siehe `docs/SECURITY.md` §3.8. Neue Advisories seit Tag 6: `next` < 16.3.8 (u. a. SSRF in
der Bildoptimierung – hier deaktiviert –, Cache-Poisoning) und `source-map-js` < 1.2.2
(Dev-Abhängigkeit über vite). Behoben per Patch-Update bzw. Override; `pnpm audit` ohne Befund.

## 13. Migration und Upgrade-Test

`0008_day7_request_idempotency_callback`: `CREATE TYPE`, `CREATE TABLE callback_request`,
`ALTER TABLE service_request ADD COLUMN submission_key_hash` (nullable), drei Indizes – kein
`DROP`/`TRUNCATE`/Umschreiben. Upgrade-Test: frische Datenbank mit Migrationen 0000–0007 und
Day-6-Daten (Lead + Anfrage) → aktueller Migrator → 9 Migrationen, md5 der bestehenden
Anfragedaten vor/nach identisch (`60c6f462…`), Altanfragen behalten `submission_key_hash` NULL.
Hinweis Betrieb: Der Unique-Index auf `service_request` wird ohne `CONCURRENTLY` angelegt (kurze
Schreibsperre; bei leerer neuer Spalte unkritisch).

## 14. Owner-Entscheidungen

1. Analytics-Anbieter (oder bewusst keiner); erst danach Banner, Client-Events, AV-Vertrag.
2. Beschreibungen je Leistungskategorie (Freigabe der Indexierung).
3. Aktivierung des Startmarkt-Servicegebiets.
4. Echte Firmendaten, Widerrufsbelehrung, AGB, finale Datenschutzerklärung (rechtliche Prüfung).
5. Bildmaterial mit Nutzungsrechten.
6. `APP_ENVIRONMENT=production` erst in der echten Produktivinstallation setzen.

## 15. Risiken

- Ohne Kategoriebeschreibungen sind Leistungsseiten `noindex` – organische Sichtbarkeit erst
  nach Owner-Texten.
- Berichtszahlen sind ereignis-, nicht kohortenbasiert (im UI erklärt).
- Formular-Token schützt dieselbe Formularinstanz; ein Neuladen der Seite erzeugt bewusst ein
  neues Token (dann greifen die Ratelimits).

## 16. Final Gate (§12)

| Gate | Ergebnis |
| --- | --- |
| Git-Diff / Working Tree | geprüft, sauber nach Commit |
| Typecheck, Lint (ESLint + Prettier) | grün |
| Unit / Integration / E2E | 920 / 249 / 26 – alle grün |
| Build (Pakete + Next.js) | grün |
| Migration Drift (`db:check`) | grün |
| SEO/Sitemap | E2E: Canonicals, Titel, Beschreibungen, Sitemap-URLs 200, robots |
| Accessibility/Performance | gemessen, §11 |
| Modulgrenzen, Hardcoding-Guard, Forbidden Files | grün |
| `pnpm audit`, Lizenzen | grün (nach Patch-Update) |
| Secret-Scan (gitleaks), markdownlint | lokal und in CI grün |
| CodeQL | CI grün |
| Dependency Review | CI rot: „Dependency review is not supported on this repository. Please ensure that Dependency graph is enabled“ – Owner-Einstellung, nicht umgangen |
| Regression gegen Day-6-Baseline | keine: alle Baseline-Tests grün, Zahlen gestiegen |

CI auf PR #8 (Commit `6551c9e` + Doku): Typecheck/Lint/Unit/Build, Integration, E2E,
Web-Build + Client-Bundle-Secret-Scan, Audit/Lizenzen, gitleaks, actionlint, markdownlint,
Forbidden Files, CodeQL – alle grün. Einzige rote Prüfung ist Dependency Review aus dem
bekannten, codeunabhängigen Grund (Dependency graph in den Repository-Einstellungen deaktiviert).

**Status: PHASE 1 DAY 7 COMPLETE**
