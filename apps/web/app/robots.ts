import type { MetadataRoute } from "next";
import { canonicalUrl } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const { env } = getServices();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/", "/customer", "/admin", "/account"],
    },
    sitemap: canonicalUrl(env.APP_BASE_URL, "/sitemap.xml"),
  };
}
