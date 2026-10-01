import { Router } from "express";
import { connectionStmts, healthStmts, type DbServiceConnection } from "../lib/db.js";
import { requireAuth, type AuthRequest } from "../lib/auth.js";
import {
  listImapAccounts,
  addImapAccount,
  removeImapAccount,
  listCalDavAccounts,
  addCalDavAccount,
  removeCalDavAccount,
  type ImapAccount,
  type CalDavAccount,
} from "../lib/mailAccounts.js";
import {
  listAiAccounts,
  addAiAccount,
  updateAiAccount,
  removeAiAccount,
  maskApiKey,
  isAiProvider,
  isLocalAiProvider,
  type AiAccount,
} from "../lib/aiAccounts.js";
import { aiTestKey } from "../lib/aiProviders.js";
import { normalizeHttpError } from "../lib/http.js";
import { resolvePublicHost, validateOutboundPort } from "../lib/outboundTargets.js";
import {
  runPing,
  connectionToValues,
  isConfigured,
  type TestValues,
} from "../lib/ping.js";

const router = Router();

const SUPPORTED_SERVICES = ["truenas", "plex", "jellyfin", "subsonic", "sonarr", "radarr", "lidarr", "qbittorrent", "pihole", "nginx-proxy-manager", "prowlarr", "pterodactyl", "tailscale", "ersatztv", "stocks", "immich"];

function formatConnection(c: DbServiceConnection) {
  let token: string | null = null;
  if (c.extra) {
    try {
      const parsed = JSON.parse(c.extra) as { token?: string };
      token = parsed.token ?? null;
    } catch {
      token = null;
    }
  }

  return {
    service: c.service,
    url: c.url,
    apiKey: c.api_key,
    username: c.username,
    password: c.password,
    token,
    updatedAt: c.updated_at,
  };
}

// GET /api/connections — list the caller's own saved service connections
router.get("/", requireAuth, (req: AuthRequest, res) => {
  const rows = connectionStmts.findAllByUser.all(req.user!.userId);
  res.json(rows.map(formatConnection));
});

// GET /api/connections/health — last-known health of each of the caller's own
// checked connections, produced by the background scheduler and polled by the
// dashboard.
router.get("/health", requireAuth, (req: AuthRequest, res) => {
  const rows = healthStmts.findAllByUser.all(req.user!.userId);
  res.json(
    rows.map((r) => ({
      service: r.service,
      ok: Boolean(r.ok),
      message: r.message,
      checkedAt: r.checked_at,
    })),
  );
});

// GET /api/connections/status — ping every one of the caller's saved
// connections right now and report whether each backing service is currently
// reachable. Reuses runPing so the dashboard badges show the same status the
// on-demand test would.
router.get("/status", requireAuth, async (req: AuthRequest, res) => {
  const rows = connectionStmts.findAllByUser.all(req.user!.userId);
  const bySaved = new Map(rows.map((r) => [r.service, r]));

  const statuses = await Promise.all(
    SUPPORTED_SERVICES.map(async (service) => {
      const row = bySaved.get(service);
      const values = row ? connectionToValues(row) : null;
      const checkedAt = new Date().toISOString();
      if (!values || !isConfigured(values)) {
        return { service, configured: false, ok: false, message: "Not configured", checkedAt };
      }
      const result = await runPing(service, values);
      return { service, configured: true, ok: result.ok, message: result.message, checkedAt };
    }),
  );

  res.json(statuses);
});

// ── IMAP / CalDAV multi-account management ────────────────────────────────────
// These lists live in the `extra` JSON of the caller's own "imap"/"caldav"
// rows and support several accounts each, so they get dedicated add/remove
// routes instead of the single-connection PUT below. Passwords never leave
// the server.

function sanitizeImap(a: ImapAccount) {
  return {
    id: a.id,
    label: a.label,
    host: a.host,
    port: a.port,
    secure: a.secure,
    username: a.username,
    webmailUrl: a.webmailUrl ?? null,
  };
}
function sanitizeCalDav(a: CalDavAccount) {
  return { id: a.id, label: a.label, url: a.url, username: a.username };
}

// GET /api/connections/imap/accounts
router.get("/imap/accounts", requireAuth, (req: AuthRequest, res) => {
  res.json(listImapAccounts(req.user!.userId).map(sanitizeImap));
});

