import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { classifyRoute, loginRedirectPath } from "./lib/routing/route-access";
import { buildContentSecurityPolicy, createNonce } from "./lib/security/headers";

/**
 * 1. Per-request CSP nonce for all pages.
 * 2. Optimistic redirect of anonymous visitors away from protected areas.
 *    This is NOT authorization – pages, route handlers and server actions verify the
 *    session and the RBAC policy on the server (see lib/server/guards.ts).
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === "development",
    upgradeInsecureRequests: (process.env["APP_BASE_URL"] ?? "").startsWith("https://"),
  });

  const access = classifyRoute(request.nextUrl.pathname);
  if (access.kind === "protected" && getSessionCookie(request) === null) {
    const target = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const response = NextResponse.redirect(new URL(loginRedirectPath(target), request.url));
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-request-id", crypto.randomUUID());
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
