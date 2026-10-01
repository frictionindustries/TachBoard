import { Router } from "express";
import { ImportPagesBody } from "@workspace/api-zod";
import {
  db,
  pageStmts,
  tileStmts,
  deviceModeStmts,
  defaultDeviceModeId,
  type DbPage,
} from "../lib/db.js";
import { requireAuth, type AuthRequest } from "../lib/auth.js";
import { exportTile, createImportedTile, cleanVariant } from "./tiles.js";
import { createPageNameAllocator, importBudgetError } from "../lib/importBudget.js";

const router = Router();

// The export envelope is versioned so future format changes can be detected
// and rejected on import. Bump EXPORT_VERSION whenever the shape changes in a
// way older importers can't read.
const EXPORT_FORMAT = "homelab-dashboard-pages";
const EXPORT_VERSION = 2;

// Build a shareable export envelope for the given pages. Each page carries its
// name and an ordered list of tiles (via exportTile, which strips ids and owner
// fields). No credential data lives on pages or tiles, so the envelope is safe
// to share.
//
// v2 adds `layouts`: every (device mode, variant) grouping of the page's tiles
// with the mode referenced by NAME (ids don't survive a round-trip between
// accounts). `tiles` still carries the flat list so a v2 file remains readable
// by eye; importers use `layouts` when present.
function buildExport(userId: number, pages: DbPage[]) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    pages: buildExportedPages(userId, pages),
  };
}

// Serialize pages (with their per-mode/variant layouts) into the shareable
// export shape. Shared between the pages export and the full-profile export.
export function buildExportedPages(userId: number, pages: DbPage[]) {
  const modes = deviceModeStmts.findAllByUser.all(userId);
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  return pages.map((p) => {
      const tiles = tileStmts.findAllByPage.all(p.user_id, p.id);
      const groups = new Map<string, { deviceMode: string; variant: string | null; tiles: ReturnType<typeof exportTile>[] }>();
      for (const t of tiles) {
        const name = (t.device_mode_id != null && modeName.get(t.device_mode_id)) || "Default";
        const key = `${name}\u0000${t.variant ?? ""}`;
        let group = groups.get(key);
        if (!group) {
          group = { deviceMode: name, variant: t.variant ?? null, tiles: [] };
          groups.set(key, group);
        }
        group.tiles.push(exportTile(t));
      }
      return {
        name: p.name,
        layoutPreset: p.layout_preset ?? "auto",
        layoutOrientation: p.layout_orientation ?? "landscape",
        tiles: tiles.map(exportTile),
        layouts: Array.from(groups.values()),
      };
  });
}

export function formatPage(p: DbPage) {
  return {
    id: p.id,
    userId: p.user_id,
    name: p.name,
    position: p.position,
    // Surface a stable default for legacy rows that predate the scale-lock
    // columns, so the client never has to special-case null.
    layoutPreset: p.layout_preset ?? "auto",
    layoutOrientation: p.layout_orientation ?? "landscape",
    createdAt: p.created_at,
  };
}

// Clean an incoming page name: trim, fall back to a default, and cap length so
// a stray paste can't blow up the tab bar.
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "Page";
  const trimmed = raw.trim();
  if (!trimmed) return "Page";
  return trimmed.slice(0, 60);
}

// The valid scale presets and orientations. Anything outside these sets is
// ignored (treated as "not provided") so a bad value can never be stored.
const LAYOUT_PRESETS = new Set(["auto", "adaptive", "compact", "fhd", "qhd", "uhd"]);
const LAYOUT_ORIENTATIONS = new Set(["landscape", "portrait"]);

// Normalize an incoming preset/orientation. Returns the validated string, or
// null when the value is absent or not one of the allowed options.
function cleanPreset(raw: unknown): string | null {
  return typeof raw === "string" && LAYOUT_PRESETS.has(raw) ? raw : null;
}
function cleanOrientation(raw: unknown): string | null {
  return typeof raw === "string" && LAYOUT_ORIENTATIONS.has(raw) ? raw : null;
}

