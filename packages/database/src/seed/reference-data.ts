/**
 * Seed data for the start market. These are data records – no code path may depend on
 * the concrete values below (enforced by scripts/check-hardcoded-locations.mjs).
 */

export const SEED_SERVICE_CATEGORIES = [
  {
    key: "building-cleaning",
    urlSlug: "gebaeudereinigung",
    name: "Gebäudereinigung",
    sortOrder: 10,
  },
  { key: "office-cleaning", urlSlug: "bueroreinigung", name: "Büroreinigung", sortOrder: 20 },
  {
    key: "maintenance-cleaning",
    urlSlug: "unterhaltsreinigung",
    name: "Unterhaltsreinigung",
    sortOrder: 30,
  },
  { key: "window-cleaning", urlSlug: "fensterreinigung", name: "Fensterreinigung", sortOrder: 40 },
  { key: "deep-cleaning", urlSlug: "grundreinigung", name: "Grundreinigung", sortOrder: 50 },
  {
    key: "stairwell-cleaning",
    urlSlug: "treppenhausreinigung",
    name: "Treppenhausreinigung",
    sortOrder: 60,
  },
  {
    key: "apartment-cleaning",
    urlSlug: "wohnungsreinigung",
    name: "Wohnungsreinigung",
    sortOrder: 70,
  },
  {
    key: "medical-practice-cleaning",
    urlSlug: "praxisreinigung",
    name: "Praxisreinigung",
    sortOrder: 80,
  },
  {
    key: "hospitality-cleaning",
    urlSlug: "gastronomiereinigung",
    name: "Gastronomiereinigung",
    sortOrder: 90,
  },
  {
    key: "property-management-service",
    urlSlug: "hausverwaltungsservice",
    // Day 5: display name aligned with the service catalogue ("Hausverwaltung / Objektbetreuung").
    // Seeds never overwrite existing names – installations keep an admin-chosen name.
    name: "Hausverwaltung / Objektbetreuung",
    sortOrder: 100,
  },
  {
    key: "holiday-rental-cleaning",
    urlSlug: "ferienwohnungsreinigung",
    name: "Ferienwohnungsreinigung",
    sortOrder: 110,
  },
  {
    key: "commercial-cleaning",
    urlSlug: "gewerbliche-reinigung",
    name: "Gewerbliche Reinigung",
    sortOrder: 120,
  },
] as const;

/** Start market city. Official municipality key (AGS) of the city of Gelsenkirchen. */
export const SEED_START_CITY = {
  name: "Gelsenkirchen",
  stateCode: "NW",
  country: "DE",
  officialKey: "05513000",
} as const;

/**
 * Initial service area: 25 km around the approximate city centre of the start market
 * (51°31′N, 7°06′E). Seeded INACTIVE – activation is a deliberate business decision.
 */
export const SEED_START_SERVICE_AREA = {
  key: "start-market-25km",
  name: "Startmarkt Gelsenkirchen – 25 km",
  latitude: 51.5167,
  longitude: 7.1,
  radiusM: 25_000,
  priority: 100,
} as const;

/** Internal lead sources (no third-party terms involved). */
export const SEED_LEAD_SOURCES = [
  {
    key: "internal-website-form",
    name: "Website-Anfrageformular",
    providerKind: "INTERNAL_INBOUND",
    legalBasis: "GDPR_ART6_1B_CONTRACT",
    allowedUse: "Bearbeitung von Anfragen, die Interessenten selbst über die Website stellen.",
    retentionDays: 365,
    rateLimitPerMinute: 60,
  },
  {
    key: "internal-phone-email",
    name: "Telefon- und E-Mail-Anfragen",
    providerKind: "INTERNAL_INBOUND",
    legalBasis: "GDPR_ART6_1B_CONTRACT",
    allowedUse: "Erfassung von Anfragen, die Interessenten selbst per Telefon oder E-Mail stellen.",
    retentionDays: 365,
    rateLimitPerMinute: 60,
  },
  {
    key: "referral",
    name: "Empfehlungen",
    providerKind: "REFERRAL",
    legalBasis: "GDPR_ART6_1F_LEGITIMATE_INTEREST",
    allowedUse:
      "Erfassung von Empfehlungen durch Kunden oder Partner; die empfohlene Person wird bei Erstkontakt informiert.",
    retentionDays: 180,
    rateLimitPerMinute: 60,
  },
] as const;
