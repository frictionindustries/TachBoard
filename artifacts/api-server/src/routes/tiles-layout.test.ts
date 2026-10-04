import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

// Use a throwaway data dir so the real SQLite DB is created fresh and isolated.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiles-layout-"));
process.env["DATA_DIR"] = tmpDir;

// Auth is replaced with a pass-through that injects a fixed user so the routes
// run without a real JWT. Tiles created below belong to this user.
vi.mock("../lib/auth.js", () => ({
  requireAuth: (req: { user?: { userId: number } }, _res: unknown, next: () => void) => {
    req.user = { userId: 1 };
    next();
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// Imported after mocks (and after DATA_DIR is set) so the DB binds to tmpDir.
const { db } = await import("../lib/db.js");
const { default: tilesRouter } = await import("./tiles.js");
const { default: layoutRouter } = await import("./layout.js");

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  // Mount layout before tiles so /tiles/layout isn't shadowed by /tiles/:id
  // (mirrors the real router registration order).
  app.use("/tiles/layout", layoutRouter);
  app.use("/tiles", tilesRouter);
  return app;
}

const app = makeApp();

beforeAll(() => {
  // The tiles foreign key requires a real user row with id = 1.
  db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'tester', 'x')").run();
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PUT /tiles/layout", () => {
  it.each([undefined, false, true, null])("round-trips expanded setting %s through edits, reads and layout saves", async (openExpanded) => {
    const created = await request(app).post("/tiles").send({
      type: "app", name: "Expandable", gridX: 0, gridY: 0, gridW: 2, gridH: 2,
      tileSettings: { openExpanded, scrollable: false },
    });
    expect(created.status).toBe(201);
    expect(created.body.tileSettings.openExpanded).toBe(openExpanded);
    const id = created.body.id;
    const saved = await request(app).put("/tiles/layout").send({
      tiles: [{ id, gridX: 2, gridY: 1, gridW: 4, gridH: 3 }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.find((t: { id: number }) => t.id === id).tileSettings.openExpanded).toBe(openExpanded);
    const read = await request(app).get("/tiles");
    expect(read.body.find((t: { id: number }) => t.id === id).tileSettings.openExpanded).toBe(openExpanded);
    const updated = await request(app).put(`/tiles/${id}`).send({ tileSettings: { openExpanded: true } });
    expect(updated.status).toBe(200);
    expect(updated.body.tileSettings.openExpanded).toBe(true);
  });

  it("preserves integration and metrics after a resize/layout save", async () => {
    // Create an integration tile with an explicit metric subset.
    const created = await request(app)
      .post("/tiles")
      .send({
        type: "app",
        integration: "truenas",
        name: "NAS",
        metrics: ["cpu"],
        gridX: 0,
        gridY: 0,
        gridW: 2,
        gridH: 2,
      });
    expect(created.status).toBe(201);
    expect(created.body.integration).toBe("truenas");
    expect(created.body.metrics).toEqual(["cpu"]);

    const id = created.body.id as number;

    // Resize it via the bulk layout-save endpoint (the resize flow).
    const saved = await request(app)
      .put("/tiles/layout")
      .send({ tiles: [{ id, gridX: 1, gridY: 1, gridW: 6, gridH: 5 }] });

    expect(saved.status).toBe(200);
    expect(Array.isArray(saved.body)).toBe(true);

    const tile = (saved.body as Array<{ id: number }>).find((t) => t.id === id) as Record<
      string,
      unknown
    >;
    expect(tile).toBeTruthy();
    // New size is reflected…
    expect(tile.gridW).toBe(6);
    expect(tile.gridH).toBe(5);
    // …and crucially the full Tile contract survives the layout save.
    expect(tile.integration).toBe("truenas");
    expect(tile.metrics).toEqual(["cpu"]);
  });

  it("returns metrics as null (show all) for tiles that never set them", async () => {
    const created = await request(app)
      .post("/tiles")
      .send({ type: "app", integration: "sonarr", name: "Sonarr", gridW: 2, gridH: 2 });
    expect(created.status).toBe(201);
    expect(created.body.metrics).toBeNull();

    const id = created.body.id as number;
    const saved = await request(app)
      .put("/tiles/layout")
      .send({ tiles: [{ id, gridX: 0, gridY: 0, gridW: 4, gridH: 4 }] });

    const tile = (saved.body as Array<{ id: number }>).find((t) => t.id === id) as Record<
      string,
      unknown
    >;
    expect(tile.integration).toBe("sonarr");
    expect(tile.metrics).toBeNull();
  });

  it("preserves clock tileSettings through a layout save", async () => {
    const created = await request(app)
      .post("/tiles")
      .send({
        type: "app",
        integration: "clock",
        name: "Local Time",
        tileSettings: { clockFormat: "12", clockShowSeconds: true, clockShowDate: true },
        gridW: 2,
        gridH: 2,
      });
    expect(created.status).toBe(201);
    expect(created.body.tileSettings).toEqual({
      clockFormat: "12",
      clockShowSeconds: true,
      clockShowDate: true,
    });

    const id = created.body.id as number;
    const saved = await request(app)
      .put("/tiles/layout")
      .send({ tiles: [{ id, gridX: 0, gridY: 0, gridW: 3, gridH: 3 }] });

    const tile = (saved.body as Array<{ id: number }>).find((t) => t.id === id) as Record<
      string,
      unknown
    >;
    expect(tile.integration).toBe("clock");
    expect(tile.tileSettings).toEqual({
      clockFormat: "12",
      clockShowSeconds: true,
      clockShowDate: true,
    });
  });

  it("preserves weather tileSettings through a layout save", async () => {
    const created = await request(app)
      .post("/tiles")
      .send({
        type: "app",
        integration: "weather",
        name: "Weather",
        tileSettings: { weatherAutoLocate: false, weatherLocation: "London", weatherUnits: "f" },
        gridW: 2,
        gridH: 2,
      });
    expect(created.status).toBe(201);
    expect(created.body.tileSettings).toEqual({
      weatherAutoLocate: false,
      weatherLocation: "London",
      weatherUnits: "f",
    });

    const id = created.body.id as number;
    const saved = await request(app)
      .put("/tiles/layout")
      .send({ tiles: [{ id, gridX: 0, gridY: 0, gridW: 4, gridH: 4 }] });

    const tile = (saved.body as Array<{ id: number }>).find((t) => t.id === id) as Record<
      string,
      unknown
    >;
    expect(tile.integration).toBe("weather");
    expect(tile.tileSettings).toEqual({
      weatherAutoLocate: false,
      weatherLocation: "London",
      weatherUnits: "f",
    });
  });

  it("preserves truenasMetric tileSettings through a layout save", async () => {
    const created = await request(app)
      .post("/tiles")
      .send({
        type: "app",
        integration: "truenas",
        name: "ZFS Pools",
        tileSettings: { truenasMetric: "pools" },
        gridW: 2,
        gridH: 2,
      });
    expect(created.status).toBe(201);
    expect(created.body.tileSettings).toEqual({ truenasMetric: "pools" });

    const id = created.body.id as number;
    const saved = await request(app)
      .put("/tiles/layout")
      .send({ tiles: [{ id, gridX: 0, gridY: 0, gridW: 3, gridH: 3 }] });

    const tile = (saved.body as Array<{ id: number }>).find((t) => t.id === id) as Record<
      string,
      unknown
    >;
    expect(tile.integration).toBe("truenas");
    expect(tile.tileSettings).toEqual({ truenasMetric: "pools" });
  });

  it("preserves the truenasShowCpuCores toggle through a layout save", async () => {
    const created = await request(app)
      .post("/tiles")
      .send({
        type: "app",
        integration: "truenas",
        name: "CPU Temp",
        tileSettings: { truenasMetric: "cputemp", truenasShowCpuCores: false },
        gridW: 2,
        gridH: 2,
      });
    expect(created.status).toBe(201);
    expect(created.body.tileSettings).toEqual({
      truenasMetric: "cputemp",
      truenasShowCpuCores: false,
    });

    const id = created.body.id as number;
    const saved = await request(app)
      .put("/tiles/layout")
      .send({ tiles: [{ id, gridX: 0, gridY: 0, gridW: 3, gridH: 3 }] });

    const tile = (saved.body as Array<{ id: number }>).find((t) => t.id === id) as Record<
      string,
      unknown
    >;
    expect(tile.tileSettings).toEqual({
      truenasMetric: "cputemp",
      truenasShowCpuCores: false,
    });
  });
});
