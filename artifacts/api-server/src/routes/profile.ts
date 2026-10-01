import { Router } from "express";
import { ImportProfileBody } from "@workspace/api-zod";
import {
  db,
  pageStmts,
  deviceModeStmts,
  connectionStmts,
  createDefaultServiceConnections,
  defaultDeviceModeId,
  type DbServiceConnection,
} from "../lib/db.js";
import { requireAuth, type AuthRequest } from "../lib/auth.js";
import { createImportedTile, cleanVariant } from "./tiles.js";
import {
  buildExportedPages,
  cleanName,
  applyLayoutUpdate,
} from "./pages.js";
import { createPageNameAllocator, importBudgetError } from "../lib/importBudget.js";
import { validateServiceBaseUrl, isServiceBaseUrlConnection } from "../lib/serviceUrl.js";

const router = Router();

// The full-profile envelope is a distinct file type from the pages-only export
// ("homelab-dashboard-pages") so each importer can give a clear message when it
// receives the other kind of file.
const PROFILE_FORMAT = "tachboard-profile";
const PAGES_FORMAT = "homelab-dashboard-pages";
// Passphrase-encrypted exports are decrypted in the browser before import;
// the server only knows the format name so it can give a clear error if one
// is posted directly (e.g. via curl).
const ENCRYPTED_FORMAT = "tachboard-profile-encrypted";
const PROFILE_VERSION = 1;

// Service keys are free-form strings ("plex", "gmail", "imap", …) but must be
// sane identifiers so an import can never create junk or hostile rows.
const SERVICE_KEY_RE = /^[a-z0-9_-]{1,64}$/i;

// True when a stored connection row actually carries any data worth exporting.
// Blank seeded rows are skipped so the file stays readable.
function isConfiguredRow(row: DbServiceConnection): boolean {
  return Boolean(row.url || row.api_key || row.username || row.password || row.extra);
}

// GET /api/profile/export — the user's entire profile: device modes, pages
// with all per-mode/variant layouts, and (ONLY when explicitly requested via
// ?includeConnections=true) service connection credentials in readable form.
// The client merges browser-side theme data into the downloaded file.
router.get("/export", requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const includeConnections = String(req.query["includeConnections"]) === "true";

  const envelope: Record<string, unknown> = {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    exportedAt: new Date().toISOString(),
    deviceModes: deviceModeStmts.findAllByUser.all(userId).map((m) => ({ name: m.name })),
    pages: buildExportedPages(userId, pageStmts.findAllByUser.all(userId)),
  };
  if (includeConnections) {
    envelope["connections"] = connectionStmts.findAllByUser
      .all(userId)
      .filter(isConfiguredRow)
      .map((row) => ({
        service: row.service,
        url: row.url,
        apiKey: row.api_key,
        username: row.username,
        password: row.password,
        extra: row.extra,
      }));
  }
  res.json(envelope);
});

