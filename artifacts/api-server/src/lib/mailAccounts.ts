import { randomBytes } from "crypto";
import { connectionStmts } from "./db.js";
import { invalidateFetchCache } from "./fetchCache.js";
import { validateOutboundPort } from "./outboundTargets.js";

// ── Multi-account storage for IMAP and CalDAV ─────────────────────────────────
// Unlike the single-connection services, users can add several IMAP mailboxes
// and several CalDAV calendars. Each list lives in the per-user
// `service_connections` table as a JSON array in the `extra` column of that
// user's "imap" / "caldav" row. Passwords stay server-side: the route layer
// must sanitize them out of every response.

export interface ImapAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  // Optional webmail UI URL — when set, messages from this account carry it
  // as their `link` so the Email tile can open the provider's web client.
  webmailUrl?: string | null;
}

export interface CalDavAccount {
  id: string;
  label: string;
  url: string;
  username: string;
  password: string;
}

function readAccounts<T>(userId: number, service: string): T[] {
  const row = connectionStmts.findByService.get(userId, service);
  if (!row?.extra) return [];
  try {
    const parsed = JSON.parse(row.extra) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeAccounts<T>(userId: number, service: string, accounts: T[]): void {
  connectionStmts.upsert.run(
    userId,
    service,
    null,
    null,
    null,
    null,
    accounts.length > 0 ? JSON.stringify(accounts) : null,
  );
  // Account list changed — drop any cached inbox/event responses for this
  // provider so tiles reflect the change on their next refresh.
  invalidateFetchCache(service === "imap" ? `mail:imap:${userId}:` : `mail:caldav:${userId}:`);
}

function newId(): string {
  return randomBytes(6).toString("hex");
}

// ── IMAP ──────────────────────────────────────────────────────────────────────

export function listImapAccounts(userId: number): ImapAccount[] {
  return readAccounts<ImapAccount>(userId, "imap").filter(
    (a) => a && typeof a === "object" && typeof a.host === "string" && typeof a.username === "string",
  );
}

// Only accept http(s) URLs for the webmail link — anything else (javascript:,
// bare hostnames, garbage) is dropped rather than rendered as a clickable link.
export function normalizeWebmailUrl(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function addImapAccount(
  userId: number,
  input: {
    label?: string | null;
    host: string;
    port?: number | null;
    secure?: boolean | null;
    username: string;
    password: string;
    webmailUrl?: string | null;
  },
): ImapAccount[] {
  const port = input.port ?? 993;
  validateOutboundPort(port);
  const accounts = listImapAccounts(userId);
  accounts.push({
    id: newId(),
    label: input.label?.trim() || input.username,
    host: input.host.trim(),
    port,
    secure: input.secure ?? true,
    username: input.username.trim(),
    password: input.password,
    webmailUrl: normalizeWebmailUrl(input.webmailUrl),
  });
  writeAccounts(userId, "imap", accounts);
  return accounts;
}

export function removeImapAccount(userId: number, id: string): ImapAccount[] | null {
  const accounts = listImapAccounts(userId);
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return null;
  writeAccounts(userId, "imap", next);
  return next;
}

// ── CalDAV ────────────────────────────────────────────────────────────────────

export function listCalDavAccounts(userId: number): CalDavAccount[] {
  return readAccounts<CalDavAccount>(userId, "caldav").filter(
    (a) => a && typeof a === "object" && typeof a.url === "string" && typeof a.username === "string",
  );
}

export function addCalDavAccount(
  userId: number,
  input: {
    label?: string | null;
    url: string;
    username: string;
    password: string;
  },
): CalDavAccount[] {
  const accounts = listCalDavAccounts(userId);
  accounts.push({
    id: newId(),
    label: input.label?.trim() || input.username,
    url: input.url.trim(),
    username: input.username.trim(),
    password: input.password,
  });
  writeAccounts(userId, "caldav", accounts);
  return accounts;
}

export function removeCalDavAccount(userId: number, id: string): CalDavAccount[] | null {
  const accounts = listCalDavAccounts(userId);
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return null;
  writeAccounts(userId, "caldav", next);
  return next;
}
