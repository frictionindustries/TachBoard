import axios, { type AxiosInstance } from "axios";
import https from "https";
import dns from "node:dns/promises";
import net from "node:net";
import { publicOnlyOutboundRequired } from "./outboundContext.js";
import { validateServiceBaseUrl } from "./serviceUrl.js";

// Extra, non-standard axios config recognized by the SSRF guard below.
declare module "axios" {
  export interface AxiosRequestConfig {
    // When true, the destination must resolve to a public (non-private,
    // non-loopback, non-link-local) address. Used for routes that fetch
    // arbitrary internet content on the user's behalf (e.g. the news feed
    // proxy). Only the instance owner's authenticated context can leave this
    // unset to reach LAN services. False cannot weaken another user's policy.
    ssrfPublicOnly?: boolean;
  }
}

// Default timeout for all outbound service requests (ms).
export const HTTP_TIMEOUT = 6000;

// Homelab services (TrueNAS, Plex, and others) very commonly serve their API
// over HTTPS with a self-signed certificate. Node's default agent rejects those
// certs, which makes every HTTPS connection fail before a request is even sent.
// This agent accepts them so a configured service actually connects.
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

// Shared axios instance used by every widget route and the test/ping logic, so a
// connection test that passes also means the widget will work. Standardizes the
// timeout and the self-signed-TLS handling in one place.
//
// NOTE: this client disables TLS verification, which is appropriate for LAN
// homelab services that serve self-signed certs — but NOT for calls to public
// cloud APIs over the internet, where a bearer token would be exposed to MITM.
// Use `cloudHttpClient` for any internet-hosted, token-bearing API.
export const httpClient: AxiosInstance = axios.create({
  timeout: HTTP_TIMEOUT,
  httpsAgent: insecureHttpsAgent,
  // Don't auto-throw on >=300 here; callers decide. Keep axios default (throws
  // on non-2xx) so individual routes can surface a clear error state.
});

// Secure axios instance for public cloud APIs (e.g. api.tailscale.com). Uses
// Node's default TLS validation so bearer tokens are never sent over a
// connection whose certificate hasn't been verified.
export const cloudHttpClient: AxiosInstance = axios.create({
  timeout: HTTP_TIMEOUT,
});

// ── SSRF guard ───────────────────────────────────────────────────────────────
// `httpClient` sends requests to hosts that come straight from user input
// (saved/tested service connections, the news feed URL). Without a check here,
// an authenticated user could point any of those routes at the server's own
// loopback interface, its cloud-metadata address, or (via a redirect) an
// unvalidated internal host — turning the API server into a network probe.
// This validates the destination BEFORE every `httpClient` request and pins
// the exact resolved address for the actual connection, so a DNS answer that
// changes between the check and the connection (DNS rebinding) can't slip a
// blocked address past the check.

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range!) & mask);
}

// Never a legitimate target for a service connection or feed URL, homelab or
// otherwise: "this network", loopback, link-local (this range includes
// 169.254.169.254, the classic cloud-metadata SSRF pivot), multicast, and
// reserved/future-use space.
const IPV4_ALWAYS_BLOCKED = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

// RFC1918 + carrier-grade-NAT private space. Only the instance owner may reach
// these networks; explicit public-only callers stay restricted even for them.
const IPV4_PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];

function isBlockedIpv4(ip: string, publicOnly: boolean): boolean {
  if (IPV4_ALWAYS_BLOCKED.some((c) => ipv4InCidr(ip, c))) return true;
  if (publicOnly && IPV4_PRIVATE.some((c) => ipv4InCidr(ip, c))) return true;
  return false;
}

// Expand any valid textual IPv6 address into its eight 16-bit groups. Handles
// "::" compression and an embedded trailing IPv4 literal (e.g. "::127.0.0.1")
// in ANY position/case, so classification below works on the actual address
// bits rather than a particular textual spelling — a string-prefix check like
// `startsWith("::ffff:")` would miss equivalent forms such as the fully
// hex-encoded "::ffff:7f00:1" (still 127.0.0.1) or padded/uppercase variants.
// Returns null when the input isn't a syntactically valid IPv6 address.
function expandIpv6(ip: string): number[] | null {
  const withoutZone = ip.split("%")[0]!;
  if (!net.isIPv6(withoutZone)) return null;

  const partsToGroups = (parts: string[]): number[] | null => {
    const groups: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        if (!net.isIPv4(part)) return null;
        const octets = part.split(".").map(Number);
        groups.push(((octets[0]! << 8) | octets[1]!) & 0xffff);
        groups.push(((octets[2]! << 8) | octets[3]!) & 0xffff);
      } else {
        const n = parseInt(part, 16);
        if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
        groups.push(n);
      }
    }
    return groups;
  };

  let groups: number[] | null;
  if (withoutZone.includes("::")) {
    const idx = withoutZone.indexOf("::");
    const head = withoutZone.slice(0, idx);
    const tail = withoutZone.slice(idx + 2);
    const headParts = head.length ? head.split(":") : [];
    const tailParts = tail.length ? tail.split(":") : [];
    const headGroups = partsToGroups(headParts);
    const tailGroups = partsToGroups(tailParts);
    if (!headGroups || !tailGroups) return null;
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...Array(missing).fill(0), ...tailGroups];
  } else {
    groups = partsToGroups(withoutZone.split(":"));
  }
  return groups && groups.length === 8 ? groups : null;
}

function ipv6GroupsToIpv4(g6: number, g7: number): string {
  return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
}