// POST /api/profile/import — recreate a profile from an exported envelope.
// mode "replace" wipes the user's pages/tiles/device modes (and connections,
// when the file carries them) and recreates everything from the file; mode
// "merge" appends pages/device modes with de-duplicated names and only fills
// connections that aren't already configured. Everything runs in a single
// transaction so a failure leaves the account untouched.
router.post("/import", requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.userId;

  // A pages-only export is a valid file, just for the other flow — say so
  // clearly instead of a generic "invalid file" error.
  const rawFormat = (req.body as { format?: unknown } | null)?.format;
  if (rawFormat === ENCRYPTED_FORMAT) {
    res.status(400).json({
      error:
        "This profile export is passphrase-protected. Import it through the Settings page, which will ask for the passphrase and decrypt it.",
    });
    return;
  }
  if (rawFormat === PAGES_FORMAT) {
    res.status(400).json({
      error:
        "This is a pages export, not a full profile. Import it from the dashboard's page menu instead.",
    });
    return;
  }

  const budgetError = importBudgetError(req.body);
  if (budgetError) {
    res.status(400).json({ error: budgetError });
    return;
  }
  const parsed = ImportProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "This file is not a valid profile export." });
    return;
  }
  const envelope = parsed.data;
  if (envelope.format !== PROFILE_FORMAT) {
    res.status(400).json({ error: "This file is not a valid profile export." });
    return;
  }
  if (envelope.version !== PROFILE_VERSION) {
    res.status(400).json({
      error: `Unsupported profile export version: ${envelope.version}. This file was created by a different version.`,
    });
    return;
  }
  const replace = envelope.mode === "replace";
  if (replace && envelope.pages.length === 0) {
    res.status(400).json({
      error: "This file has no pages, so a replace import would leave the account empty.",
    });
    return;
  }

  // Only well-formed connection entries are considered; the rest are dropped.
  const incomingConnections = (envelope.connections ?? []).filter(
    (c) => typeof c.service === "string" && SERVICE_KEY_RE.test(c.service),
  );
  const fileHasConnections = envelope.connections != null;

  // Validate the entire file before the transaction can delete or write data,
  // including entries a merge would otherwise skip.
  try {
    for (const conn of incomingConnections) {
      if (isServiceBaseUrlConnection(conn.service) && conn.url != null && conn.url !== "") {
        conn.url = validateServiceBaseUrl(conn.url);
      }
    }
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid service URL." });
    return;
  }

  let pagesCreated = 0;
  let tilesCreated = 0;
  let modesCreated = 0;
  let connectionsApplied = 0;

  const importAll = db.transaction(() => {
    if (replace) {
      // Order matters only for readability — tiles cascade from pages anyway.
      db.prepare("DELETE FROM tiles WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM pages WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM device_modes WHERE user_id = ?").run(userId);
    }

    // Device modes are matched by name (case-insensitively). In replace mode
    // the table is empty, so the file's modes are recreated in order; in merge
    // mode existing modes are reused and only unknown names get created.
    const modesByName = new Map(
      deviceModeStmts.findAllByUser.all(userId).map((m) => [m.name.toLowerCase(), m.id]),
    );
    const resolveModeId = (rawName: unknown): number => {
      const name =
        typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 40) : "Default";
      const existing = modesByName.get(name.toLowerCase());
      if (existing != null) return existing;
      const maxModePos = deviceModeStmts.maxPosition.get(userId)?.maxPos ?? -1;
      const row = deviceModeStmts.create.get(userId, name, maxModePos + 1)!;
      modesByName.set(name.toLowerCase(), row.id);
      modesCreated++;
      return row.id;
    };
    for (const mode of envelope.deviceModes) {
      resolveModeId(mode.name);
    }

    const allocateName = createPageNameAllocator(pageStmts.findAllByUser.all(userId).map((p) => p.name));
    let position = (pageStmts.maxPosition.get(userId)!.maxPos ?? -1) + 1;
    for (const incoming of envelope.pages) {
      const name = allocateName(cleanName(incoming.name));
      const pageRow = pageStmts.create.get(userId, name, position)!;
      applyLayoutUpdate(userId, pageRow.id, incoming);
      position++;
      pagesCreated++;
      const layouts = (
        incoming as {
          layouts?: Array<{ deviceMode?: string; variant?: string | null; tiles?: unknown[] }>;
        }
      ).layouts;
      if (Array.isArray(layouts) && layouts.length > 0) {
        for (const layout of layouts) {
          const modeId = resolveModeId(layout.deviceMode);
          const variant = cleanVariant(layout.variant);
          for (const tile of layout.tiles ?? []) {
            createImportedTile(userId, pageRow.id, tile, modeId, variant);
            tilesCreated++;
          }
        }
      } else {
        const modeId = defaultDeviceModeId(userId);
        for (const tile of incoming.tiles) {
          createImportedTile(userId, pageRow.id, tile, modeId, null);
          tilesCreated++;
        }
      }
    }

    // Replace mode must never leave the account without a page or device mode
    // to land on. Pages are guaranteed above; modes are created on demand.
    defaultDeviceModeId(userId);

    if (fileHasConnections) {
      if (replace) {
        // Wipe every stored credential, re-seed the blank defaults the
        // settings page expects, then apply the file's connections.
        db.prepare("DELETE FROM service_connections WHERE user_id = ?").run(userId);
        createDefaultServiceConnections(userId);
      }
      for (const conn of incomingConnections) {
        if (!replace) {
          // Merge mode never clobbers credentials the user already has.
          const existing = connectionStmts.findByService.get(userId, conn.service);
          if (existing && isConfiguredRow(existing)) continue;
        }
        connectionStmts.upsert.run(
          userId,
          conn.service,
          conn.url ?? null,
          conn.apiKey ?? null,
          conn.username ?? null,
          conn.password ?? null,
          conn.extra ?? null,
        );
        connectionsApplied++;
      }
    }
  });
  importAll();

  res.json({
    mode: envelope.mode,
    pages: pagesCreated,
    tiles: tilesCreated,
    deviceModes: modesCreated,
    connections: connectionsApplied,
  });
});

export default router;
