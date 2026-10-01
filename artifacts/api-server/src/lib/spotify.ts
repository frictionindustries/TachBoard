import { randomBytes } from "crypto";
import { matchesBrowserBinding } from "./oauthBrowser.js";
import { cloudHttpClient } from "./http.js";
import { connectionStmts } from "./db.js";
import { logger } from "./logger.js";

// ── Spotify OAuth + Web API helper ────────────────────────────────────────────
// Spotify has no Replit integration, so each user supplies their own app
// credentials (Client ID + Secret) and links their account via the Authorization
// Code flow. Everything is stored in that user's `service_connections` row
// keyed "spotify": api_key = clientId, password = clientSecret, and the OAuth
// tokens live in the JSON `extra` blob. All Spotify calls go over the
// TLS-verifying `cloudHttpClient` (never the self-signed-tolerant LAN client)
// because they carry bearer tokens over the public internet.

const ACCOUNTS_BASE = "https://accounts.spotify.com";
const API_BASE = "https://api.spotify.com/v1";

// Scopes: read playback + currently-playing, modify playback (remote control),
// `streaming` for the Web Playback SDK, and the read-private/email pair the SDK
// requires to mint a player.
export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "streaming",
  "user-read-email",
  "user-read-private",
].join(" ");

// Refresh a little early so a token never expires mid-request.
const EXPIRY_SKEW_MS = 60_000;

interface SpotifyTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scope?: string;
}

export interface SpotifyConnection {
  clientId: string | null;
  clientSecret: string | null;
  tokens: SpotifyTokens;
}

// Short-lived CSRF `state` values issued by /authorize and consumed by
// /callback. Kept in-process: the OAuth round-trip is seconds long and a server
// restart simply means the user clicks "Connect" again. Each entry carries the
// exact redirect URI used (so the token exchange matches byte-for-byte), the
// base-path-aware page to send the browser back to afterwards, and which user
// started the flow so the callback links the account to the right owner.
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

export function createPendingAuth(userId: number, redirectUri: string, returnTo: string, browserBinding: string): string {
  prunePending();
  const state = randomBytes(16).toString("hex");
  pendingAuth.set(state, { userId, redirectUri, returnTo, browserBinding, createdAt: Date.now() });
  return state;
}

export function consumePendingAuth(state: string, browserBinding: string | undefined): PendingAuth | null {
  prunePending();
  const entry = pendingAuth.get(state);
  if (!entry || !matchesBrowserBinding(entry.browserBinding, browserBinding)) return null;
  pendingAuth.delete(state);
  return entry;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function getSpotifyConnection(userId: number): SpotifyConnection {
  const row = connectionStmts.findByService.get(userId, "spotify");
  let tokens: SpotifyTokens = {};
  if (row?.extra) {
    try {
      tokens = JSON.parse(row.extra) as SpotifyTokens;
    } catch {
      tokens = {};
    }
  }
  return {
    clientId: row?.api_key ?? null,
    clientSecret: row?.password ?? null,
    tokens,
  };
}

function persist(
  userId: number,
  clientId: string | null,
  clientSecret: string | null,
  tokens: SpotifyTokens,
): void {
  connectionStmts.upsert.run(
    userId,
    "spotify",
    null,
    clientId,
    null,
    clientSecret,
    Object.keys(tokens).length > 0 ? JSON.stringify(tokens) : null,
  );
}

export function saveSpotifyCredentials(userId: number, clientId: string, clientSecret: string): void {
  // Changing app credentials invalidates any existing tokens, so clear them.
  persist(userId, clientId, clientSecret, {});
}

export function saveSpotifyTokens(userId: number, tokens: SpotifyTokens): void {
  const conn = getSpotifyConnection(userId);
  persist(userId, conn.clientId, conn.clientSecret, { ...conn.tokens, ...tokens });
}

export function clearSpotifyTokens(userId: number): void {
  const conn = getSpotifyConnection(userId);
  persist(userId, conn.clientId, conn.clientSecret, {});
}

// ── OAuth ──────────────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES,
    state,
    show_dialog: "false",
  });
  return `${ACCOUNTS_BASE}/authorize?${params.toString()}`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
  expires_in: number;
  refresh_token?: string;
}

