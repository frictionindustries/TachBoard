import { Router } from "express";
import { newBrowserBinding, setBrowserBinding } from "../lib/oauthBrowser.js";
import { requireAuth, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { normalizeHttpError } from "../lib/http.js";
import {
  isGoogleConfigured,
  isGoogleLinked,
  listGoogleAccounts,
  removeGoogleAccount,
  clearGoogleTokens,
  getGoogleAccessToken,
  createGoogleAuthIntent,
  getGoogleCredentialSource,
  getGoogleClientId,
  setGoogleCredentials,
  clearGoogleCredentials,
  CALLBACK_PATH,
} from "../lib/google.js";

// ── Google link status/disconnect (Settings) ─────────────────────────────────
// The OAuth flow itself (auth redirect + callback) lives under /widgets/gmail
// in widgets.ts because the callback URL is part of the task's public
// contract. This router only backs the Settings card.

const router = Router();

// Derive the browser-facing origin from the (proxied) request so the displayed
// redirect URI matches what the OAuth flow will actually use.
function originFromRequest(req: {
  headers: Record<string, unknown>;
  protocol: string;
  get: (h: string) => string | undefined;
}): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ||
    req.protocol;
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ||
    req.get("host") ||
    "";
  return `${proto}://${host}`;
}

async function buildStatus(userId: number, origin: string) {
  const configured = isGoogleConfigured(userId);
  const linked = configured ? listGoogleAccounts(userId) : [];

  // Validate each linked account's tokens (revoked/expired refresh tokens
  // report as not connected so the UI prompts a reconnect).
  const accounts = await Promise.all(
    linked.map(async (account) => {
      let ok = false;
      try {
        await getGoogleAccessToken(userId, account.id);
        ok = true;
      } catch (err) {
        logger.warn(
          { reason: normalizeHttpError(err), account: account.email },
          "Google status check failed",
        );
      }
      return { id: account.id, email: account.email ?? null, connected: ok };
    }),
  );

  const firstConnected = accounts.find((a) => a.connected);

  return {
    configured,
    // Back-compat summary fields: connected = any usable account.
    connected: Boolean(firstConnected),
    email: firstConnected?.email ?? null,
    accounts,
    redirectUri: `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`,
    // Where the active OAuth client credentials come from: "env" (server
    // environment variables — read-only in the UI), "stored" (saved via
    // Settings), or null (not configured yet). The secret is never returned.
    credentialSource: getGoogleCredentialSource(userId),
    clientId: configured ? getGoogleClientId(userId) : null,
  };
}

// GET /api/connections/google/status
router.get("/status", requireAuth, async (req: AuthRequest, res) => {
  res.json(await buildStatus(req.user!.userId, originFromRequest(req)));
});

// POST /api/connections/google/auth-intent — mint a short-lived single-use
// token that authorizes ONE run of the popup OAuth flow, bound to the
// caller's userId. The popup navigation to /widgets/gmail/auth cannot carry
// the bearer token, so without this guard any unauthenticated visitor could
// bind their own Google account to another user's link.
router.post("/auth-intent", requireAuth, (req: AuthRequest, res) => {
  const binding = newBrowserBinding();
  const intent = createGoogleAuthIntent(req.user!.userId, binding);
  setBrowserBinding(req, res, intent, binding);
  res.json({ intent });
});

// PUT /api/connections/google/credentials — save the OAuth client ID/secret
// from Settings. Env vars, when set, take precedence over stored values;
// reject edits in that case so the UI can't silently save dead config.
router.put("/credentials", requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  if (getGoogleCredentialSource(userId) === "env") {
    res.status(409).json({
      error: "Google credentials are set via environment variables and cannot be changed here",
    });
    return;
  }
  const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.trim() : "";
  const clientSecret =
    typeof req.body?.clientSecret === "string" ? req.body.clientSecret.trim() : "";
  if (!clientId || !clientSecret) {
    res.status(400).json({ error: "clientId and clientSecret are required" });
    return;
  }
  setGoogleCredentials(userId, clientId, clientSecret);
  logger.info({ userId }, "Google OAuth credentials saved via Settings");
  buildStatus(userId, originFromRequest(req)).then((s) => res.json(s));
});

// DELETE /api/connections/google/credentials — remove stored credentials (and
// the account link, which is bound to them).
router.delete("/credentials", requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  if (getGoogleCredentialSource(userId) === "env") {
    res.status(409).json({
      error: "Google credentials are set via environment variables and cannot be removed here",
    });
    return;
  }
  clearGoogleCredentials(userId);
  buildStatus(userId, originFromRequest(req)).then((s) => res.json(s));
});

// POST /api/connections/google/disconnect — with { accountId } unlinks that
// one account; without a body unlinks every one of the caller's own linked
// Google accounts.
router.post("/disconnect", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : null;
  if (accountId) {
    removeGoogleAccount(userId, accountId);
  } else {
    clearGoogleTokens(userId);
  }
  res.json(await buildStatus(userId, originFromRequest(req)));
});

export default router;
