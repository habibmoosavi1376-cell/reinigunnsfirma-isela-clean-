import type { MetadataRoute } from "next";
import { listPublicServicePages } from "@isela/catalog";
import { buildSitemapPaths } from "@/lib/seo/sitemap";
import { canonicalUrl } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";

/**
 * Only real, indexable pages that exist as routes: static public pages plus service pages
 * that passed the content quality gate. Noindex pages and private areas are never listed.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { database, env } = getServices();
  const servicePages = await listPublicServicePages(database.db);
  return buildSitemapPaths(servicePages).map((entry) => ({
    url: canonicalUrl(env.APP_BASE_URL, entry.path),
    changeFrequency: "monthly",
    priority: entry.priority,
  }));
}