// Exchange an authorization code for tokens and persist them.
export async function exchangeCode(
  userId: number,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const r = await cloudHttpClient.post<TokenResponse>(`${ACCOUNTS_BASE}/api/token`, body.toString(), {
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const data = r.data;
  saveSpotifyTokens(userId, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  });
}

// Return a valid access token, refreshing it when expired. Throws when Spotify
// is not fully linked (no credentials or no refresh token).
export async function getValidAccessToken(userId: number): Promise<string> {
  const conn = getSpotifyConnection(userId);
  if (!conn.clientId || !conn.clientSecret) {
    throw new Error("Spotify is not configured");
  }
  if (!conn.tokens.refreshToken) {
    throw new Error("Spotify account is not linked");
  }
  const { accessToken, expiresAt } = conn.tokens;
  if (accessToken && expiresAt && Date.now() < expiresAt - EXPIRY_SKEW_MS) {
    return accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: conn.tokens.refreshToken,
  });
  const r = await cloudHttpClient.post<TokenResponse>(`${ACCOUNTS_BASE}/api/token`, body.toString(), {
    headers: {
      Authorization: basicAuthHeader(conn.clientId, conn.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const data = r.data;
  saveSpotifyTokens(userId, {
    accessToken: data.access_token,
    // Spotify only sometimes returns a new refresh token; keep the old one
    // otherwise so the link survives.
    refreshToken: data.refresh_token ?? conn.tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? conn.tokens.scope,
  });
  return data.access_token;
}

// ── Web API ─────────────────────────────────────────────────────────────────────

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

export interface SpotifyProfile {
  displayName: string | null;
  premium: boolean;
}

export async function getProfile(token: string): Promise<SpotifyProfile> {
  const r = await cloudHttpClient.get<{ display_name?: string; product?: string }>(`${API_BASE}/me`, {
    headers: authHeaders(token),
  });
  return {
    displayName: r.data.display_name ?? null,
    premium: r.data.product === "premium",
  };
}

export interface SpotifyArtistRef {
  name?: string;
}
export interface SpotifyTrackObject {
  id?: string | null;
  name?: string;
  duration_ms?: number;
  artists?: SpotifyArtistRef[];
  album?: { name?: string; images?: { url?: string }[] };
}
export interface SpotifyDeviceObject {
  id?: string | null;
  name?: string;
  is_active?: boolean;
  volume_percent?: number | null;
}
export interface SpotifyPlayback {
  is_playing?: boolean;
  progress_ms?: number | null;
  item?: SpotifyTrackObject | null;
  device?: SpotifyDeviceObject | null;
}

// GET /me/player returns 204 (empty) when nothing is active; surface that as null.
export async function getPlayback(token: string): Promise<SpotifyPlayback | null> {
  const r = await cloudHttpClient.get<SpotifyPlayback | "">(`${API_BASE}/me/player`, {
    headers: authHeaders(token),
    // Spotify uses 204 No Content for "nothing playing"; don't treat as error.
    validateStatus: (s) => (s >= 200 && s < 300) || s === 204,
  });
  if (r.status === 204 || !r.data || typeof r.data !== "object") return null;
  return r.data;
}

export async function getQueue(token: string): Promise<SpotifyTrackObject[]> {
  const r = await cloudHttpClient.get<{ queue?: SpotifyTrackObject[] }>(`${API_BASE}/me/player/queue`, {
    headers: authHeaders(token),
  });
  return (r.data.queue ?? []).filter((t) => t && typeof t === "object");
}

export type SpotifyCommand = "play" | "pause" | "next" | "previous" | "transfer";

// Run a remote-control command against the active device. Returns "no-device"
// when Spotify reports there is nothing to control so the caller can answer 404.
export async function sendCommand(
  token: string,
  action: SpotifyCommand,
  deviceId?: string | null,
): Promise<"ok" | "no-device"> {
  const headers = authHeaders(token);
  try {
    switch (action) {
      case "play": {
        const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
        await cloudHttpClient.put(`${API_BASE}/me/player/play${q}`, {}, { headers });
        break;
      }
      case "pause":
        await cloudHttpClient.put(`${API_BASE}/me/player/pause`, {}, { headers });
        break;
      case "next":
        await cloudHttpClient.post(`${API_BASE}/me/player/next`, {}, { headers });
        break;
      case "previous":
        await cloudHttpClient.post(`${API_BASE}/me/player/previous`, {}, { headers });
        break;
      case "transfer": {
        if (!deviceId) throw new Error("transfer requires a deviceId");
        await cloudHttpClient.put(
          `${API_BASE}/me/player`,
          { device_ids: [deviceId], play: true },
          { headers },
        );
        break;
      }
    }
    return "ok";
  } catch (err) {
    // 404 NO_ACTIVE_DEVICE is an expected, recoverable state — let the caller
    // turn it into a clear "open Spotify on a device" message.
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return "no-device";
    logger.error({ err, action }, "Spotify command failed");
    throw err;
  }
}