function isBlockedIpv6(ip: string, publicOnly: boolean): boolean {
  const groups = expandIpv6(ip);
  // Fail closed: if we can't confidently parse it, don't let it through.
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];

  if (groups.every((g) => g === 0)) return true; // :: (unspecified)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true; // ::1 (loopback)
  }
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast

  // IPv4-mapped (::ffff:0:0/96) and NAT64 well-known prefix (64:ff9b::/96)
  // both carry a literal IPv4 address in the last 32 bits — validate that
  // embedded address regardless of how the surrounding groups were spelled.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4(ipv6GroupsToIpv4(g6, g7), publicOnly);
  }
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(ipv6GroupsToIpv4(g6, g7), publicOnly);
  }

  // Public socket destinations must be global unicast. Exclude transition
  // mechanisms that can embed an unchecked IPv4 endpoint (6to4/Teredo), plus
  // deprecated compatible/site-local addresses and unique-local space.
  if (publicOnly && ((g0 & 0xe000) !== 0x2000 || g0 === 0x2002 ||
      (g0 === 0x2001 && g1 === 0))) return true;
  return false;
}

// Exported so the classification rules can be unit-tested directly, without
// spinning up real sockets or DNS lookups.
export function isSsrfBlockedIp(ip: string, publicOnly: boolean): boolean {
  if (net.isIPv6(ip)) return isBlockedIpv6(ip, publicOnly);
  return !net.isIPv4(ip) || isBlockedIpv4(ip, publicOnly);
}

// Validates the destination of every `httpClient` request and pins its
// resolved address(es) onto the request config. Thrown errors surface through
// the normal axios call site (`normalizeHttpError`/`describeHttpError` already
// handle generic `Error`s), so callers don't need to change their catch logic.
httpClient.interceptors.request.use(async (config) => {
  if (!config.url) return config;

  let target: URL;
  try {
    target = new URL(config.url, config.baseURL);
  } catch {
    throw new UnsafeUrlError("Could not reach service — check the URL and port.");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new UnsafeUrlError("Only http:// and https:// URLs are allowed.");
  }

  let resolved: Array<{ address: string; family: 4 | 6 }>;
  try {
    // WHATWG URL keeps IPv6 brackets; sockets/DNS require the bare address.
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const family = net.isIP(hostname);
    resolved = (family
      ? [{ address: hostname, family }]
      : await dns.lookup(hostname, { all: true, verbatim: true })) as Array<{
      address: string;
      family: 4 | 6;
    }>;
  } catch {
    throw new UnsafeUrlError("Could not reach service — check the URL and port.");
  }
  if (resolved.length === 0) {
    throw new UnsafeUrlError("Could not reach service — check the URL and port.");
  }

  const publicOnly = config.ssrfPublicOnly === true || publicOnlyOutboundRequired();
  if (resolved.some((a) => isSsrfBlockedIp(a.address, publicOnly))) {
    throw new UnsafeUrlError("That destination is not allowed.");
  }

  // Pin the exact addresses just validated so the actual TCP connection can't
  // be redirected to a different (unvalidated) address via a later DNS answer.
  config.lookup = (_hostname, options, callback) => {
    const opts = (options ?? {}) as { all?: boolean };
    if (opts.all) {
      callback(null, resolved);
    } else {
      const chosen = resolved[0]!;
      callback(null, chosen.address, chosen.family);
    }
  };

  // Environment HTTP(S)_PROXY settings would resolve/connect through a different
  // host and bypass the pinned socket destination.
  config.proxy = false;

  // None of the endpoints proxied through `httpClient` need a redirect hop.
  // Axios follows redirects by default, which would let a same-host 3xx
  // smuggle the request to a completely different (unvalidated) host/port
  // after the check above. Redirects require a separately validated request.
  config.maxRedirects = 0;

  return config;
});

// Normalize a user-entered base URL so axios always gets an absolute URL:
// prepend "http://" when no scheme is present and strip trailing slashes.
// Without a scheme, axios treats the value as a relative path and the request
// fails before it leaves the process. Returns undefined for empty input.
export function normalizeBaseUrl(url: string | undefined | null): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return validateServiceBaseUrl(trimmed);
}

// Turn an arbitrary thrown error (usually an AxiosError) into a short,
// user-facing message. Shared so the on-demand test, the background scheduler,
// and the widget routes all describe failures the same way.
export function normalizeHttpError(err: unknown): string {
  // Service-specific expected failures (e.g. PiholeError) carry a ready-to-show
  // message. Surface it verbatim instead of a generic string. Checked by name
  // to avoid an import cycle with the service helpers.
  if (err instanceof Error && err.name === "PiholeError") {
    return err.message;
  }
  if (axios.isAxiosError(err)) {
    if (err.response) {
      const status = err.response.status;
      return status === 401 || status === 403
        ? "Authentication failed — check your credentials."
        : `Service responded with an error (${status}).`;
    }
    if (err.code === "ECONNABORTED") {
      return "Connection timed out.";
    }
    return "Could not reach service — check the URL and port.";
  }
  return "Could not reach service";
}

// Structured failure detail for diagnostics. Unlike normalizeHttpError (which
// collapses everything to a short user-facing string and DISCARDS the response
// body), this preserves the upstream HTTP status, error code, and — crucially —
// the full response body. Many services (TrueNAS reporting/get_data among them)
// explain exactly WHY a request was rejected in that body, so a diagnostic must
// not throw it away. Never include request headers/credentials here.
export interface HttpFailureDetail {
  status: number | null;
  code: string | null;
  message: string;
  body: unknown;
}

export function describeHttpError(err: unknown): HttpFailureDetail {
  if (axios.isAxiosError(err)) {
    return {
      status: err.response?.status ?? null,
      code: err.code ?? null,
      message: err.message,
      body: err.response?.data ?? null,
    };
  }
  if (err instanceof Error) {
    return { status: null, code: null, message: err.message, body: null };
  }
  return { status: null, code: null, message: String(err), body: null };
}
