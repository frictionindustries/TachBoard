import { randomBytes } from "crypto";
import { matchesBrowserBinding } from "./oauthBrowser.js";
import { cloudHttpClient } from "./http.js";
import { connectionStmts } from "./db.js";
import { logger } from "./logger.js";
import { invalidateFetchCache } from "./fetchCache.js";

// The linked-account list changed (link/unlink/re-link) — drop cached Gmail
// inbox and Google Calendar responses so tiles reflect it immediately.
function invalidateGoogleWidgetCaches(userId: number): void {
  invalidateFetchCache(`mail:gmail:${userId}:`);
  invalidateFetchCache(`mail:gcal:${userId}:`);
}

// ── Google OAuth helper (Gmail + Google Calendar) ────────────────────────────
// The app credentials (OAuth client ID/secret) come from either the
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET environment variables or, more
// commonly, from Settings: they're stored per-user in the `service_connections`
// table under that user's "google" row's JSON `extra` blob. Env vars take
// precedence when both are present. The linked account's OAuth tokens are
// persisted under the user's "gmail" row's `extra` blob (the "google_calendar"
// row mirrors it so both features read the same link). All Google calls go
// over the TLS-verifying `cloudHttpClient`.

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const CALLBACK_PATH = "/api/widgets/gmail/callback";

// Mail read + modify (archiving removes the INBOX label), read-only calendar,
// plus the email address for display in Settings. Accounts linked before the
// modify scope was added still work read-only; archiving them returns 403
// until the user re-links.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly",
  // Read-only Google Photos library access for the Picture Frame tile.
  // Accounts linked before this scope was added simply lack it; the Photos
  // routes surface a clear "re-link" error until the user reconnects.
  "https://www.googleapis.com/auth/photoslibrary.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

// Refresh a little early so a token never expires mid-request.
const EXPIRY_SKEW_MS = 60_000;

interface StoredGoogleCredentials {
  clientId?: string;
  clientSecret?: string;
}

export function getStoredGoogleCredentials(userId: number): StoredGoogleCredentials {
  const row = connectionStmts.findByService.get(userId, "google");
  if (!row?.extra) return {};
  try {
    return JSON.parse(row.extra) as StoredGoogleCredentials;
  } catch {
    return {};
  }
}

// Saving new credentials also clears any linked account: existing refresh
// tokens are bound to the old OAuth client and would fail to refresh anyway.
export function setGoogleCredentials(userId: number, clientId: string, clientSecret: string): void {
  const extra = JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
  connectionStmts.upsert.run(userId, "google", null, null, null, null, extra);
  clearGoogleTokens(userId);
}

export function clearGoogleCredentials(userId: number): void {
  connectionStmts.upsert.run(userId, "google", null, null, null, null, null);
  clearGoogleTokens(userId);
}

export function getGoogleClientId(userId: number): string | null {
  return (
    process.env["GOOGLE_CLIENT_ID"]?.trim() ||
    getStoredGoogleCredentials(userId).clientId?.trim() ||
    null
  );
}
export function getGoogleClientSecret(userId: number): string | null {
  return (
    process.env["GOOGLE_CLIENT_SECRET"]?.trim() ||
    getStoredGoogleCredentials(userId).clientSecret?.trim() ||
    null
  );
}
export function isGoogleConfigured(userId: number): boolean {
  return Boolean(getGoogleClientId(userId) && getGoogleClientSecret(userId));
}
// Where the active credentials come from — drives the Settings UI (env-provided
// credentials cannot be edited in the app).
export function getGoogleCredentialSource(userId: number): "env" | "stored" | null {
  if (process.env["GOOGLE_CLIENT_ID"]?.trim() && process.env["GOOGLE_CLIENT_SECRET"]?.trim()) {
    return "env";
  }
  const stored = getStoredGoogleCredentials(userId);
  if (stored.clientId?.trim() && stored.clientSecret?.trim()) return "stored";
  return null;
}

interface GoogleTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scope?: string;
  email?: string;
}