// Persist the layout fields for a page only when the request actually carries a
// valid value for at least one of them. Unspecified fields keep their current
// stored value so a partial update (e.g. orientation only) never clobbers the
// other. Reads the existing row to fill in the side that wasn't provided.
export function applyLayoutUpdate(
  userId: number,
  pageId: number,
  body: { layoutPreset?: unknown; layoutOrientation?: unknown },
): void {
  const preset = cleanPreset(body.layoutPreset);
  const orientation = cleanOrientation(body.layoutOrientation);
  if (preset === null && orientation === null) return;
  const existing = pageStmts.findById.get(pageId, userId);
  if (!existing) return;
  pageStmts.updateLayout.run(
    preset ?? existing.layout_preset,
    orientation ?? existing.layout_orientation,
    pageId,
    userId,
  );
}

// GET /api/pages — list the user's pages in display order.
router.get("/", requireAuth, (req: AuthRequest, res) => {
  const pages = pageStmts.findAllByUser.all(req.user!.userId);
  res.json(pages.map(formatPage));
});

// POST /api/pages — create a new (empty) page, appended after the last one.
router.post("/", requireAuth, (req: AuthRequest, res) => {
  const body = req.body as { name?: string; layoutPreset?: unknown; layoutOrientation?: unknown };
  const { maxPos } = pageStmts.maxPosition.get(req.user!.userId)!;
  const position = (maxPos ?? -1) + 1;
  const row = pageStmts.create.get(req.user!.userId, cleanName(body.name), position)!;
  applyLayoutUpdate(req.user!.userId, row.id, body);
  const page = pageStmts.findById.get(row.id, req.user!.userId)!;
  res.status(201).json(formatPage(page));
});

// GET /api/pages/export — export ALL of the user's pages as a downloadable
// envelope. Registered before /:id so the literal "export" path is not captured
// by the id param.
router.get("/export", requireAuth, (req: AuthRequest, res) => {
  const pages = pageStmts.findAllByUser.all(req.user!.userId);
  res.json(buildExport(req.user!.userId, pages));
});

// GET /api/pages/:id/export — export a single page as a downloadable envelope.
router.get("/:id/export", requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(String(req.params["id"]));
  const page = pageStmts.findById.get(id, req.user!.userId);
  if (!page) {
    res.status(404).json({ error: "Page not found" });
    return;
  }
  res.json(buildExport(req.user!.userId, [page]));
});

