/**
 * Open-redirect protection. Only same-origin, absolute *paths* are accepted as redirect
 * targets (e.g. `?next=/customer`). Everything else falls back to a safe default.
 */

const BASE = "http://internal.invalid";

/** True for C0 control characters (incl. CR/LF/TAB) and DEL. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function safeRedirectPath(candidate: unknown, fallback = "/"): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 512) {
    return fallback;
  }
  // Reject protocol-relative ("//evil"), backslash tricks ("/\\evil") and control characters.
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    hasControlCharacter(candidate)
  ) {
    return fallback;
  }
  // Defense in depth: also reject percent-encoded control characters (e.g. %0d%0a).
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return fallback;
  }
  if (hasControlCharacter(decoded) || decoded.startsWith("//") || decoded.includes("\\")) {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(candidate, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) {
    return fallback;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Never redirect into the auth API itself (e.g. to trigger sign-out via GET chains).
  if (path.startsWith("/api/")) {
    return fallback;
  }
  return path;
}