// POST /api/connections/imap/accounts
router.post("/imap/accounts", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as {
    label?: string | null;
    host?: string;
    port?: number | null;
    secure?: boolean | null;
    username?: string;
    password?: string;
    webmailUrl?: string | null;
  };
  if (
    typeof body.host !== "string" || !body.host.trim() ||
    typeof body.username !== "string" || !body.username.trim() ||
    typeof body.password !== "string" || !body.password
  ) {
    res.status(400).json({ error: "host, username and password are required" });
    return;
  }
  const port = body.port ?? 993;
  try {
    validateOutboundPort(port);
    await resolvePublicHost(body.host.trim());
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid IMAP destination" });
    return;
  }
  const accounts = addImapAccount(req.user!.userId, {
    label: typeof body.label === "string" ? body.label : null,
    host: body.host,
    port,
    secure: typeof body.secure === "boolean" ? body.secure : null,
    username: body.username,
    password: body.password,
    webmailUrl: typeof body.webmailUrl === "string" ? body.webmailUrl : null,
  });
  res.json(accounts.map(sanitizeImap));
});

// DELETE /api/connections/imap/accounts/:id
router.delete("/imap/accounts/:id", requireAuth, (req: AuthRequest, res) => {
  const next = removeImapAccount(req.user!.userId, String(req.params["id"]));
  if (next === null) {
    res.status(404).json({ error: "No IMAP account with that id" });
    return;
  }
  res.json(next.map(sanitizeImap));
});

// GET /api/connections/caldav/accounts
router.get("/caldav/accounts", requireAuth, (req: AuthRequest, res) => {
  res.json(listCalDavAccounts(req.user!.userId).map(sanitizeCalDav));
});

// POST /api/connections/caldav/accounts
router.post("/caldav/accounts", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as {
    label?: string | null;
    url?: string;
    username?: string;
    password?: string;
  };
  if (
    typeof body.url !== "string" || !body.url.trim() ||
    typeof body.username !== "string" || !body.username.trim() ||
    typeof body.password !== "string" || !body.password
  ) {
    res.status(400).json({ error: "url, username and password are required" });
    return;
  }
  try {
    const target = new URL(body.url.trim());
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("Only http:// and https:// URLs are allowed.");
    }
    validateOutboundPort(Number(target.port || (target.protocol === "https:" ? 443 : 80)));
    await resolvePublicHost(target.hostname);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid CalDAV destination" });
    return;
  }
  const accounts = addCalDavAccount(req.user!.userId, {
    label: typeof body.label === "string" ? body.label : null,
    url: body.url,
    username: body.username,
    password: body.password,
  });
  res.json(accounts.map(sanitizeCalDav));
});

// DELETE /api/connections/caldav/accounts/:id
router.delete("/caldav/accounts/:id", requireAuth, (req: AuthRequest, res) => {
  const next = removeCalDavAccount(req.user!.userId, String(req.params["id"]));
  if (next === null) {
    res.status(404).json({ error: "No CalDAV account with that id" });
    return;
  }
  res.json(next.map(sanitizeCalDav));
});

// ── AI chat multi-account management ─────────────────────────────────────────
// Users can save several AI provider accounts (OpenAI, Gemini, Claude), each
// with its own API key and default model. The list lives in the `extra` JSON
// of the caller's "ai" row. API keys never leave the server — every response
// carries only a masked hint (last 4 characters).

function sanitizeAi(a: AiAccount) {
  return {
    id: a.id,
    label: a.label,
    provider: a.provider,
    // Local keyless accounts show an empty hint rather than a fake mask.
    maskedKey: a.apiKey ? maskApiKey(a.apiKey) : "",
    baseUrl: a.baseUrl ?? null,
    model: a.model ?? null,
  };
}

// GET /api/connections/ai/accounts
router.get("/ai/accounts", requireAuth, (req: AuthRequest, res) => {
  res.json(listAiAccounts(req.user!.userId).map(sanitizeAi));
});

