# SEO-Strategie – ISELA CLEAN

Stand: Phase 1 / Tag 7. Verbindlich für alle öffentlichen Seiten. Grundsatz: **Nur echte Seiten,
nur zutreffende Aussagen.** Suchmaschinen sehen ausschließlich Seiten mit echtem, geprüftem
Inhalt. Wir veröffentlichen keine erfundenen Bewertungen, Referenzen, Zertifikate, Preise,
Öffnungszeiten oder Adressen.

## 1. Seitenstruktur

| Pfad | Inhalt | Indexierung |
| --- | --- | --- |
| `/` | Startseite: Leistungen, Ablauf, Zielgruppen, Servicegebiet, FAQ, CTAs | index |
| `/leistungen` | Übersicht aller aktiven Leistungskategorien mit URL-Slug | index |
| `/leistungen/<slug>` | Leistungsseite aus Katalogdaten | index **nur** mit Beschreibung ≥ 120 Zeichen |
| `/anfrage` | Anfrageformular | index |
| `/rueckruf` | Rückrufformular | index |
| `/impressum`, `/datenschutz` | Rechtstexte (Entwurf) | index |
| `/datenschutz/einstellungen` | Einwilligungen ansehen/widerrufen | noindex |
| `/customer`, `/admin`, `/account`, `/team`, `/auth/`, `/api/` | privat | `Disallow` in robots.txt + serverseitig geschützt |

## 2. Leistungsseiten (Qualitäts-Gate)

- Quelle sind ausschließlich Katalogdaten: Kategorie (Name, URL-Slug, Beschreibung) und ihre
  **aktiven** Leistungen (Name, Beschreibung). Keine Preise, keine internen Felder.
- Eine Seite ist erst indexierbar (robots `index`, Sitemap, `Service`-JSON-LD), wenn eine
  Administratorin bzw. ein Administrator im Leistungskatalog (`/admin/services`) eine
  Beschreibung von mindestens `MIN_INDEXABLE_DESCRIPTION_LENGTH` (120) Zeichen gespeichert hat.
- Ohne Beschreibung ist die Seite für Besucher erreichbar (Anfrage-/Rückruf-CTA), aber
  `noindex, follow` und nicht in der Sitemap. So entstehen keine dünnen Seiten.
- Inaktive Kategorien oder Kategorien ohne Slug haben keine Seite (404).
- **Keine Stadtvarianten.** Lokale Seiten (`/<leistung>-<stadt>`) sind weiterhin Datensätze
  (`landing_page`) mit Veröffentlichungs-Gate (Tag 3); es gibt dafür noch keine Route und daher
  auch keine Sitemap-Einträge. Hunderte nahezu identische Stadtseiten sind ausgeschlossen.

### Textvorgaben für Kategoriebeschreibungen (vom Owner zu schreiben)

- Was die Leistung umfasst – nur, was tatsächlich angeboten wird.
- Für wen sie geeignet ist (Privat/Gewerbe/Hausverwaltung).
- Hinweis, dass Umfang und Preis im Angebot festgelegt werden.
- Keine Superlative ohne Beleg („beste“, „günstigste“), keine Garantien, keine Fristen.

## 3. Lokale SEO

- Das Startmarktgebiet (Gelsenkirchen, 25 km) ist ein **Datensatz** (`service_area`), nicht
  Code. Öffentliche Seiten nennen nur **aktive** Servicegebiete (`listActiveServiceAreas`);
  ist keines aktiv, steht dort, dass das Gebiet eingerichtet wird.
- Verfügbarkeit an einer Adresse wird nie versprochen: Sie wird nach der Anfrage per
  Geocoding + PostGIS bzw. manuell geprüft.
- `LocalBusiness`-JSON-LD nur, wenn Straße, PLZ und Ort konfiguriert sind (sonst
  `Organization`); `areaServed` nur aus aktiven Servicegebieten.

## 4. Technische Umsetzung

- `pageSeo()` (`apps/web/lib/seo/seo.ts`): eindeutiger Titel, Meta-Description, kanonische URL
  (absolut, ohne Query, ohne abschließenden Schrägstrich), OpenGraph (`og:url` = Canonical),
  robots-Flag.
- Breadcrumbs sichtbar und als `BreadcrumbList`-JSON-LD (gleiche Einträge).
- `Service`-JSON-LD nur für indexierbare Leistungsseiten; nie `offers`, `price`,
  `aggregateRating`, `review`, `openingHours`.
- JSON-LD wird mit CSP-Nonce eingebettet und gegen `</script>`-Ausbruch escaped
  (`serializeJsonLd`).
- Sitemap (`buildSitemapPaths`): nur existierende öffentliche Routen + indexierbare
  Leistungsseiten; E2E-Test ruft jede gelistete URL auf (alle 200).
- Robots: `DISALLOWED_PATHS` (inkl. `/team`, seit Tag 7).
- Semantik: genau ein `h1` je Seite, Überschriftenhierarchie, Listen als Listen, Formulare mit
  Labels; Bilder werden derzeit nicht verwendet (keine Alt-Text-Lücken möglich).

## 5. Interne Verlinkung

Startseite → `/leistungen` → `/leistungen/<slug>` → `/anfrage?leistung=<key>` bzw.
`/rueckruf?leistung=<key>`; Footer verlinkt Leistungen, Anfrage, Rückruf, Servicegebiet und
Rechtstexte. Query-Parameter werden nur übernommen, wenn die Leistung existiert.

## 6. Offene Owner-Entscheidungen

1. Beschreibungen je Leistungskategorie (Freigabe der Indexierung).
2. Aktivierung des Startmarkt-Servicegebiets.
3. Echte Firmendaten (Impressum, `LocalBusiness`).
4. Ob und welche Stadtseiten mit echtem Inhalt erstellt werden.
5. Bildmaterial (eigene Fotos mit Rechten; Alt-Texte bei Einführung Pflicht).
