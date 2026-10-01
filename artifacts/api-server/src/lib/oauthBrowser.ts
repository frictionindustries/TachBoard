import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, CookieOptions } from "express";

// Independent of OAuth state: knowing/sharing the authorization URL must not
// supply the browser proof. Per-transaction cookies also allow concurrent flows.
export function newBrowserBinding(): string {
  return randomBytes(32).toString("hex");
}

export function matchesBrowserBinding(expected: string, actual: string | undefined): boolean {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function cookieName(transaction: string): string {
  return `tachboard-oauth-${transaction}`;
}

function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax", // Provider callbacks are cross-site top-level GETs.
    secure: req.secure || req.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https",
    path: "/api",
  };
}

export function setBrowserBinding(req: Request, res: Response, transaction: string, binding: string): void {
  res.cookie(cookieName(transaction), binding, { ...cookieOptions(req), maxAge: 10 * 60_000 });
}

export function readBrowserBinding(req: Request, transaction: string): string | undefined {
  // Only locally generated hex transaction IDs may select a cookie.
  if (!/^[a-f0-9]{32,48}$/.test(transaction)) return undefined;
  const prefix = `${cookieName(transaction)}=`;
  const values = (req.headers.cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(prefix));
  // Reject duplicate cookies rather than depending on parser ordering.
  return values.length === 1 ? values[0].slice(prefix.length) : undefined;
}

export function clearBrowserBinding(req: Request, res: Response, transaction: string): void {
  res.clearCookie(cookieName(transaction), cookieOptions(req));
}