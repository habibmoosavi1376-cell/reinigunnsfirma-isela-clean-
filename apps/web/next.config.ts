import type { NextConfig } from "next";
import { API_CONTENT_SECURITY_POLICY, buildStaticSecurityHeaders } from "./lib/security/headers";

const production = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // Do not advertise the framework.
  poweredByHeader: false,
  // No server-side image optimization: avoids the optional LGPL sharp/libvips dependency
  // (license policy) and an image proxy endpoint. Images are served as static files.
  images: { unoptimized: true },
  reactStrictMode: true,
  // Workspace packages are published as TypeScript source.
  transpilePackages: [
    "@isela/audit",
    "@isela/auth",
    "@isela/catalog",
    "@isela/config",
    "@isela/geocoding",
    "@isela/crm",
    "@isela/database",
    "@isela/lead-finder",
    "@isela/notifications",
    "@isela/partners",
    "@isela/payment-risk",
    "@isela/quotes",
    "@isela/settings",
    "@isela/shared",
    "@isela/validation",
  ],
  serverExternalPackages: ["pg", "nodemailer"],
  experimental: {
    // Enables forbidden()/unauthorized() with proper 403/401 responses (experimental API).
    authInterrupts: true,
    serverActions: {
      // Request form and auth forms are small; reject oversized bodies early.
      bodySizeLimit: "64kb",
    },
  },
  headers() {
    const staticHeaders = buildStaticSecurityHeaders({
      production,
      baseUrl: process.env["APP_BASE_URL"] ?? "",
    });
    return Promise.resolve([
      { source: "/:path*", headers: staticHeaders },
      {
        source: "/api/:path*",
        headers: [
          { key: "Content-Security-Policy", value: API_CONTENT_SECURITY_POLICY },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ]);
  },
};

export default nextConfig;
