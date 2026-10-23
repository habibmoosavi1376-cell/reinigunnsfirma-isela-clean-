/**
 * Central security-header definitions (framework-free, unit-tested).
 *
 * - Pages receive a per-request nonce-based CSP from `proxy.ts` (Next.js applies the nonce
 *   to its own scripts). Nonces require dynamic rendering – documented trade-off.
 * - Static headers are applied to every route via `next.config.ts`.
 * - HSTS is only sent for HTTPS production deployments.
 */

export interface CspOptions {
  readonly nonce: string;
  readonly development: boolean;
  /** Only for HTTPS deployments – on http://localhost it would break asset loading. */
  readonly upgradeInsecureRequests: boolean;
}

export function buildContentSecurityPolicy({
  nonce,
  development,
  upgradeInsecureRequests,
}: CspOptions): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // 'strict-dynamic' lets nonce-approved Next.js chunks load their dependencies.
    // 'unsafe-eval' is only needed by React in development (error overlays).
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", `'nonce-${nonce}'`],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(development ? ["ws:"] : [])],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "manifest-src": ["'self'"],
    ...(upgradeInsecureRequests ? { "upgrade-insecure-requests": [] } : {}),
  };
  return Object.entries(directives)
    .map(([name, values]) => (values.length === 0 ? name : `${name} ${values.join(" ")}`))
    .join("; ");
}

/** Restrictive CSP for JSON/API responses (no documents are rendered there). */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

export interface StaticHeaderOptions {
  readonly production: boolean;
  readonly baseUrl: string;
}

export interface HeaderEntry {
  readonly key: string;
  readonly value: string;
}

export function buildStaticSecurityHeaders({
  production,
  baseUrl,
}: StaticHeaderOptions): HeaderEntry[] {
  const headers: HeaderEntry[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Legacy clickjacking protection; CSP frame-ancestors covers modern browsers.
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
  if (production && baseUrl.startsWith("https://")) {
    // No `preload`: preloading is a separate, hard-to-revert commitment for the domain.
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    });
  }
  return headers;
}

/** Cryptographically random, base64-encoded nonce (Web Crypto; works in proxy and Node). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
