import { describe, expect, it } from "vitest";
import { classifyRoute, loginRedirectPath } from "@/lib/routing/route-access";
import {
  buildContentSecurityPolicy,
  buildStaticSecurityHeaders,
  createNonce,
} from "@/lib/security/headers";
import { safeRedirectPath } from "@/lib/security/redirects";

describe("route classification", () => {
  it.each([
    "/",
    "/anfrage",
    "/auth/login",
    "/impressum",
    "/customers-info",
    "/administration-news",
    "/api/auth/get-session",
  ])("%s is public", (path) => {
    expect(classifyRoute(path)).toEqual({ kind: "public" });
  });

  it.each([
    ["/customer", "customer"],
    ["/team/jobs", "team"],
    ["/customer/requests", "customer"],
    ["/CUSTOMER/Requests", "customer"],
    ["//customer", "customer"],
    ["/%63ustomer", "customer"],
    ["/customer/", "customer"],
    ["/admin", "admin"],
    ["/admin/dashboard", "admin"],
    ["\\admin", "admin"],
    ["/account/security", "account"],
  ])("%s is protected (%s)", (path, area) => {
    expect(classifyRoute(path)).toEqual({ kind: "protected", area });
  });

  it("builds an encoded login redirect", () => {
    expect(loginRedirectPath("/customer/requests?x=1")).toBe(
      "/auth/login?next=%2Fcustomer%2Frequests%3Fx%3D1",
    );
  });
});

describe("open redirect protection", () => {
  it.each(["/customer", "/customer/requests?tab=open", "/anfrage#form"])(
    "accepts same-origin path %s",
    (path) => {
      expect(safeRedirectPath(path)).toBe(path);
    },
  );

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "http:/evil.example",
    "/%0d%0aSet-Cookie:x",
    "/api/auth/sign-out",
    "",
    "customer",
    "/\nevil",
    `/${"a".repeat(600)}`,
    42,
    undefined,
  ])("rejects %s", (candidate) => {
    expect(safeRedirectPath(candidate, "/fallback")).toBe("/fallback");
  });
});

describe("security headers", () => {
  it("builds a strict nonce-based CSP for production", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "abc123",
      development: false,
      upgradeInsecureRequests: true,
    });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("only adds unsafe-eval in development", () => {
    expect(
      buildContentSecurityPolicy({ nonce: "n", development: true, upgradeInsecureRequests: false }),
    ).toContain("'unsafe-eval'");
  });

  it("creates unique nonces", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(nonces.size).toBe(50);
  });

  it("sends HSTS only for https production deployments", () => {
    const keys = (production: boolean, baseUrl: string) =>
      buildStaticSecurityHeaders({ production, baseUrl }).map((h) => h.key);
    expect(keys(true, "https://www.example.test")).toContain("Strict-Transport-Security");
    expect(keys(true, "http://localhost:3100")).not.toContain("Strict-Transport-Security");
    expect(keys(false, "https://www.example.test")).not.toContain("Strict-Transport-Security");
  });

  it("sets clickjacking, sniffing, referrer and permissions headers", () => {
    const headers = Object.fromEntries(
      buildStaticSecurityHeaders({ production: true, baseUrl: "https://x.test" }).map((h) => [
        h.key,
        h.value,
      ]),
    );
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Permissions-Policy"]).toContain("geolocation=()");
  });
});
