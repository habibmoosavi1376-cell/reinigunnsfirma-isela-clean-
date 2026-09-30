/**
 * SEO helpers (framework-free). Structured data only contains facts that are configured –
 * nothing is invented (no ratings, reviews, opening hours or addresses without data).
 */

export const SITE_NAME = "ISELA CLEAN";

/** Canonical URL: absolute, no query string, no trailing slash (except the root). */
export function canonicalUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${url.origin}${pathname}`;
}

export interface OrganizationFacts {
  readonly baseUrl: string;
  readonly legalName?: string | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly street?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly city?: string | undefined;
  readonly areaServed?: readonly string[];
}

/** schema.org Organization / LocalBusiness JSON-LD built exclusively from configured facts. */
export function buildOrganizationJsonLd(facts: OrganizationFacts): Record<string, unknown> {
  const hasAddress =
    facts.street !== undefined && facts.postalCode !== undefined && facts.city !== undefined;
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": hasAddress ? "LocalBusiness" : "Organization",
    name: SITE_NAME,
    url: canonicalUrl(facts.baseUrl, "/"),
  };
  if (facts.legalName !== undefined) data["legalName"] = facts.legalName;
  if (facts.email !== undefined) data["email"] = facts.email;
  if (facts.phone !== undefined) data["telephone"] = facts.phone;
  if (hasAddress) {
    data["address"] = {
      "@type": "PostalAddress",
      streetAddress: facts.street,
      postalCode: facts.postalCode,
      addressLocality: facts.city,
      addressCountry: "DE",
    };
  }
  if (facts.areaServed !== undefined && facts.areaServed.length > 0) {
    data["areaServed"] = facts.areaServed;
  }
  return data;
}

/** Serialises JSON-LD safely for embedding in a <script> tag (prevents `</script>` breakout). */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * Future local landing pages ("/bueroreinigung-<city>"): the path is derived from DATA
 * (service category slug + city slug), never from hard-coded locations. Pages are only
 * generated for active service areas and real content (see docs/PHASE_1_DAY_2_REPORT.md).
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildLandingPath(serviceSlug: string, cityName: string): string {
  const service = slugify(serviceSlug);
  const citySlug = slugify(cityName);
  if (service === "" || citySlug === "") {
    throw new Error("Landing path requires a service slug and a city name");
  }
  return `/${service}-${citySlug}`;
}

/**
 * Splits "/<service>-<city>" using the list of known service slugs (longest match first),
 * because both parts may contain hyphens. Returns null when no known service matches.
 */
export function parseLandingPath(
  path: string,
  knownServiceSlugs: readonly string[],
): { serviceSlug: string; citySlug: string } | null {
  const segment = path.replace(/^\/+|\/+$/g, "");
  if (segment === "" || segment.includes("/")) return null;
  const candidates = [...knownServiceSlugs].sort((a, b) => b.length - a.length);
  for (const serviceSlug of candidates) {
    if (segment.startsWith(`${serviceSlug}-`)) {
      const citySlug = segment.slice(serviceSlug.length + 1);
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(citySlug)) {
        return { serviceSlug, citySlug };
      }
    }
  }
  return null;
}
