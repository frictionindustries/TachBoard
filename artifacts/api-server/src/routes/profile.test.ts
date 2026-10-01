import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

// Use a throwaway data dir so the real SQLite DB is created fresh and isolated.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-export-"));
process.env["DATA_DIR"] = tmpDir;

// Auth is replaced with a pass-through that reads the user id from a header so
// a single test app can act as different users (default user 1).
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
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Imported after mocks (and after DATA_DIR is set) so the DB binds to tmpDir.
const { db, connectionStmts, deviceModeStmts, pageStmts } = await import("../lib/db.js");
const { default: profileRouter } = await import("./profile.js");
const { default: pagesRouter } = await import("./pages.js");
const { default: tilesRouter } = await import("./tiles.js");

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/profile", profileRouter);
  app.use("/pages", pagesRouter);
  app.use("/tiles", tilesRouter);
  return app;
}

const app = makeApp();

beforeAll(() => {
  db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'tester', 'x')").run();
  db.prepare("INSERT INTO users (id, username, password) VALUES (2, 'target', 'x')").run();
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createPage(userId: number, name: string): Promise<number> {
  const res = await request(app)
    .post("/pages")
    .set("x-user-id", String(userId))
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function createTile(userId: number, pageId: number, name: string) {
  const res = await request(app)
    .post("/tiles")
    .set("x-user-id", String(userId))
    .send({ pageId, type: "app", gridX: 0, gridY: 0, gridW: 4, gridH: 4, name });
  expect(res.status).toBe(201);
}

describe("profile export", () => {
  it("exports the full profile shape without connections by default", async () => {
    const pageId = await createPage(1, "Main");
    await createTile(1, pageId, "Router");
    deviceModeStmts.create.get(1, "Wallboard", 5);
    connectionStmts.upsert.run(1, "sonarr", "http://s", "KEY", null, null, null);

    const res = await request(app).get("/profile/export").set("x-user-id", "1");
    expect(res.status).toBe(200);
    expect(res.body.format).toBe("tachboard-profile");
    expect(res.body.version).toBe(1);
    expect(res.body.exportedAt).toBeTruthy();
    expect(res.body.deviceModes.map((m: { name: string }) => m.name)).toContain("Wallboard");
    const main = res.body.pages.find((p: { name: string }) => p.name === "Main");
    expect(main.tiles).toHaveLength(1);
    expect(Array.isArray(main.layouts)).toBe(true);
    // Credentials never leak without the explicit flag.
    expect(res.body.connections).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("KEY");
  });

  it("includes configured connections only when explicitly requested", async () => {
    const res = await request(app)
      .get("/profile/export?includeConnections=true")
      .set("x-user-id", "1");
    expect(res.status).toBe(200);
    const sonarr = res.body.connections.find(
      (c: { service: string }) => c.service === "sonarr",
    );
    expect(sonarr).toMatchObject({ url: "http://s", apiKey: "KEY" });
    // Blank seeded rows are skipped.
    for (const c of res.body.connections) {
      expect(c.url || c.apiKey || c.username || c.password || c.extra).toBeTruthy();
    }
  });
});

describe("profile import", () => {
  it.each(["http://10.0.0.8/actuator/env?", "http://10.0.0.8/#"])(
    "rejects imported service URL %s before any profile writes", async (url) => {
      const beforePages = pageStmts.findAllByUser.all(2);
      const beforeModes = deviceModeStmts.findAllByUser.all(2);
      const beforeConnections = connectionStmts.findAllByUser.all(2);
      const res = await request(app).post("/profile/import").set("x-user-id", "2").send({
        format: "tachboard-profile", version: 1, mode: "replace",
        deviceModes: [{ name: "Injected mode" }],
        pages: [{ name: "Injected page", tiles: [] }],
        connections: [{ service: "truenas", url, apiKey: "key" }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid service URL");
      expect(pageStmts.findAllByUser.all(2)).toEqual(beforePages);
      expect(deviceModeStmts.findAllByUser.all(2)).toEqual(beforeModes);
      expect(connectionStmts.findAllByUser.all(2)).toEqual(beforeConnections);
    },
  );

  it("imports safe proxy prefixes and leaves non-URL connection formats alone", async () => {
    const res = await request(app).post("/profile/import").set("x-user-id", "2").send({
      format: "tachboard-profile", version: 1, mode: "merge", deviceModes: [], pages: [],
      connections: [
        { service: "immich", url: "10.0.0.8/proxy/immich/" },
        { service: "tailscale", url: "user@example.com" },
        { service: "stocks", url: "provider-specific-value" },
        { service: "imap", extra: JSON.stringify({ accounts: [] }) },
      ],
    });
    expect(res.status).toBe(200);
    expect(connectionStmts.findByService.get(2, "immich")?.url).toBe("http://10.0.0.8/proxy/immich");
    expect(connectionStmts.findByService.get(2, "tailscale")?.url).toBe("user@example.com");
  });

  it("replace wipes and recreates pages, device modes, and connections", async () => {
    // Target user starts with their own content + a configured connection.
    const oldPage = await createPage(2, "OldStuff");
    await createTile(2, oldPage, "OldTile");
    connectionStmts.upsert.run(2, "radarr", "http://old", "OLDKEY", null, null, null);

    const exported = await request(app)
      .get("/profile/export?includeConnections=true")
      .set("x-user-id", "1");

    const res = await request(app)
      .post("/profile/import")
      .set("x-user-id", "2")
      .send({ ...exported.body, mode: "replace" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("replace");
    expect(res.body.pages).toBeGreaterThan(0);
    expect(res.body.tiles).toBeGreaterThan(0);

    const pages = pageStmts.findAllByUser.all(2);
    expect(pages.map((p) => p.name)).not.toContain("OldStuff");
    expect(pages.map((p) => p.name)).toContain("Main");
    const modes = deviceModeStmts.findAllByUser.all(2);
    expect(modes.map((m) => m.name)).toContain("Wallboard");
    // Old credential was wiped; the file's credential landed.
    const radarr = connectionStmts.findByService.get(2, "radarr");
    expect(radarr?.api_key ?? null).toBeNull();
    const sonarr = connectionStmts.findByService.get(2, "sonarr");
    expect(sonarr?.api_key).toBe("KEY");
  });

  it("merge appends pages with de-duplicated names and keeps existing credentials", async () => {
    connectionStmts.upsert.run(2, "sonarr", "http://mine", "MYKEY", null, null, null);
    const exported = await request(app)
      .get("/profile/export?includeConnections=true")
      .set("x-user-id", "1");

    const before = pageStmts.findAllByUser.all(2).length;
    const res = await request(app)
      .post("/profile/import")
      .set("x-user-id", "2")
      .send({ ...exported.body, mode: "merge" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("merge");

    const pages = pageStmts.findAllByUser.all(2);
    expect(pages.length).toBe(before + exported.body.pages.length);
    // "Main" already exists from the replace test, so the merged copy is renamed.
    expect(pages.map((p) => p.name)).toContain("Main (2)");
    // Merge never clobbers an already-configured connection.
    const sonarr = connectionStmts.findByService.get(2, "sonarr");
    expect(sonarr?.api_key).toBe("MYKEY");
    // Device modes are matched by name, not duplicated.
    const wallboards = deviceModeStmts
      .findAllByUser.all(2)
      .filter((m) => m.name === "Wallboard");
    expect(wallboards).toHaveLength(1);
  });

  it("a file without connections leaves connections untouched even in replace mode", async () => {
    const exported = await request(app).get("/profile/export").set("x-user-id", "1");
    const res = await request(app)
      .post("/profile/import")
      .set("x-user-id", "2")
      .send({ ...exported.body, mode: "replace" });
    expect(res.status).toBe(200);
    expect(res.body.connections).toBe(0);
    const sonarr = connectionStmts.findByService.get(2, "sonarr");
    expect(sonarr?.api_key).toBe("MYKEY");
  });

  it("replace with an explicit empty connections list wipes existing credentials", async () => {
    connectionStmts.upsert.run(2, "sonarr", "http://mine", "MYKEY", null, null, null);
    const exported = await request(app).get("/profile/export").set("x-user-id", "1");
    const res = await request(app)
      .post("/profile/import")
      .set("x-user-id", "2")
      .send({ ...exported.body, connections: [], mode: "replace" });
    expect(res.status).toBe(200);
    expect(res.body.connections).toBe(0);
    // The file explicitly declared "no connections", so old credentials go away.
    const sonarr = connectionStmts.findByService.get(2, "sonarr");
    expect(sonarr?.api_key ?? null).toBeNull();
  });

  it("rejects a pages-only export with a clear message", async () => {
    const res = await request(app)
      .post("/profile/import")
      .set("x-user-id", "2")
      .send({
        format: "homelab-dashboard-pages",
        version: 2,
        mode: "merge",
        deviceModes: [],
        pages: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pages export/i);
  });

  it("rejects an encrypted export with a message pointing at the Settings page", async () => {
    const res = await request(app)
      .post("/profile/import")
      .set("x-user-id", "2")
      .send({
        format: "tachboard-profile-encrypted",
        version: 1,
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 310000, salt: "AAAA" },
        cipher: { name: "AES-GCM", iv: "AAAA" },
        ciphertext: "AAAA",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/passphrase/i);
  });

  it("rejects malformed files and wrong versions without creating anything", async () => {
    const before = pageStmts.findAllByUser.all(2).length;
    for (const payload of [
      { not: "an export" },
      { format: "tachboard-profile", version: 1, mode: "replace", deviceModes: [], pages: [null] },
      { format: "tachboard-profile", version: 999, mode: "merge", deviceModes: [], pages: [] },
      { format: "tachboard-profile", version: 1, mode: "nuke", deviceModes: [], pages: [] },
      // Replace with zero pages would leave the account empty.
      { format: "tachboard-profile", version: 1, mode: "replace", deviceModes: [], pages: [] },
    ]) {
      const res = await request(app)
        .post("/profile/import")
        .set("x-user-id", "2")
        .send(payload);
      expect(res.status).toBe(400);
    }
    expect(pageStmts.findAllByUser.all(2).length).toBe(before);
  });

  it("strips credential-like fields on tiles and junk service keys on import", async () => {
    const res = await request(app)
      .post("/profile/import")
      .set("x-user-id", "2")
      .send({
        format: "tachboard-profile",
        version: 1,
        mode: "merge",
        deviceModes: [{ name: "Default" }],
        pages: [
          {
            name: "Sneaky",
            tiles: [
              {
                type: "app",
                gridX: 0,
                gridY: 0,
                gridW: 4,
                gridH: 4,
                name: "Sonarr",
                apiKey: "SECRET",
                password: "hunter2",
              },
            ],
          },
        ],
        connections: [{ service: "evil service; DROP TABLE", apiKey: "x" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.connections).toBe(0);
    const page = pageStmts.findAllByUser.all(2).find((p) => p.name === "Sneaky")!;
    const tiles = await request(app)
      .get(`/tiles?pageId=${page.id}`)
      .set("x-user-id", "2");
    expect(JSON.stringify(tiles.body)).not.toContain("SECRET");
    expect(JSON.stringify(tiles.body)).not.toContain("hunter2");
  });
});
