import type { MetadataRoute } from "next";
import { canonicalUrl } from "@/lib/seo/seo";
import { DISALLOWED_PATHS } from "@/lib/seo/sitemap";
import { getServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const { env } = getServices();
  return {
    rules: { userAgent: "*", allow: "/", disallow: DISALLOWED_PATHS },
    sitemap: canonicalUrl(env.APP_BASE_URL, "/sitemap.xml"),
  };
}