// Short-lived CSRF `state` values issued by /auth and consumed by /callback.
// Kept in-process — the OAuth round-trip is seconds long and a server restart
// simply means the user clicks "Connect" again. Each entry remembers which
// user started the flow so the callback links the account to the right owner.
interface PendingAuth {
  userId: number;
  browserBinding: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
}
const pendingAuth = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60_000;

function prunePending(): void {
  const now = Date.now();
  for (const [state, entry] of pendingAuth) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingAuth.delete(state);
  }
}

export function createGooglePendingAuth(userId: number, redirectUri: string, returnTo: string, browserBinding: string): string {
  prunePending();
  const state = randomBytes(16).toString("hex");
  pendingAuth.set(state, { userId, redirectUri, returnTo, browserBinding, createdAt: Date.now() });
  return state;
}

export function consumeGooglePendingAuth(state: string, browserBinding: string | undefined): PendingAuth | null {
  prunePending();
  const entry = pendingAuth.get(state);
  if (!entry || !matchesBrowserBinding(entry.browserBinding, browserBinding)) return null;
  pendingAuth.delete(state);
  return entry;
}

// ── Auth intents ──────────────────────────────────────────────────────────────
// /widgets/gmail/auth is a top-level popup navigation, so it cannot carry the
// bearer token. Without a guard, ANY unauthenticated visitor could start the
// OAuth flow and bind their own Google account to another user's link.
// Settings therefore first calls the authenticated
// POST /connections/google/auth-intent to mint a short-lived single-use token
// bound to the caller's userId, which the popup URL must present before the
// flow may begin.
const authIntents = new Map<string, { userId: number; browserBinding: string; createdAt: number }>();
const INTENT_TTL_MS = 5 * 60_000;

function pruneIntents(): void {
  const now = Date.now();
  for (const [token, entry] of authIntents) {
    if (now - entry.createdAt > INTENT_TTL_MS) authIntents.delete(token);
  }
}

export function createGoogleAuthIntent(userId: number, browserBinding: string): string {
  pruneIntents();
  const token = randomBytes(24).toString("hex");
  authIntents.set(token, { userId, browserBinding, createdAt: Date.now() });
  return token;
}

// Returns the userId the intent was minted for, or null if invalid/expired.
export function consumeGoogleAuthIntent(token: string, browserBinding: string | undefined): number | null {
  pruneIntents();
  const entry = authIntents.get(token);
  if (!entry || !matchesBrowserBinding(entry.browserBinding, browserBinding)) return null;
  authIntents.delete(token);
  return entry.userId;
}

// ── Persistence ───────────────────────────────────────────────────────────────
// Multiple Google accounts can be linked per user; each carries its own token
// set. Stored as { accounts: GoogleAccount[] } in that user's "gmail" row's
// extra blob (mirrored into "google_calendar"). A legacy single-token blob
// (pre multi-account) is migrated on read into a one-element accounts array.

export interface GoogleAccount extends GoogleTokens {
  id: string;
  email?: string;
}

interface GoogleStore {
  accounts: GoogleAccount[];
}

function parseStore(raw: string | null | undefined): GoogleStore {
  if (!raw) return { accounts: [] };
  try {
    const parsed = JSON.parse(raw) as GoogleStore & GoogleTokens;
    if (Array.isArray(parsed.accounts)) {
      return { accounts: parsed.accounts.filter((a) => a && typeof a.id === "string") };
    }
    // Legacy shape: a single token blob at the top level. Use a stable id —
    // this runs on every read until the next write persists the new shape.
    if (parsed.refreshToken) {
      return { accounts: [{ ...parsed, id: "legacy" }] };
    }
    return { accounts: [] };
  } catch {
    return { accounts: [] };
  }
}

function getStore(userId: number): GoogleStore {
  return parseStore(connectionStmts.findByService.get(userId, "gmail")?.extra);
}

function persistStore(userId: number, store: GoogleStore): void {
  const extra = store.accounts.length > 0 ? JSON.stringify(store) : null;
  // Both the Email and Calendar features read the same Google links; mirror
  // into both service rows so either can be inspected independently.
  connectionStmts.upsert.run(userId, "gmail", null, null, null, null, extra);
  connectionStmts.upsert.run(userId, "google_calendar", null, null, null, null, extra);
}