// POST /api/pages/import — recreate one or more pages from a previously
// exported envelope. Validates the format/version, then creates every page and
// its tiles inside a single transaction so a failure leaves nothing partial.
// Imported pages are appended after existing ones and given collision-free
// names. Registered before /:id so the literal "import" path is not captured by
// the id param.
router.post("/import", requireAuth, (req: AuthRequest, res) => {
  const budgetError = importBudgetError(req.body);
  if (budgetError) {
    res.status(400).json({ error: budgetError });
    return;
  }
  // Validate the entire payload against the generated schema first. This
  // rejects malformed files (wrong types, null/garbage page or tile entries,
  // missing required fields) with a clean 400 before anything is created, and
  // unknown/credential-like fields are dropped during parse.
  const parsed = ImportPagesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "This file is not a valid dashboard page export." });
    return;
  }
  const envelope = parsed.data;

  if (envelope.format !== EXPORT_FORMAT) {
    res.status(400).json({ error: "This file is not a valid dashboard page export." });
    return;
  }
  // v1 files carry only a flat `tiles` list (pre device modes); v2 files add
  // per-(deviceMode, variant) `layouts`. Both are accepted.
  if (envelope.version !== 1 && envelope.version !== EXPORT_VERSION) {
    res.status(400).json({
      error: `Unsupported export version: ${envelope.version}. This file was created by a different version.`,
    });
    return;
  }

  const allocateName = createPageNameAllocator(
    pageStmts.findAllByUser.all(req.user!.userId).map((p) => p.name),
  );
  const { maxPos } = pageStmts.maxPosition.get(req.user!.userId)!;

  // Device modes referenced by NAME in v2 files are matched to the importer's
  // existing modes case-insensitively; unknown names get created on the fly.
  const modesByName = new Map(
    deviceModeStmts.findAllByUser
      .all(req.user!.userId)
      .map((m) => [m.name.toLowerCase(), m.id]),
  );
  const resolveModeId = (rawName: unknown): number => {
    const name =
      typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 40) : "Default";
    const existing = modesByName.get(name.toLowerCase());
    if (existing != null) return existing;
    const maxModePos = deviceModeStmts.maxPosition.get(req.user!.userId)?.maxPos ?? -1;
    const row = deviceModeStmts.create.get(req.user!.userId, name, maxModePos + 1)!;
    modesByName.set(name.toLowerCase(), row.id);
    return row.id;
  };

  const createdIds: number[] = [];
  const importAll = db.transaction(() => {
    let position = (maxPos ?? -1) + 1;
    for (const incoming of envelope.pages) {
      const name = allocateName(cleanName(incoming.name));
      const pageRow = pageStmts.create.get(req.user!.userId, name, position)!;
      applyLayoutUpdate(req.user!.userId, pageRow.id, incoming);
      position++;
      createdIds.push(pageRow.id);
      const layouts = (incoming as { layouts?: Array<{ deviceMode?: string; variant?: string | null; tiles: unknown[] }> }).layouts;
      if (Array.isArray(layouts) && layouts.length > 0) {
        for (const layout of layouts) {
          const modeId = resolveModeId(layout.deviceMode);
          const variant = cleanVariant(layout.variant);
          for (const tile of layout.tiles ?? []) {
            createImportedTile(req.user!.userId, pageRow.id, tile, modeId, variant);
          }
        }
      } else {
        // v1 (or a v2 file without layouts): everything lands in the
        // importer's default mode as the base layout.
        const modeId = defaultDeviceModeId(req.user!.userId);
        for (const tile of incoming.tiles) {
          createImportedTile(req.user!.userId, pageRow.id, tile, modeId, null);
        }
      }
    }
  });
  importAll();

  const created = createdIds.map((id) => pageStmts.findById.get(id, req.user!.userId)!);
  res.status(201).json(created.map(formatPage));
});

// GET /api/pages/:id/layouts — list every non-empty (device mode, variant)
// layout scope on a page with its tile count. Feeds the "copy layout from…"
// picker for empty variants/modes.
router.get("/:id/layouts", requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(String(req.params["id"]));
  const page = Number.isNaN(id) ? undefined : pageStmts.findById.get(id, req.user!.userId);
  if (!page) {
    res.status(404).json({ error: "Page not found" });
    return;
  }
  const rows = db
    .prepare<[number, number], { device_mode_id: number | null; variant: string | null; count: number }>(
      `SELECT device_mode_id, variant, COUNT(*) AS count
       FROM tiles WHERE user_id = ? AND page_id = ?
       GROUP BY device_mode_id, variant`
    )
    .all(req.user!.userId, page.id);
  res.json(
    rows.map((r) => ({
      deviceModeId: r.device_mode_id,
      variant: r.variant,
      tileCount: r.count,
    })),
  );
});

