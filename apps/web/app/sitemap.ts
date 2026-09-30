import type { MetadataRoute } from "next";
import { canonicalUrl } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";

/**
 * Only real, indexable pages. Local service pages will be added from data (active service
 * areas × service categories with real content) – no doorway pages.
 */
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const { env } = getServices();
  return ["/", "/anfrage", "/impressum", "/datenschutz"].map((path) => ({
    url: canonicalUrl(env.APP_BASE_URL, path),
    changeFrequency: "monthly",
    priority: path === "/" ? 1 : 0.5,
  }));
}
