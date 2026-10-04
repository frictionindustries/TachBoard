import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

// Use a throwaway data dir so the real SQLite DB is created fresh and isolated.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pages-export-"));
process.env["DATA_DIR"] = tmpDir;

// Auth is replaced with a pass-through that reads the user id from a header so a
// single test app can act as different users (default user 1).
vi.mock("../lib/auth.js", () => ({
  requireAuth: (
    req: { user?: { userId: number }; headers: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    const header = req.headers["x-user-id"];
    req.user = { userId: header ? Number(header) : 1 };
    next();
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// Imported after mocks (and after DATA_DIR is set) so the DB binds to tmpDir.
const { db } = await import("../lib/db.js");
const { default: pagesRouter } = await import("./pages.js");
const { default: tilesRouter } = await import("./tiles.js");

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/pages", pagesRouter);
  app.use("/tiles", tilesRouter);
  return app;
}

const app = makeApp();

beforeAll(() => {
  // Tiles/pages foreign keys require real user rows.
  db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'tester', 'x')").run();
  db.prepare("INSERT INTO users (id, username, password) VALUES (2, 'other', 'x')").run();
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Create a page for the given user and return its id.
async function createPage(userId: number, name: string): Promise<number> {
  const res = await request(app)
    .post("/pages")
    .set("x-user-id", String(userId))
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe("page export/import", () => {
  it("round-trips a page's tiles, layout, and settings", async () => {
    const pageId = await createPage(1, "Media");

    // A widget tile with metrics + settings.
    const widget = await request(app)
      .post("/tiles")
      .set("x-user-id", "1")
      .send({
        pageId,
        type: "app",
        integration: "qbittorrent",
        gridX: 2,
        gridY: 4,
        gridW: 6,
        gridH: 8,
        name: "Torrents",
        hideTitle: true,
        metrics: ["downloading", "seeding"],
        tileSettings: { categoryFilter: ["movies"], groupByCategory: true, openExpanded: true },
      });
    expect(widget.status).toBe(201);

    // A plain app/link tile with styling.
    const link = await request(app)
      .post("/tiles")
      .set("x-user-id", "1")
      .send({
        pageId,
        type: "app",
        gridX: 0,
        gridY: 0,
        gridW: 4,
        gridH: 4,
        name: "Router",
        url: "https://router.local",
        bgColor: "#112233",
        titleSize: "lg",
        titleColor: "#ffffff",
      });
    expect(link.status).toBe(201);

    // Export the page.
    const exported = await request(app)
      .get(`/pages/${pageId}/export`)
      .set("x-user-id", "1");
    expect(exported.status).toBe(200);
    expect(exported.body.format).toBe("homelab-dashboard-pages");
    expect(exported.body.version).toBe(2);
    expect(exported.body.pages).toHaveLength(1);
    expect(exported.body.pages[0].name).toBe("Media");
    expect(exported.body.pages[0].tiles).toHaveLength(2);

    // Import it back for the same user — creates a new, collision-free page.
    const imported = await request(app)
      .post("/pages/import")
      .set("x-user-id", "1")
      .send(exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body).toHaveLength(1);
    expect(imported.body[0].name).toBe("Media (2)");
    const newPageId = imported.body[0].id as number;
    expect(newPageId).not.toBe(pageId);

    // The new page reproduces both tiles with their fields intact.
    const tilesRes = await request(app)
      .get(`/tiles?pageId=${newPageId}`)
      .set("x-user-id", "1");
    expect(tilesRes.status).toBe(200);
    expect(tilesRes.body).toHaveLength(2);

    const torrents = tilesRes.body.find((t: { name: string }) => t.name === "Torrents");
    expect(torrents).toMatchObject({
      integration: "qbittorrent",
      gridX: 2,
      gridY: 4,
      gridW: 6,
      gridH: 8,
      hideTitle: true,
      metrics: ["downloading", "seeding"],
      tileSettings: { categoryFilter: ["movies"], groupByCategory: true, openExpanded: true },
    });
    // Identity fields belong to the new page/user, not the originals.
    expect(torrents.pageId).toBe(newPageId);

    const router = tilesRes.body.find((t: { name: string }) => t.name === "Router");
    expect(router).toMatchObject({
      url: "https://router.local",
      bgColor: "#112233",
      titleSize: "lg",
      titleColor: "#ffffff",
    });
  });

  it("round-trips a page's fixed-scale layout settings", async () => {
    const pageId = await createPage(1, "Wallboard");

    // Switch the page to a fixed QHD / portrait layout.
    const updated = await request(app)
      .put(`/pages/${pageId}`)
      .set("x-user-id", "1")
      .send({ layoutPreset: "qhd", layoutOrientation: "portrait" });
    expect(updated.status).toBe(200);
    expect(updated.body.layoutPreset).toBe("qhd");
    expect(updated.body.layoutOrientation).toBe("portrait");

    const exported = await request(app)
      .get(`/pages/${pageId}/export`)
      .set("x-user-id", "1");
    expect(exported.status).toBe(200);
    expect(exported.body.pages[0].layoutPreset).toBe("qhd");
    expect(exported.body.pages[0].layoutOrientation).toBe("portrait");

    const imported = await request(app)
      .post("/pages/import")
      .set("x-user-id", "1")
      .send(exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body[0].layoutPreset).toBe("qhd");
    expect(imported.body[0].layoutOrientation).toBe("portrait");
  });

  it("defaults layout settings to auto/landscape for new and bare-import pages", async () => {
    const pageId = await createPage(1, "Defaults");
    const page = await request(app).get("/pages").set("x-user-id", "1");
    const created = page.body.find((p: { id: number }) => p.id === pageId);
    expect(created.layoutPreset).toBe("auto");
    expect(created.layoutOrientation).toBe("landscape");

    const imported = await request(app)
      .post("/pages/import")
      .set("x-user-id", "1")
      .send({
        format: "homelab-dashboard-pages",
        version: 1,
        pages: [{ name: "NoLayout", tiles: [] }],
      });
    expect(imported.status).toBe(201);
    expect(imported.body[0].layoutPreset).toBe("auto");
    expect(imported.body[0].layoutOrientation).toBe("landscape");
  });

  it("exports omit all identity fields", async () => {
    const pageId = await createPage(1, "Identity");
    await request(app)
      .post("/tiles")
      .set("x-user-id", "1")
      .send({ pageId, type: "app", gridX: 0, gridY: 0, gridW: 4, gridH: 4, name: "Solo" });

    const exported = await request(app)
      .get(`/pages/${pageId}/export`)
      .set("x-user-id", "1");
    const tile = exported.body.pages[0].tiles[0];
    expect(tile).not.toHaveProperty("id");
    expect(tile).not.toHaveProperty("userId");
    expect(tile).not.toHaveProperty("pageId");
    expect(tile).not.toHaveProperty("createdAt");
  });

  it("strips unknown/credential-like fields on import", async () => {
    const payload = {
      format: "homelab-dashboard-pages",
      version: 1,
      pages: [
        {
          name: "Sneaky",
          tiles: [
            {
              type: "app",
              integration: "sonarr",
              gridX: 0,
              gridY: 0,
              gridW: 4,
              gridH: 4,
              name: "Sonarr",
              // These must never land anywhere.
              apiKey: "SECRET",
              password: "hunter2",
              userId: 999,
              id: 4242,
              tileSettings: { categoryFilter: ["x"], evilField: "boom" },
            },
          ],
        },
      ],
    };

    const imported = await request(app)
      .post("/pages/import")
      .set("x-user-id", "1")
      .send(payload);
    expect(imported.status).toBe(201);
    const newPageId = imported.body[0].id as number;

    const tilesRes = await request(app)
      .get(`/tiles?pageId=${newPageId}`)
      .set("x-user-id", "1");
    const tile = tilesRes.body[0];
    expect(tile.userId).toBe(1);
    expect(tile.id).not.toBe(4242);
    expect(tile.name).toBe("Sonarr");
    // The allow-list keeps categoryFilter but drops evilField.
    expect(tile.tileSettings).toEqual({ categoryFilter: ["x"] });
    const serialized = JSON.stringify(tile);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("evilField");
  });

  it("rejects a malformed file without creating anything", async () => {
    const before = await request(app).get("/pages").set("x-user-id", "2");
    const beforeCount = before.body.length;

    const bad = await request(app)
      .post("/pages/import")
      .set("x-user-id", "2")
      .send({ not: "an export" });
    expect(bad.status).toBe(400);

    const after = await request(app).get("/pages").set("x-user-id", "2");
    expect(after.body.length).toBe(beforeCount);
  });

  it.each([
    ["a null page entry", { format: "homelab-dashboard-pages", version: 1, pages: [null] }],
    ["a null tile entry", {
      format: "homelab-dashboard-pages",
      version: 1,
      pages: [{ name: "X", tiles: [null] }],
    }],
    ["a tile missing required grid fields", {
      format: "homelab-dashboard-pages",
      version: 1,
      pages: [{ name: "X", tiles: [{ type: "app" }] }],
    }],
    ["a wrong-typed required field", {
      format: "homelab-dashboard-pages",
      version: 1,
      pages: [{ name: "X", tiles: [{ type: "app", gridX: "nope", gridY: 0, gridW: 4, gridH: 4 }] }],
    }],
    ["a non-string page name", {
      format: "homelab-dashboard-pages",
      version: 1,
      pages: [{ name: 42, tiles: [] }],
    }],
  ])("rejects %s with 400 and creates nothing", async (_label, payload) => {
    const before = await request(app).get("/pages").set("x-user-id", "2");
    const beforeCount = before.body.length;

    const res = await request(app)
      .post("/pages/import")
      .set("x-user-id", "2")
      .send(payload);
    expect(res.status).toBe(400);

    const after = await request(app).get("/pages").set("x-user-id", "2");
    expect(after.body.length).toBe(beforeCount);
  });

  it("rejects an incompatible version", async () => {
    const res = await request(app)
      .post("/pages/import")
      .set("x-user-id", "2")
      .send({ format: "homelab-dashboard-pages", version: 999, pages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/version/i);
  });

  it("appends multiple imported pages in order", async () => {
    const before = await request(app).get("/pages").set("x-user-id", "2");
    const beforeCount = before.body.length;

    const res = await request(app)
      .post("/pages/import")
      .set("x-user-id", "2")
      .send({
        format: "homelab-dashboard-pages",
        version: 1,
        pages: [
          { name: "A", tiles: [{ type: "app", gridX: 0, gridY: 0, gridW: 4, gridH: 4 }] },
          { name: "B", tiles: [] },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe("A");
    expect(res.body[1].name).toBe("B");
    expect(res.body[1].position).toBeGreaterThan(res.body[0].position);

    const after = await request(app).get("/pages").set("x-user-id", "2");
    expect(after.body.length).toBe(beforeCount + 2);
  });

  it("exports all pages for a user", async () => {
    const res = await request(app).get("/pages/export").set("x-user-id", "2");
    expect(res.status).toBe(200);
    expect(res.body.format).toBe("homelab-dashboard-pages");
    expect(Array.isArray(res.body.pages)).toBe(true);
    expect(res.body.pages.length).toBeGreaterThan(0);
  });
});
