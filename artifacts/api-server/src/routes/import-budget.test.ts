import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-budget-"));
process.env["DATA_DIR"] = tmpDir;
vi.mock("../lib/auth.js", () => ({
  requireAuth: (req: { user?: { userId: number } }, _res: unknown, next: () => void) => {
    req.user = { userId: 1 };
    next();
  },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
const { db } = await import("../lib/db.js");
const { default: pages } = await import("./pages.js");
const { default: profile } = await import("./profile.js");
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/pages", pages);
app.use("/profile", profile);
beforeAll(() => {
  db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'tester', 'x')").run();
});
afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("import handler resource limits", () => {
  it.each([1, 2])("imports 100 repeated names correctly for page format v%i", async (version) => {
    const res = await request(app).post("/pages/import").send({
      format: "homelab-dashboard-pages", version,
      pages: Array.from({ length: 100 }, () => ({ name: `v${version}`, tiles: [] })),
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(100);
    expect(res.body[0].name).toBe(`v${version}`);
    expect(res.body[99].name).toBe(`v${version} (100)`);
  });

  it.each(["/pages/import", "/profile/import"])("rejects the 15,000-page attack before schema parsing or any transaction at %s", async (url) => {
    const transaction = vi.spyOn(db, "transaction");
    const res = await request(app).post(url).send({
      format: url.startsWith("/pages") ? "homelab-dashboard-pages" : "tachboard-profile",
      version: 1, mode: "replace", deviceModes: [],
      pages: Array.from({ length: 15000 }, () => ({ name: "x", tiles: [] })),
    });
    const transactions = transaction.mock.calls.length;
    transaction.mockRestore();
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("100 pages");
    expect(transactions).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: 200 });
  });

  it.each(["/pages/import", "/profile/import"])("rejects excess nested work before writes at %s", async (url) => {
    const res = await request(app).post(url).send({
      format: url.startsWith("/pages") ? "homelab-dashboard-pages" : "tachboard-profile",
      version: 2, mode: "replace", deviceModes: [],
      pages: [{ name: "x", tiles: [], layouts: Array(501).fill({ tiles: [] }) }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("500 layouts");
    expect(db.prepare("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: 200 });
  });
});