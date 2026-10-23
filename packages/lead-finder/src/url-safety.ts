import { isIP } from "node:net";
import { DomainError } from "@isela/shared";

/**
 * SSRF protection for any server-side HTTP request to a URL that did not originate from
 * trusted configuration (e.g. a company website in WebsiteResearch).
 *
 * The HTTP client must connect to one of the returned, verified addresses (not re-resolve
 * the host name) to prevent DNS rebinding between check and use.
 */

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function ipv4ToNumber(ip: string): number {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPublicIpv4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  return !BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToNumber(base);
    return value >= start && value < start + size;
  });
}

/** Expands a valid IPv6 literal (checked by `isIP` before) into eight 16-bit groups. */
function expandIpv6(ip: string): number[] | null {
  let address = ip.toLowerCase();
  if (address.includes("%")) {
    return null; // zone-scoped addresses are link-local by definition
  }
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    // Embedded IPv4 (e.g. ::ffff:192.0.2.1) – convert to two hex groups.
    const n = ipv4ToNumber(tail);
    address = `${address.slice(0, lastColon + 1)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const parts = address.split("::");
  if (parts.length > 2) {
    return null;
  }
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
  const head = parse(parts[0] ?? "");
  const rest = parts.length === 2 ? parse(parts[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) {
    return null;
  }
  return [...head, ...Array<number>(missing).fill(0), ...rest];
}

function isPublicIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (groups?.length !== 8 || groups.some((g) => Number.isNaN(g))) {
    return false;
  }
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = groups;
  const allZeroPrefix = groups.slice(0, 5).every((g) => g === 0);
  if (allZeroPrefix && g5 === 0xffff) {
    // IPv4-mapped address – evaluate the embedded IPv4 address.
    return isPublicIpv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if (groups.every((g) => g === 0)) return false; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return false; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x0064 && g1 === 0xff9b) return false; // NAT64 (may reach internal IPv4)
  if (g0 === 0x2002) return false; // 6to4 (embeds arbitrary IPv4)
  return true;
}

export function isPublicIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version === 6) return isPublicIpv6(ip);
  return false;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface VerifiedUrl {
  readonly url: URL;
  /** Addresses that passed the check; connect only to these. */
  readonly addresses: readonly string[];
}

function reject(reason: string): never {
  throw new DomainError("POLICY_VIOLATION", "URL rejected by SSRF protection", { reason });
}

export async function assertSafePublicUrl(
  rawUrl: string,
  resolve: HostResolver,
): Promise<VerifiedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    reject("INVALID_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") reject("PROTOCOL_NOT_ALLOWED");
  if (url.username !== "" || url.password !== "") reject("CREDENTIALS_IN_URL");
  if (url.port !== "" && url.port !== "80" && url.port !== "443") reject("PORT_NOT_ALLOWED");

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    reject("HOST_NOT_ALLOWED");
  }

  const addresses = isIP(hostname) === 0 ? await resolve(hostname) : [hostname];
  if (addresses.length === 0) reject("HOST_NOT_RESOLVABLE");
  if (!addresses.every((address) => isPublicIpAddress(address))) reject("NON_PUBLIC_ADDRESS");

  return { url, addresses };
}
