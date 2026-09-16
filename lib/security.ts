import "server-only";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/**
 * SSRF-aware validation for user-submitted source_url, run before every
 * Firecrawl call. A few lines, not a subsystem — avoids wasting a paid call
 * on an obviously bad target. See artifact/design.md, Stage 1 ("Research").
 */

export class UnsafeUrlError extends Error {}

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // includes cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
];

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const target = ipv4ToInt(ip);
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (target & mask) === (ipv4ToInt(base) & mask);
  });
}

function isPrivateV6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" || // loopback
    normalized.startsWith("fe80:") || // link-local
    normalized.startsWith("fc") || // unique local fc00::/7
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:") // IPv4-mapped, re-check as v4 by caller
  );
}

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // unrecognized — fail closed
}

/**
 * Throws UnsafeUrlError if the URL is not safe to fetch. Returns nothing on
 * success.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Unsupported scheme: ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  }

  const hostname = url.hostname;

  // Literal IP in the URL — check directly.
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new UnsafeUrlError(`URL resolves to a private/reserved address: ${hostname}`);
    }
    return;
  }

  if (hostname === "localhost") {
    throw new UnsafeUrlError("localhost is not allowed");
  }

  // Resolve the hostname and check every address it comes back with — a
  // domain can round-robin between a public and a private IP.
  let addresses: string[];
  try {
    const records = await dns.lookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new UnsafeUrlError(`Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new UnsafeUrlError(`URL resolves to a private/reserved address: ${hostname}`);
  }
}
