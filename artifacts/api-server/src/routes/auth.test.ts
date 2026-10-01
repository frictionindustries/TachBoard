import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";
import Database from "better-sqlite3";
import { AUTH_LIMITS, AuthResourceLimiter, createAuthIngress } from "../lib/authResources.js";

const cryptoMocks = vi.hoisted(() => ({
  hash: vi.fn<(password: string, rounds: number) => Promise<string>>(),
  compare: vi.fn<(password: string, hash: string) => Promise<boolean>>(),
}));
vi.mock("bcryptjs", () => ({ default: cryptoMocks }));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-resources-"));
process.env["DATA_DIR"] = tmpDir;
const { db } = await import("../lib/db.js");
const { createAuthRouter } = await import("./auth.js");

function makeApp(limiter = new AuthResourceLimiter()) {
  const app = express();
  app.set("trust proxy", true); // Must not turn X-Forwarded-For into a bucket key.
  app.use("/api/auth", createAuthIngress(limiter));
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use("/api/auth", createAuthRouter(limiter));
  app.post("/import-test", (req, res) => res.json({ length: req.body.data.length }));
  return { app, limiter };
}

const count = () => (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
const writes = () => (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
const seed = (n: number) => {
  const insert = db.prepare("INSERT INTO users (username, password) VALUES (?, 'stored-hash')");
  for (let i = 0; i < n; i++) insert.run(`existing-${i}`);
};

beforeEach(() => {
  db.prepare("DELETE FROM users").run();
  cryptoMocks.hash.mockReset().mockResolvedValue("new-hash");
  cryptoMocks.compare.mockReset().mockResolvedValue(true);
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("auth input and parsing", () => {
  it.each([
    null,
    [],
    { username: 123, password: "123456" },
    { username: { length: 3 }, password: "123456" },
    { username: ["user"], password: "123456" },
    { username: "user", password: ["123456"] },
    { username: "user", password: { length: 6 } },
    { username: "user", password: 123456 },
    { username: "user" },
    { username: "", password: "123456" },
    { username: "user", password: "" },
    { username: "user", password: "123456", extra: true },
  ])("rejects malformed credentials before bcrypt or writes: %j", async (body) => {
    const { app } = makeApp();
    const before = writes();
    for (const route of ["register", "login"]) {
      const res = await request(app).post(`/api/auth/${route}`).set("Content-Type", "application/json")
        .send(JSON.stringify(body));
      expect(res.status).toBe(400);
    }
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(cryptoMocks.compare).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  });

  it.each([
    { username: "ab", password: "123456" },
    { username: "user", password: "12345" },
    { username: "u".repeat(65), password: "123456" },
    { username: "user", password: "p".repeat(73) },
    { username: "user", password: "é".repeat(37) },
  ])("rejects signup bounds before bcrypt/writes: %j", async (body) => {
    const { app } = makeApp();
    const before = writes();
    expect((await request(app).post("/api/auth/register").send(body)).status).toBe(400);
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  });

  it("rejects over-limit legacy login input without bcrypt or writes", async () => {
    const { app } = makeApp();
    seed(1);
    const before = writes();
    for (const body of [
      { username: "u".repeat(257), password: "p" },
      { username: "existing-0", password: "p".repeat(1025) },
      { username: "existing-0", password: "é".repeat(513) },
    ]) {
      expect((await request(app).post("/api/auth/login").send(body)).status).toBe(400);
    }
    expect(cryptoMocks.compare).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  });

  it.each(["/api/auth/register", "/api/auth/login", "/API/AUTH/LOGIN/"])(
    "caps JSON bodies before the 5mb parser on %s", async (route) => {
      const { app } = makeApp();
      const before = writes();
      const res = await request(app).post(route).send({ username: "user", password: "p".repeat(5000) });
      expect(res.status).toBe(413);
      expect(res.body.error).toContain("4096");
      expect(cryptoMocks.hash).not.toHaveBeenCalled();
      expect(cryptoMocks.compare).not.toHaveBeenCalled();
      expect(writes()).toBe(before);
      const ordinary = await request(app).post("/import-test").send({ data: "x".repeat(5000) });
      expect(ordinary.status).toBe(200);
    },
  );

  it("caps chunked JSON bodies without trusting Content-Length", async () => {
    const { app } = makeApp();
    const before = writes();
    // .send() would synthesize Content-Length; write real streaming chunks.
    const upload = request(app).post("/api/auth/register")
      .set("Content-Type", "application/json").set("Transfer-Encoding", "chunked");
    upload.write('{"username":"user","password":"');
    upload.write("p".repeat(5000));
    upload.write('"}');
    const res = await upload;
    expect(res.status).toBe(413);
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  });

  it("bounds URL-encoded bodies and rejects repeated/nested parameters", async () => {
    const { app } = makeApp();
    const before = writes();
    const huge = await request(app).post("/api/auth/register").type("form")
      .send({ username: "user", password: "p".repeat(5000) });
    expect(huge.status).toBe(413);
    const duplicate = await request(app).post("/api/auth/login").type("form")
      .send("username=user&username=other&password=123456");
    expect(duplicate.status).toBe(413);
    const nested = await request(app).post("/api/auth/login").type("form")
      .send("username[length]=3&password=123456");
    expect(nested.status).toBe(400);
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(cryptoMocks.compare).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  });

  it("rejects compressed, unsupported, and invalid JSON bodies without bcrypt/writes", async () => {
    const { app } = makeApp();
    const before = writes();
    const compressed = await request(app).post("/api/auth/register")
      .set("Content-Type", "application/json").set("Content-Encoding", "gzip")
      .send(gzipSync(JSON.stringify({ username: "user", password: "123456" })));
    expect(compressed.status).toBe(415);
    expect((await request(app).post("/api/auth/register").type("text").send("x".repeat(5000))).status).toBe(415);
    expect((await request(app).post("/api/auth/register").type("json").send("{")).status).toBe(400);
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  });

  it("preserves ordinary JSON signup/login, form login, JWT and default rows", async () => {
    const { app } = makeApp();
    const credentials = { username: "Mixed Case", password: "123456" };
    const signup = await request(app).post("/api/auth/register").send(credentials);
    expect(signup.status).toBe(201);
    expect(signup.body.user.username).toBe(credentials.username);
    expect(signup.body.token).toBeTypeOf("string");
    expect(cryptoMocks.hash).toHaveBeenCalledWith(credentials.password, 12);
    expect(db.prepare("SELECT COUNT(*) AS count FROM pages").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM device_modes").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM service_connections").get()).toEqual({ count: 5 });
    for (const type of ["json", "form"]) {
      const login = await request(app).post("/api/auth/login").type(type).send(credentials);
      expect(login.status).toBe(200);
      expect(login.body.user).toEqual(signup.body.user);
    }
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${signup.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body).toEqual(signup.body.user);
  });

  it("accepts boundary signup credentials and preserves real legacy bcrypt truncation", async () => {
    const { app } = makeApp();
    expect((await request(app).post("/api/auth/register").send({
      username: "u".repeat(64), password: "é".repeat(36),
    })).status).toBe(201);
    const realBcrypt = await vi.importActual<typeof import("bcryptjs")>("bcryptjs");
    const legacyPassword = "p".repeat(AUTH_LIMITS.loginPasswordBytes);
    const legacyHash = realBcrypt.default.hashSync(legacyPassword, 4);
    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run("a", legacyHash);
    cryptoMocks.compare.mockImplementation((password, hash) => realBcrypt.default.compare(password, hash));
    expect((await request(app).post("/api/auth/login").send({ username: "a", password: legacyPassword })).status).toBe(200);
    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run("b", realBcrypt.default.hashSync("b", 4));
    expect((await request(app).post("/api/auth/login").send({ username: "b", password: "b" })).status).toBe(200);
  });
});

describe("auth throttling and quota", () => {
  it("does not hash/write for duplicate users or compare for nonexistent users", async () => {
    const { app } = makeApp();
    seed(1);
    const before = writes();
    expect((await request(app).post("/api/auth/register").send({ username: "existing-0", password: "123456" })).status).toBe(400);
    expect((await request(app).post("/api/auth/login").send({ username: "missing", password: "123456" })).status).toBe(401);
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(cryptoMocks.compare).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  });

  it("returns invalid credentials without writes and frees the compare worker", async () => {
    const { app } = makeApp();
    seed(1);
    const before = writes();
    cryptoMocks.compare.mockResolvedValueOnce(false);
    expect((await request(app).post("/api/auth/login").send({ username: "existing-0", password: "wrong" })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ username: "existing-0", password: "123456" })).status).toBe(200);
    expect(cryptoMocks.compare).toHaveBeenCalledTimes(2);
    expect(writes()).toBe(before);
  });

  it("charges successful login/signup to the same CPU budget, ignoring spoofed headers", async () => {
    let now = 0;
    const { app } = makeApp(new AuthResourceLimiter(() => now));
    seed(1);
    for (let i = 0; i < AUTH_LIMITS.bcryptPerSource; i++) {
      const login = await request(app).post("/api/auth/login").set("X-Forwarded-For", `198.51.100.${i}`)
        .send({ username: "existing-0", password: "123456" });
      expect(login.status).toBe(200);
    }
    const before = writes();
    const signup = await request(app).post("/api/auth/register").set("X-Forwarded-For", "203.0.113.1")
      .send({ username: "new-user", password: "123456" });
    expect(signup.status).toBe(429);
    expect(signup.headers["retry-after"]).toBe("60");
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
    now = AUTH_LIMITS.windowMs;
    expect((await request(app).post("/api/auth/register").send({ username: "new-user", password: "123456" })).status).toBe(201);
  });

  it("throttles before parsing or bcrypt, does not slide the window, and exempts me", async () => {
    let now = 0;
    const { app } = makeApp(new AuthResourceLimiter(() => now));
    for (let i = 0; i < AUTH_LIMITS.requestsPerSource; i++) {
      expect((await request(app).post("/api/auth/login").send({ username: "missing", password: "123456" })).status).toBe(401);
    }
    const before = writes();
    now = 59_000;
    const res = await request(app).post("/api/auth/register").type("json").send("{");
    expect(res.status).toBe(429); // Not malformed-body 400: guard ran first.
    expect(res.headers["retry-after"]).toBe("1");
    expect((await request(app).get("/api/auth/me")).status).toBe(401); // Auth, not throttle.
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(cryptoMocks.compare).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
    now = 60_000;
    expect((await request(app).post("/api/auth/register").send({ username: "new-user", password: "123456" })).status).toBe(201);
  });

  it("rejects concurrent work before bcrypt/write and releases workers when bcrypt throws", async () => {
    const { app } = makeApp();
    seed(1);
    const release: Array<(result: boolean) => void> = [];
    cryptoMocks.compare.mockImplementation(() => new Promise<boolean>((resolve) => release.push(resolve)));
    const first = request(app).post("/api/auth/login").send({ username: "existing-0", password: "123456" }).then((res) => res);
    const second = request(app).post("/api/auth/login").send({ username: "existing-0", password: "123456" }).then((res) => res);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    const before = writes();
    const denied = await request(app).post("/api/auth/register").send({ username: "new-user", password: "123456" });
    expect(denied.status).toBe(429);
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
    release.forEach((resolve) => resolve(true));
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      cryptoMocks.hash.mockRejectedValueOnce(new Error("bcrypt failed"));
      expect((await request(app).post("/api/auth/register").send({ username: "failed-user", password: "123456" })).status).toBe(500);
      expect(writes()).toBe(before);
      expect((await request(app).post("/api/auth/register").send({ username: "new-user", password: "123456" })).status).toBe(201);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects a persistent full quota before hashing/writes but still permits login", async () => {
    seed(AUTH_LIMITS.accounts);
    const before = writes();
    for (let i = 0; i < 2; i++) {
      // New limiter/router state cannot reset the quota stored in SQLite.
      const { app } = makeApp();
      const res = await request(app).post("/api/auth/register").send({ username: `new-${i}`, password: "123456" });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("32");
      expect((await request(app).post("/api/auth/login").send({ username: "existing-0", password: "123456" })).status).toBe(200);
    }
    expect(cryptoMocks.hash).not.toHaveBeenCalled();
    expect(writes()).toBe(before);
  });

  it("rechecks the final slot after concurrent hashes; only one account/default set is written", async () => {
    const { app } = makeApp();
    seed(AUTH_LIMITS.accounts - 1);
    const release: Array<(result: string) => void> = [];
    cryptoMocks.hash.mockImplementation(() => new Promise<string>((resolve) => release.push(resolve)));
    const requests = ["new-one", "new-two"].map((username) =>
      request(app).post("/api/auth/register").send({ username, password: "123456" }).then((res) => res),
    );
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach((resolve) => resolve("new-hash"));
    const results = await Promise.all(requests);
    expect(results.map((res) => res.status).sort()).toEqual([201, 403]);
    expect(count()).toBe(AUTH_LIMITS.accounts);
    expect(db.prepare("SELECT COUNT(*) AS count FROM pages").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM device_modes").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM service_connections").get()).toEqual({ count: 5 });
  });

  it("performs no writes if another writer fills the quota while hashing", async () => {
    const { app } = makeApp();
    seed(AUTH_LIMITS.accounts - 1);
    let release!: (result: string) => void;
    cryptoMocks.hash.mockImplementation(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = request(app).post("/api/auth/register").send({ username: "pending", password: "123456" }).then((res) => res);
    await vi.waitFor(() => expect(cryptoMocks.hash).toHaveBeenCalledTimes(1));
    const writer = new Database(path.join(tmpDir, "db.sqlite"));
    try {
      writer.prepare("INSERT INTO users (username, password) VALUES ('other-writer', 'hash')").run();
    } finally {
      writer.close();
    }
    const before = writes();
    release("hash");
    expect((await pending).status).toBe(403);
    expect(writes()).toBe(before);
  });

  it("handles a username race without 500 errors or duplicate defaults", async () => {
    const { app } = makeApp();
    const release: Array<(result: string) => void> = [];
    cryptoMocks.hash.mockImplementation(() => new Promise<string>((resolve) => release.push(resolve)));
    const requests = [1, 2].map(() =>
      request(app).post("/api/auth/register").send({ username: "same-user", password: "123456" }).then((res) => res),
    );
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach((resolve) => resolve("hash"));
    expect((await Promise.all(requests)).map((res) => res.status).sort()).toEqual([201, 400]);
    expect(count()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM pages").get()).toEqual({ count: 1 });
  });

  it("rolls back the account if initialization fails instead of consuming quota", async () => {
    const { app } = makeApp();
    db.exec("CREATE TEMP TRIGGER fail_auth_defaults BEFORE INSERT ON pages BEGIN SELECT RAISE(ABORT, 'failed defaults'); END");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await request(app).post("/api/auth/register").send({ username: "failed-user", password: "123456" })).status).toBe(500);
      expect(count()).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM pages").get()).toEqual({ count: 0 });
    } finally {
      db.exec("DROP TRIGGER fail_auth_defaults");
      consoleError.mockRestore();
    }
  });
});