// POST /api/connections/ai/accounts
router.post("/ai/accounts", requireAuth, (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as {
    label?: string | null;
    provider?: string;
    apiKey?: string;
    baseUrl?: string | null;
    model?: string | null;
  };
  if (!isAiProvider(body.provider)) {
    res
      .status(400)
      .json({ error: "provider must be one of: openai, gemini, anthropic, ollama, openai_compatible" });
    return;
  }
  // Local providers need a server URL instead of a key; cloud providers need
  // a key.
  if (isLocalAiProvider(body.provider)) {
    if (!body.baseUrl?.trim()) {
      res.status(400).json({ error: "baseUrl (the local server URL) is required for this provider" });
      return;
    }
  } else if (!body.apiKey?.trim()) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }
  const accounts = addAiAccount(req.user!.userId, {
    label: body.label ?? null,
    provider: body.provider,
    apiKey: body.apiKey?.trim() ?? "",
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
    model: typeof body.model === "string" ? body.model : null,
  });
  res.json(accounts.map(sanitizeAi));
});

// PUT /api/connections/ai/accounts/:id — edit label / provider / model, and
// optionally rotate the API key (omitting apiKey keeps the stored key).
router.put("/ai/accounts/:id", requireAuth, (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as {
    label?: string | null;
    provider?: string | null;
    apiKey?: string | null;
    baseUrl?: string | null;
    model?: string | null;
  };
  if (body.provider != null && !isAiProvider(body.provider)) {
    res
      .status(400)
      .json({ error: "provider must be one of: openai, gemini, anthropic, ollama, openai_compatible" });
    return;
  }
  const next = updateAiAccount(req.user!.userId, String(req.params["id"]), {
    label: body.label,
    provider: body.provider != null && isAiProvider(body.provider) ? body.provider : null,
    apiKey: typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : null,
    baseUrl: typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : null,
    model: body.model,
  });
  if (next === null) {
    res.status(404).json({ error: "No AI account with that id" });
    return;
  }
  res.json(next.map(sanitizeAi));
});

// DELETE /api/connections/ai/accounts/:id
router.delete("/ai/accounts/:id", requireAuth, (req: AuthRequest, res) => {
  const next = removeAiAccount(req.user!.userId, String(req.params["id"]));
  if (next === null) {
    res.status(404).json({ error: "No AI account with that id" });
    return;
  }
  res.json(next.map(sanitizeAi));
});

// POST /api/connections/ai/accounts/:id/test — verify the saved key against
// the provider. Always answers 200 with { ok, message } so the card can show
// the outcome inline (matching the service connection test convention).
router.post("/ai/accounts/:id/test", requireAuth, async (req: AuthRequest, res) => {
  const account = listAiAccounts(req.user!.userId).find(
    (a) => a.id === String(req.params["id"]),
  );
  if (!account) {
    res.status(404).json({ error: "No AI account with that id" });
    return;
  }
  try {
    await aiTestKey(account.provider, account);
    res.json({
      ok: true,
      message: isLocalAiProvider(account.provider)
        ? "Local AI server reachable"
        : "API key verified",
    });
  } catch (err) {
    res.json({ ok: false, message: normalizeHttpError(err) });
  }
});

// PUT /api/connections/:service — upsert the caller's own connection for a
// single service
router.put("/:service", requireAuth, (req: AuthRequest, res) => {
  const service = String(req.params["service"]);

  if (!SUPPORTED_SERVICES.includes(service)) {
    res.status(400).json({ error: `Unsupported service: ${service}` });
    return;
  }

  const body = req.body as {
    url?: string;
    apiKey?: string;
    username?: string;
    password?: string;
    token?: string;
  };

  const extra = body.token !== undefined ? JSON.stringify({ token: body.token }) : null;

  connectionStmts.upsert.run(
    req.user!.userId,
    service,
    body.url ?? null,
    body.apiKey ?? null,
    body.username ?? null,
    body.password ?? null,
    extra
  );

  const updated = connectionStmts.findByService.get(req.user!.userId, service)!;
  res.json(formatConnection(updated));
});

// POST /api/connections/:service/test — ping a service using supplied values
router.post("/:service/test", requireAuth, async (req, res) => {
  const service = String(req.params["service"]);

  if (!SUPPORTED_SERVICES.includes(service)) {
    res.status(400).json({ error: `Unsupported service: ${service}` });
    return;
  }

  const body = (req.body ?? {}) as TestValues;

  const result = await runPing(service, body);
  res.json(result);
});

export default router;
