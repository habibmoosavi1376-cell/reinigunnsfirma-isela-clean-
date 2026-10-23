/**
 * Sitemap entries (framework-free, unit-tested). Every path here must be an existing public
 * route; service pages are included only when indexable (content quality gate).
 */
export const STATIC_SITEMAP_PATHS = [
  { path: "/", priority: 1 },
  { path: "/leistungen", priority: 0.8 },
  { path: "/anfrage", priority: 0.7 },
  { path: "/rueckruf", priority: 0.6 },
  { path: "/impressum", priority: 0.3 },
  { path: "/datenschutz", priority: 0.3 },
] as const;

export interface SitemapServicePage {
  readonly urlSlug: string;
  readonly indexable: boolean;
}

export function buildSitemapPaths(
  servicePages: readonly SitemapServicePage[],
): { path: string; priority: number }[] {
  return [
    ...STATIC_SITEMAP_PATHS.map((entry) => ({ path: entry.path, priority: entry.priority })),
    ...servicePages
      .filter((page) => page.indexable && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.urlSlug))
      .map((page) => ({ path: `/leistungen/${page.urlSlug}`, priority: 0.8 })),
  ];
}

/** Private areas are disallowed in robots.txt (convenience only – protected on the server). */
export const DISALLOWED_PATHS = ["/api/", "/auth/", "/customer", "/admin", "/account", "/team"];