// Linked Google accounts (only those with a usable refresh token).
export function listGoogleAccounts(userId: number): GoogleAccount[] {
  return getStore(userId).accounts.filter((a) => Boolean(a.refreshToken));
}

export function getGoogleAccount(userId: number, id: string): GoogleAccount | null {
  return getStore(userId).accounts.find((a) => a.id === id) ?? null;
}

// Add or replace (matched by email — re-linking the same address refreshes it
// in place rather than duplicating). Returns the stored account.
export function upsertGoogleAccount(
  userId: number,
  tokens: GoogleTokens & { email?: string },
): GoogleAccount {
  const store = getStore(userId);
  const existing = tokens.email
    ? store.accounts.find((a) => a.email?.toLowerCase() === tokens.email?.toLowerCase())
    : undefined;
  if (existing) {
    Object.assign(existing, tokens);
    persistStore(userId, store);
    invalidateGoogleWidgetCaches(userId);
    return existing;
  }
  const account: GoogleAccount = { id: randomBytes(6).toString("hex"), ...tokens };
  store.accounts.push(account);
  persistStore(userId, store);
  invalidateGoogleWidgetCaches(userId);
  return account;
}

function updateGoogleAccount(userId: number, id: string, tokens: GoogleTokens): void {
  const store = getStore(userId);
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return;
  Object.assign(account, tokens);
  persistStore(userId, store);
}

export function removeGoogleAccount(userId: number, id: string): boolean {
  const store = getStore(userId);
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  persistStore(userId, store);
  invalidateGoogleWidgetCaches(userId);
  return store.accounts.length < before;
}

export function clearGoogleTokens(userId: number): void {
  persistStore(userId, { accounts: [] });
  invalidateGoogleWidgetCaches(userId);
}

export function isGoogleLinked(userId: number): boolean {
  return isGoogleConfigured(userId) && listGoogleAccounts(userId).length > 0;
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

export function buildGoogleAuthUrl(userId: number, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: getGoogleClientId(userId) ?? "",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: GOOGLE_SCOPES,
    state,
    access_type: "offline",
    // "consent" forces the consent screen so Google always returns a refresh
    // token; "select_account" shows the account chooser so a second/third
    // Google account can be linked even while another one is signed in.
    prompt: "consent select_account",
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export async function exchangeGoogleCode(userId: number, code: string, redirectUri: string): Promise<void> {
  const clientId = getGoogleClientId(userId);
  const clientSecret = getGoogleClientSecret(userId);
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const r = await cloudHttpClient.post<TokenResponse>(TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const data = r.data;

  // Fetch the account's email address for display in Settings.
  let email: string | undefined;
  try {
    const profile = await cloudHttpClient.get<{ email?: string }>(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${data.access_token}` } },
    );
    email = profile.data.email;
  } catch (err) {
    logger.warn({ err }, "Google userinfo fetch failed");
  }

  upsertGoogleAccount(userId, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
    ...(email ? { email } : {}),
  });
}

// Return a valid access token for one linked account, refreshing when expired.
// Throws when Google is not configured or the account is not linked.
export async function getGoogleAccessToken(userId: number, accountId: string): Promise<string> {
  const clientId = getGoogleClientId(userId);
  const clientSecret = getGoogleClientSecret(userId);
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured");
  const account = getGoogleAccount(userId, accountId);
  if (!account?.refreshToken) throw new Error("Google account is not linked");
  if (
    account.accessToken &&
    account.expiresAt &&
    Date.now() < account.expiresAt - EXPIRY_SKEW_MS
  ) {
    return account.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const r = await cloudHttpClient.post<TokenResponse>(TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const data = r.data;
  updateGoogleAccount(userId, account.id, {
    accessToken: data.access_token,
    // Google only returns a refresh token on the initial consent; keep ours.
    refreshToken: data.refresh_token ?? account.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? account.scope,
  });
  return data.access_token;
}
