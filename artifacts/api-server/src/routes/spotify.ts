import { Router } from "express";
import { newBrowserBinding, setBrowserBinding, readBrowserBinding, clearBrowserBinding } from "../lib/oauthBrowser.js";
import { requireAuth, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { normalizeHttpError } from "../lib/http.js";
import {
  getSpotifyConnection,
  saveSpotifyCredentials,
  clearSpotifyTokens,
  buildAuthorizeUrl,
  exchangeCode,
  getValidAccessToken,
  getProfile,
  createPendingAuth,
  consumePendingAuth,
} from "../lib/spotify.js";

const router = Router();

const CALLBACK_PATH = "/api/connections/spotify/callback";

// Derive the browser-facing origin from the (proxied) request so the displayed
// redirect URI matches what the dashboard will actually use.
function originFromRequest(req: { headers: Record<string, unknown>; protocol: string; get: (h: string) => string | undefined }): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}`;
}

function redirectUriFor(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

async function buildStatus(userId: number, redirectUri: string) {
  const conn = getSpotifyConnection(userId);
  const configured = Boolean(conn.clientId && conn.clientSecret);
  const linked = configured && Boolean(conn.tokens.refreshToken);

  let connected = false;
  let premium: boolean | null = null;
  let displayName: string | null = null;

  if (linked) {
    try {
      const token = await getValidAccessToken(userId);
      const profile = await getProfile(token);
      connected = true;
      premium = profile.premium;
      displayName = profile.displayName;
    } catch (err) {
      // Tokens present but unusable (revoked, expired refresh) — report as not
      // connected so the UI prompts a reconnect.
      logger.warn({ reason: normalizeHttpError(err) }, "Spotify status check failed");
      connected = false;
    }
  }

  return { configured, connected, premium, displayName, redirectUri };
}

// POST /api/connections/spotify/credentials — save app Client ID + Secret.
router.post("/credentials", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { clientId?: string; clientSecret?: string };
  const clientId = body.clientId?.trim();
  const clientSecret = body.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    res.status(400).json({ error: "clientId and clientSecret are required" });
    return;
  }
  const userId = req.user!.userId;
  saveSpotifyCredentials(userId, clientId, clientSecret);
  res.json(await buildStatus(userId, redirectUriFor(originFromRequest(req))));
});

// GET /api/connections/spotify/status — configured/connected + profile.
router.get("/status", requireAuth, async (req: AuthRequest, res) => {
  res.json(await buildStatus(req.user!.userId, redirectUriFor(originFromRequest(req))));
});

// POST /api/connections/spotify/authorize — begin OAuth, return the authorize URL.
// `origin` is the dashboard's base URL (host + SPA base path, e.g.
// "https://host/homelab-dashboard/"). The OAuth redirect URI hangs off the host
// root (/api is proxied there), while the post-auth return must respect the SPA
// base path — so we derive both from the supplied base URL.
router.post("/authorize", requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const conn = getSpotifyConnection(userId);
  if (!conn.clientId || !conn.clientSecret) {
    res.status(400).json({ error: "Save your Spotify Client ID and Secret first." });
    return;
  }
  const body = (req.body ?? {}) as { origin?: string };
  const base = body.origin?.trim() || originFromRequest(req);
  let hostOrigin: string;
  try {
    hostOrigin = new URL(base).origin;
  } catch {
    hostOrigin = originFromRequest(req);
  }
  const redirectUri = redirectUriFor(hostOrigin);
  const returnTo = `${base.replace(/\/+$/, "")}/settings`;
  const binding = newBrowserBinding();
  const state = createPendingAuth(userId, redirectUri, returnTo, binding);
  setBrowserBinding(req, res, state, binding);
  res.json({ url: buildAuthorizeUrl(conn.clientId, redirectUri, state) });
});

// GET /api/connections/spotify/callback — Spotify redirects the browser here.
// Unauthenticated by necessity (top-level navigation can't carry the bearer
// token); protected by single-use state AND an initiating-browser cookie.
router.get("/callback", async (req, res) => {
  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  const state = typeof req.query["state"] === "string" ? req.query["state"] : null;
  const error = typeof req.query["error"] === "string" ? req.query["error"] : null;

  const pending = state ? consumePendingAuth(state, readBrowserBinding(req, state)) : null;
  if (pending) clearBrowserBinding(req, res, state!);
  const fallbackReturn = `${originFromRequest(req).replace(/\/+$/, "")}/settings`;
  const returnTo = pending?.returnTo || fallbackReturn;
  const settingsUrl = (status: string) => `${returnTo}?spotify=${status}`;

  if (error || !code || !pending) {
    logger.warn({ error, hasCode: Boolean(code), hasPending: Boolean(pending) }, "Spotify callback rejected");
    res.redirect(settingsUrl("error"));
    return;
  }

  const conn = getSpotifyConnection(pending.userId);
  if (!conn.clientId || !conn.clientSecret) {
    res.redirect(settingsUrl("error"));
    return;
  }

  try {
    await exchangeCode(pending.userId, conn.clientId, conn.clientSecret, code, pending.redirectUri);
    res.redirect(settingsUrl("connected"));
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Spotify token exchange failed");
    res.redirect(settingsUrl("error"));
  }
});

// POST /api/connections/spotify/disconnect — clear stored OAuth tokens.
router.post("/disconnect", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  clearSpotifyTokens(userId);
  res.json(await buildStatus(userId, redirectUriFor(originFromRequest(req))));
});

// GET /api/connections/spotify/token — fresh access token for the Web Playback SDK.
router.get("/token", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const conn = getSpotifyConnection(userId);
  if (!conn.clientId || !conn.clientSecret || !conn.tokens.refreshToken) {
    res.json({ accessToken: null, expiresAt: null });
    return;
  }
  try {
    const accessToken = await getValidAccessToken(userId);
    const expiresAt = getSpotifyConnection(userId).tokens.expiresAt ?? null;
    res.json({ accessToken, expiresAt });
  } catch (err) {
    logger.warn({ reason: normalizeHttpError(err) }, "Spotify token mint failed");
    res.json({ accessToken: null, expiresAt: null });
  }
});

export default router;
