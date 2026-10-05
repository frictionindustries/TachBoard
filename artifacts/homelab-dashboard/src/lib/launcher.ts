import { ApiError } from "@workspace/api-client-react";

// The desktop launcher sends owner credentials and launch commands, so it is
// only ever used over HTTPS or from a loopback origin. Plain-HTTP LAN origins
// never make launcher requests (the bearer token would travel in cleartext).
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "127.0.0.1";
}

export function isLauncherTransportSecure(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.protocol === "https:" || isLoopbackHost(window.location.hostname);
}

export const LAUNCHER_TRANSPORT_MESSAGE =
  "The desktop launcher only works when this dashboard is opened over HTTPS (or from localhost). Launcher requests are blocked on plain-HTTP LAN addresses so your session is never sent unencrypted.";

// Server timestamps may arrive as epoch seconds or milliseconds; normalize.
export function toEpochMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

export function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function launcherErrorMessage(err: unknown, fallback = "Request failed"): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) return data.error;
    if (err.status === 403) return "Only the owner account can use the desktop launcher.";
    return `${fallback} (${err.status})`;
  }
  return fallback;
}

// True when we never received an HTTP response (offline, DNS, TLS, abort) or
// the server failed mid-request — the command may or may not have been queued.
export function isUncertainFailure(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 0;
  return true;
}

export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}
