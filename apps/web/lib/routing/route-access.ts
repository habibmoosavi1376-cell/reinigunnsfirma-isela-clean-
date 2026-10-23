/**
 * Central public/private route classification. Used by `proxy.ts` for an early, optimistic
 * redirect of anonymous visitors. It is NOT the authorization: every protected page, route
 * handler and server action checks the session and the RBAC policy on the server.
 */

export type ProtectedArea = "customer" | "admin" | "account" | "team";

export type RouteAccess =
  { readonly kind: "public" } | { readonly kind: "protected"; readonly area: ProtectedArea };

const PROTECTED_PREFIXES: readonly { prefix: string; area: ProtectedArea }[] = [
  { prefix: "/customer", area: "customer" },
  { prefix: "/admin", area: "admin" },
  { prefix: "/account", area: "account" },
  { prefix: "/team", area: "team" },
];

/** Normalises a request path: decodes, collapses slashes, lower-cases for comparison. */
export function normalizePath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep the raw value; malformed encodings are compared as-is.
  }
  const collapsed = decoded.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const withoutTrailing = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  return withoutTrailing.toLowerCase();
}

export function classifyRoute(pathname: string): RouteAccess {
  const path = normalizePath(pathname);
  for (const { prefix, area } of PROTECTED_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return { kind: "protected", area };
    }
  }
  return { kind: "public" };
}

export const LOGIN_PATH = "/auth/login";

export function loginRedirectPath(targetPath: string): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(targetPath)}`;
}
