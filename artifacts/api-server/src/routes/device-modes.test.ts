import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

// Use a throwaway data dir so the real SQLite DB is created fresh and isolated.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-modes-"));
process.env["DATA_DIR"] = tmpDir;

// Auth is replaced with a pass-through that injects the user from an x-user-id
// header (default 1) so routes run without a real JWT.
vi.mock("../lib/auth.js", () => ({
  requireAuth: (
    req: { user?: { userId: number }; headers: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { userId: parseInt(String(req.headers["x-user-id"] ?? "1")) };
    next();
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// Imported after mocks (and after DATA_DIR is set) so the DB binds to tmpDir.
const { db, createDefaultDeviceMode, createDefaultPage } = await import("../lib/db.js");
const { default: tilesRouter } = await import("./tiles.js");
const { default: layoutRouter } = await import("./layout.js");
const { default: pagesRouter } = await import("./pages.js");
const { default: deviceModesRouter } = await import("./device-modes.js");

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/tiles/layout", layoutRouter);
  app.use("/tiles", tilesRouter);
  app.use("/pages", pagesRouter);
  app.use("/device-modes", deviceModesRouter);
  return app;
}

const app = makeApp();

let pageId: number;
let defaultModeId: number;

beforeAll(() => {
  db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'tester', 'x')").run();
  db.prepare("INSERT INTO users (id, username, password) VALUES (2, 'other', 'x')").run();
  pageId = createDefaultPage(1);
  defaultModeId = createDefaultDeviceMode(1);
  createDefaultPage(2);
  createDefaultDeviceMode(2);
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createTile(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/tiles")
    .set("x-user-id", "1")
    .send({
      type: "app",
      name: "T",
      gridX: 0,
      gridY: 0,
      gridW: 2,
      gridH: 2,
      pageId,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body as { id: number; deviceModeId: number; variant: string | null };
}

describe("device modes CRUD", () => {
  it("lists the default mode", async () => {
    const res = await request(app).get("/device-modes").set("x-user-id", "1");
    expect(res.status).toBe(200);
    expect(res.body.map((m: { id: number }) => m.id)).toContain(defaultModeId);
  });

  it("creates, renames and deletes a mode", async () => {
    const created = await request(app)
      .post("/device-modes")
      .set("x-user-id", "1")
      .send({ name: "Phone" });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Phone");

    const renamed = await request(app)
      .put(`/device-modes/${created.body.id}`)
      .set("x-user-id", "1")
      .send({ name: "Tablet" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Tablet");

    const deleted = await request(app)
      .delete(`/device-modes/${created.body.id}`)
      .set("x-user-id", "1");
    expect(deleted.status).toBe(200);
  });

  it("rejects empty names and refuses to delete the last mode", async () => {
    const bad = await request(app)
      .post("/device-modes")
      .set("x-user-id", "1")
      .send({ name: "  " });
    expect(bad.status).toBe(400);

    const res = await request(app)
      .delete(`/device-modes/${defaultModeId}`)
      .set("x-user-id", "1");
    expect(res.status).toBe(400);
  });

  it("does not expose another user's modes", async () => {
    const res = await request(app)
      .put(`/device-modes/${defaultModeId}`)
      .set("x-user-id", "2")
      .send({ name: "Hijack" });
    expect(res.status).toBe(404);
  });

  it("deleting a mode deletes its tiles", async () => {
    const created = await request(app)
      .post("/device-modes")
      .set("x-user-id", "1")
      .send({ name: "Doomed" });
    const modeId = created.body.id as number;
    const tile = await createTile({ deviceModeId: modeId });
    await request(app).delete(`/device-modes/${modeId}`).set("x-user-id", "1").expect(200);
    const gone = await request(app).get(`/tiles/${tile.id}`).set("x-user-id", "1");
    expect(gone.status).toBe(404);
  });
});

describe("tile scoping by device mode and variant", () => {
  it("creates tiles in the default mode when none is given", async () => {
    const tile = await createTile();
    expect(tile.deviceModeId).toBe(defaultModeId);
    expect(tile.variant).toBeNull();
  });

  it("scopes GET /tiles by deviceModeId and variant", async () => {
    const created = await request(app)
      .post("/device-modes")
      .set("x-user-id", "1")
      .send({ name: "PC" });
    const pcModeId = created.body.id as number;
    const base = await createTile({ deviceModeId: pcModeId, name: "base" });
    const fhd = await createTile({ deviceModeId: pcModeId, variant: "fhd-landscape", name: "fhd" });

    const baseList = await request(app)
      .get(`/tiles?pageId=${pageId}&deviceModeId=${pcModeId}`)
      .set("x-user-id", "1");
    expect(baseList.status).toBe(200);
    expect(baseList.body.map((t: { id: number }) => t.id)).toEqual([base.id]);

    const fhdList = await request(app)
      .get(`/tiles?pageId=${pageId}&deviceModeId=${pcModeId}&variant=fhd-landscape`)
      .set("x-user-id", "1");
    expect(fhdList.body.map((t: { id: number }) => t.id)).toEqual([fhd.id]);
    expect(fhdList.body[0].variant).toBe("fhd-landscape");

    // Unscoped page query still returns everything (legacy behavior).
    const all = await request(app).get(`/tiles?pageId=${pageId}`).set("x-user-id", "1");
    const ids = all.body.map((t: { id: number }) => t.id);
    expect(ids).toContain(base.id);
    expect(ids).toContain(fhd.id);
  });

  it("404s for a foreign deviceModeId", async () => {
    const res = await request(app)
      .get(`/tiles?pageId=${pageId}&deviceModeId=999`)
      .set("x-user-id", "1");
    expect(res.status).toBe(404);
  });

  it("layout save scoped by mode+variant returns only that scope with full shape", async () => {
    const created = await request(app)
      .post("/device-modes")
      .set("x-user-id", "1")
      .send({ name: "ScopeSave" });
    const modeId = created.body.id as number;
    const t1 = await createTile({ deviceModeId: modeId, variant: "qhd-portrait", integration: "clock" });
    await createTile({ deviceModeId: modeId });

    const saved = await request(app)
      .put("/tiles/layout")
      .set("x-user-id", "1")
      .send({
        pageId,
        deviceModeId: modeId,
        variant: "qhd-portrait",
        tiles: [{ id: t1.id, gridX: 3, gridY: 4, gridW: 5, gridH: 6 }],
      });
    expect(saved.status).toBe(200);
    expect(saved.body).toHaveLength(1);
    expect(saved.body[0].id).toBe(t1.id);
    expect(saved.body[0].gridX).toBe(3);
    expect(saved.body[0].integration).toBe("clock");
    // Legacy portrait variants are aliased onto the simplified vertical tiers:
    // "qhd-portrait" (and "compact-portrait") canonicalize to "fhd-portrait".
    expect(saved.body[0].variant).toBe("fhd-portrait");
  });

  it("aliases legacy portrait variants to the simplified tiers on read and write", async () => {
    const created = await request(app)
      .post("/device-modes")
      .set("x-user-id", "1")
      .send({ name: "PortraitAlias" });
    const modeId = created.body.id as number;

    // Writing a tile under a legacy portrait key stores the canonical tier.
    const legacy = await createTile({
      deviceModeId: modeId,
      variant: "compact-portrait",
      name: "legacy",
    });
    expect(legacy.variant).toBe("fhd-portrait");

    // Reading via either the legacy or the canonical key finds the same scope.
    for (const v of ["compact-portrait", "qhd-portrait", "fhd-portrait"]) {
      const list = await request(app)
        .get(`/tiles?pageId=${pageId}&deviceModeId=${modeId}&variant=${v}`)
        .set("x-user-id", "1");
      expect(list.status).toBe(200);
      expect(list.body.map((t: { id: number }) => t.id)).toEqual([legacy.id]);
    }

    // The 4K vertical tier is its own scope, untouched by the aliasing.
    const uhd = await request(app)
      .get(`/tiles?pageId=${pageId}&deviceModeId=${modeId}&variant=uhd-portrait`)
      .set("x-user-id", "1");
    expect(uhd.body).toHaveLength(0);
  });
});

describe("page layouts + copy-layout", () => {
  it("lists layout scopes and copies into an empty scope only", async () => {
    const pageRes = await request(app)
      .post("/pages")
      .set("x-user-id", "1")
      .send({ name: "CopyPage", layoutPreset: "adaptive" });
    expect(pageRes.status).toBe(201);
    expect(pageRes.body.layoutPreset).toBe("adaptive");
    const copyPageId = pageRes.body.id as number;

    await createTile({ pageId: copyPageId, variant: "fhd-landscape", name: "A", tileSettings: { openExpanded: true } });
    await createTile({ pageId: copyPageId, variant: "fhd-landscape", name: "B" });

    const layouts = await request(app)
      .get(`/pages/${copyPageId}/layouts`)
      .set("x-user-id", "1");
    expect(layouts.status).toBe(200);
    expect(layouts.body).toEqual([
      { deviceModeId: defaultModeId, variant: "fhd-landscape", tileCount: 2 },
    ]);

    const copied = await request(app)
      .post(`/pages/${copyPageId}/copy-layout`)
      .set("x-user-id", "1")
      .send({
        fromDeviceModeId: defaultModeId,
        fromVariant: "fhd-landscape",
        toDeviceModeId: defaultModeId,
        toVariant: "compact-portrait",
      });
    expect(copied.status).toBe(201);
    expect(copied.body.copied).toBe(2);

    const target = await request(app)
      .get(`/tiles?pageId=${copyPageId}&deviceModeId=${defaultModeId}&variant=compact-portrait`)
      .set("x-user-id", "1");
    expect(target.body).toHaveLength(2);
    expect(target.body.find((tile: { name: string }) => tile.name === "A").tileSettings.openExpanded).toBe(true);

    // Copying again into the now-populated target must fail.
    const again = await request(app)
      .post(`/pages/${copyPageId}/copy-layout`)
      .set("x-user-id", "1")
      .send({
        fromDeviceModeId: defaultModeId,
        fromVariant: "fhd-landscape",
        toDeviceModeId: defaultModeId,
        toVariant: "compact-portrait",
      });
    expect(again.status).toBe(400);

    // With replace:true the populated target is wiped and re-seeded.
    await createTile({ pageId: copyPageId, variant: "fhd-landscape", name: "C" });
    const replaced = await request(app)
      .post(`/pages/${copyPageId}/copy-layout`)
      .set("x-user-id", "1")
      .send({
        fromDeviceModeId: defaultModeId,
        fromVariant: "fhd-landscape",
        toDeviceModeId: defaultModeId,
        toVariant: "compact-portrait",
        replace: true,
      });
    expect(replaced.status).toBe(201);
    expect(replaced.body.copied).toBe(3);
    const replacedTarget = await request(app)
      .get(`/tiles?pageId=${copyPageId}&deviceModeId=${defaultModeId}&variant=compact-portrait`)
      .set("x-user-id", "1");
    expect(replacedTarget.body).toHaveLength(3);
    // Source scope is untouched.
    const sourceScope = await request(app)
      .get(`/tiles?pageId=${copyPageId}&deviceModeId=${defaultModeId}&variant=fhd-landscape`)
      .set("x-user-id", "1");
    expect(sourceScope.body).toHaveLength(3);

    // Source == target is rejected.
    const same = await request(app)
      .post(`/pages/${copyPageId}/copy-layout`)
      .set("x-user-id", "1")
      .send({
        fromDeviceModeId: defaultModeId,
        fromVariant: "fhd-landscape",
        toDeviceModeId: defaultModeId,
        toVariant: "fhd-landscape",
      });
    expect(same.status).toBe(400);
  });
});

describe("export v2 / import v1+v2 round-trip", () => {
  it("exports layouts per (mode, variant) and re-imports them by mode name", async () => {
    const modeRes = await request(app)
      .post("/device-modes")
      .set("x-user-id", "1")
      .send({ name: "Kiosk" });
    const kioskId = modeRes.body.id as number;

    const pageRes = await request(app)
      .post("/pages")
      .set("x-user-id", "1")
      .send({ name: "RT" });
    const rtPageId = pageRes.body.id as number;
    await createTile({ pageId: rtPageId, deviceModeId: kioskId, name: "K1" });
    await createTile({ pageId: rtPageId, deviceModeId: kioskId, variant: "uhd-landscape", name: "K2" });

    const exported = await request(app)
      .get(`/pages/${rtPageId}/export`)
      .set("x-user-id", "1");
    expect(exported.status).toBe(200);
    expect(exported.body.version).toBe(2);
    const layouts = exported.body.pages[0].layouts as Array<{
      deviceMode: string;
      variant: string | null;
      tiles: unknown[];
    }>;
    expect(layouts).toHaveLength(2);
    expect(layouts.every((l) => l.deviceMode === "Kiosk")).toBe(true);

    // Import into user 2 — the "Kiosk" mode does not exist there and must be
    // created, with variants preserved.
    const imported = await request(app)
      .post("/pages/import")
      .set("x-user-id", "2")
      .send(exported.body);
    expect(imported.status).toBe(201);
    const newPageId = imported.body[0].id as number;

    const modes2 = await request(app).get("/device-modes").set("x-user-id", "2");
    const kiosk2 = modes2.body.find((m: { name: string }) => m.name === "Kiosk");
    expect(kiosk2).toBeTruthy();

    const baseTiles = await request(app)
      .get(`/tiles?pageId=${newPageId}&deviceModeId=${kiosk2.id}`)
      .set("x-user-id", "2");
    expect(baseTiles.body).toHaveLength(1);
    expect(baseTiles.body[0].name).toBe("K1");
    const uhdTiles = await request(app)
      .get(`/tiles?pageId=${newPageId}&deviceModeId=${kiosk2.id}&variant=uhd-landscape`)
      .set("x-user-id", "2");
    expect(uhdTiles.body).toHaveLength(1);
    expect(uhdTiles.body[0].name).toBe("K2");
  });

  it("imports a v1 file into the default mode's base layout", async () => {
    const v1 = {
      format: "homelab-dashboard-pages",
      version: 1,
      pages: [
        {
          name: "Legacy",
          tiles: [
            { type: "app", name: "Old", gridX: 0, gridY: 0, gridW: 2, gridH: 2 },
          ],
        },
      ],
    };
    const imported = await request(app)
      .post("/pages/import")
      .set("x-user-id", "1")
      .send(v1);
    expect(imported.status).toBe(201);
    const newPageId = imported.body[0].id as number;
    const tiles = await request(app)
      .get(`/tiles?pageId=${newPageId}&deviceModeId=${defaultModeId}`)
      .set("x-user-id", "1");
    expect(tiles.body).toHaveLength(1);
    expect(tiles.body[0].name).toBe("Old");
    expect(tiles.body[0].variant).toBeNull();
  });
});