// POST /api/pages/:id/copy-layout — duplicate every tile from one
// (deviceModeId, variant) scope of a page into another scope on the same page.
// Used to seed an empty variant or a new device mode from an existing layout.
// By default the target scope must be empty so a copy can never silently
// merge/overwrite; passing replace:true (after an explicit client-side
// confirmation) deletes the target scope's tiles and replaces them.
router.post("/:id/copy-layout", requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(String(req.params["id"]));
  const page = Number.isNaN(id) ? undefined : pageStmts.findById.get(id, req.user!.userId);
  if (!page) {
    res.status(404).json({ error: "Page not found" });
    return;
  }
  const body = req.body as {
    fromDeviceModeId?: number;
    fromVariant?: string | null;
    toDeviceModeId?: number;
    toVariant?: string | null;
    replace?: boolean;
  };
  const fromMode =
    body.fromDeviceModeId != null
      ? deviceModeStmts.findById.get(body.fromDeviceModeId, req.user!.userId)
      : undefined;
  const toMode =
    body.toDeviceModeId != null
      ? deviceModeStmts.findById.get(body.toDeviceModeId, req.user!.userId)
      : undefined;
  if (!fromMode || !toMode) {
    res.status(404).json({ error: "Device mode not found" });
    return;
  }
  const fromVariant = cleanVariant(body.fromVariant);
  const toVariant = cleanVariant(body.toVariant);
  if (fromMode.id === toMode.id && fromVariant === toVariant) {
    res.status(400).json({ error: "Source and target layouts are the same" });
    return;
  }
  const source = tileStmts.findAllByPageScope.all(
    req.user!.userId,
    page.id,
    fromMode.id,
    fromVariant,
  );
  const existing = tileStmts.findAllByPageScope.all(
    req.user!.userId,
    page.id,
    toMode.id,
    toVariant,
  );
  if (existing.length > 0 && body.replace !== true) {
    res.status(400).json({ error: "Target layout already has tiles" });
    return;
  }
  const copyAll = db.transaction(() => {
    if (existing.length > 0) {
      tileStmts.deleteByPageScope.run(req.user!.userId, page.id, toMode.id, toVariant);
    }
    for (const tile of source) {
      createImportedTile(req.user!.userId, page.id, exportTile(tile), toMode.id, toVariant);
    }
  });
  copyAll();
  const copied = tileStmts.findAllByPageScope.all(
    req.user!.userId,
    page.id,
    toMode.id,
    toVariant,
  );
  res.status(201).json({ copied: copied.length });
});

// PUT /api/pages/reorder — persist a new page order. Body: { order: number[] }
// listing the page ids in the desired sequence. Only ids that belong to the
// user are repositioned; unknown ids are ignored. Registered before /:id so the
// literal "reorder" path is not captured by the id param.
router.put("/reorder", requireAuth, (req: AuthRequest, res) => {
  const body = req.body as { order?: unknown };
  if (!Array.isArray(body.order)) {
    res.status(400).json({ error: "order must be an array of page ids" });
    return;
  }
  const ids = body.order.filter((x): x is number => typeof x === "number");
  const owned = new Set(
    pageStmts.findAllByUser.all(req.user!.userId).map((p) => p.id),
  );

  const applyOrder = db.transaction(() => {
    let position = 0;
    for (const id of ids) {
      if (!owned.has(id)) continue;
      pageStmts.updatePosition.run(position, id, req.user!.userId);
      position++;
    }
  });
  applyOrder();

  const pages = pageStmts.findAllByUser.all(req.user!.userId);
  res.json(pages.map(formatPage));
});

// PUT /api/pages/:id — rename a page.
router.put("/:id", requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(String(req.params["id"]));
  const existing = pageStmts.findById.get(id, req.user!.userId);
  if (!existing) {
    res.status(404).json({ error: "Page not found" });
    return;
  }
  const body = req.body as { name?: string; layoutPreset?: unknown; layoutOrientation?: unknown };
  if (body.name !== undefined) {
    pageStmts.rename.run(cleanName(body.name), id, req.user!.userId);
  }
  applyLayoutUpdate(req.user!.userId, id, body);
  const page = pageStmts.findById.get(id, req.user!.userId)!;
  res.json(formatPage(page));
});

// DELETE /api/pages/:id — delete a page and (via ON DELETE CASCADE) its tiles.
// Refuses to delete the user's last remaining page.
router.delete("/:id", requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(String(req.params["id"]));
  const existing = pageStmts.findById.get(id, req.user!.userId);
  if (!existing) {
    res.status(404).json({ error: "Page not found" });
    return;
  }
  const { count } = pageStmts.countByUser.get(req.user!.userId)!;
  if (count <= 1) {
    res.status(400).json({ error: "Cannot delete your last page" });
    return;
  }
  pageStmts.delete.run(id, req.user!.userId);
  res.status(204).send();
});

export default router;
