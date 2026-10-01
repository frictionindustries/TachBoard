import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";

// Only DNS and the final HTTP transport are substituted. Auth, SQLite, ALS,
// routers, scheduler, and the shared client's request interceptor stay real.
const { dnsLookup } = vi.hoisted(() => ({ dnsLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ default: { lookup: dnsLookup } }));
vi.mock("./logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-policy-"));
vi.stubEnv("DATA_DIR", tmpDir);
vi.stubEnv("JWT_SECRET", "outbound-policy-regression-test-signing-key-not-a-production-secret");
const { db, connectionStmts, healthStmts, userStmts } = await import("./db.js");
const { requireAuth, signToken } = await import("./auth.js");
const { outboundContext } = await import("./outboundContext.js");
const { runAsOutboundUser } = await import("./outboundPolicy.js");
const { httpClient, UnsafeUrlError } = await import("./http.js");
const { runHealthChecks } = await import("./healthCheck.js");
const { default: connectionsRouter } = await import("../routes/connections.js");
const { default: widgetsRouter } = await import("../routes/widgets.js");

const originalAdapter = httpClient.defaults.adapter;
const adapter = vi.fn<AxiosAdapter>(async (config) => ({
  data: config.responseType === "arraybuffer"
    ? Buffer.from("#EXTM3U\n#EXT-X-ENDLIST\n")
    : [],
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/vnd.apple.mpegurl" },
  config,
}));
httpClient.defaults.adapter = adapter;

const app = express();
app.use(express.json());
app.use("/api/connections", connectionsRouter);
app.use("/api/widgets", widgetsRouter);
// Exercise explicit per-call flags through the real authentication middleware.
// The upstream path is fixed, as it is in the production connection test.
app.post("/policy-probe", requireAuth, async (req, res) => {
  try {
    await httpClient.get(`${req.body.url}/api/v3/system/status`, {
      ssrfPublicOnly: req.body.publicOnly,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const ownerId = 41;
const otherId = 73;
const token = (userId: number) => signToken({ userId, username: `test-${userId}` });
const auth = (userId: number) => `Bearer ${token(userId)}`;
const privateBases = [
  "http://10.0.0.5:8989",
  "http://172.16.0.5:8989",
  "http://192.168.1.10:8989",
  "http://100.64.0.5:8989",
  "http://[fd00::5]:8989",
];

function testConnection(userId: number, url: string) {
  return request(app).post("/api/connections/sonarr/test")
    .set("Authorization", auth(userId))
    .send({ url, apiKey: "test-service-key" });
}

function saveConnection(userId: number, service: string, url: string) {
  connectionStmts.upsert.run(userId, service, url, "test-service-key", null, null, null);
}

function expectPinned(config: InternalAxiosRequestConfig, answers: Array<{ address: string; family: number }>) {
  expect(config.proxy).toBe(false);
  expect(config.maxRedirects).toBe(0);
  expect(config.lookup).toBeTypeOf("function");
  const lookup = config.lookup as unknown as (
    host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void
  ) => void;
  const all = vi.fn();
  lookup("rebinding.example.test", { all: true }, all);
  expect(all).toHaveBeenCalledExactlyOnceWith(null, answers);
  const single = vi.fn();
  lookup("rebinding.example.test", {}, single);
  expect(single).toHaveBeenCalledExactlyOnceWith(null, answers[0]!.address, answers[0]!.family);
}

beforeEach(() => {
  db.prepare("DELETE FROM users").run();
  // Insert the higher ID first, so ownership must follow lowest ID, not
  // insertion order, a JWT username, or a hard-coded user 1.
  const insert = db.prepare("INSERT INTO users (id, username, password) VALUES (?, ?, ?)");
  insert.run(otherId, "other", "unused-test-hash");
  insert.run(ownerId, "owner", "unused-test-hash");
  adapter.mockClear();
  dnsLookup.mockReset().mockRejectedValue(new Error("Unexpected DNS lookup in security test"));
});

afterAll(() => {
  httpClient.defaults.adapter = originalAdapter;
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("authenticated owner policy at real fixed-path connection tests", () => {
  it.each(privateBases)("lets the lowest-ID owner reach %s", async (url) => {
    expect(userStmts.findFirst.get()?.id).toBe(ownerId);
    const res = await testConnection(ownerId, url);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(adapter).toHaveBeenCalledTimes(1);
    const config = adapter.mock.calls[0]![0];
    expect(config.url).toBe(`${url}/api/v3/system/status`);
    expect(config.headers.get("X-Api-Key")).toBe("test-service-key");
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it.each(privateBases)("blocks a non-owner's default request to %s before transport", async (url) => {
    const res = await testConnection(otherId, url);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(adapter).not.toHaveBeenCalled();
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it.each(privateBases)("does not let explicit false weaken non-owner policy for %s", async (url) => {
    const res = await request(app).post("/policy-probe")
      .set("Authorization", auth(otherId)).send({ url, publicOnly: false });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("That destination is not allowed.");
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each(privateBases)("honors explicit publicOnly even for the owner at %s", async (url) => {
    const res = await request(app).post("/policy-probe")
      .set("Authorization", auth(ownerId)).send({ url, publicOnly: true });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("That destination is not allowed.");
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1", "http://169.254.169.254", "http://[::1]", "http://[fe80::1]"])(
    "does not grant the owner access to always-forbidden %s", async (url) => {
      expect((await testConnection(ownerId, url)).body.ok).toBe(false);
      expect(adapter).not.toHaveBeenCalled();
    },
  );
});

describe("hostname validation and DNS pinning under authenticated policy", () => {
  const deniedAnswers = [
    [{ address: "192.168.1.10", family: 4 }],
    [{ address: "100.64.0.5", family: 4 }],
    [{ address: "fd00::5", family: 6 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }],
    [{ address: "2001:4860:4860::8888", family: 6 }, { address: "fd00::5", family: 6 }],
  ];
  for (const publicOnly of [undefined, false]) {
    it.each(deniedAnswers.map((answers) => ({ answers })))(
      `rejects private/mixed DNS $answers with publicOnly=${publicOnly}`, async ({ answers }) => {
        dnsLookup.mockResolvedValue(answers);
        const res = await request(app).post("/policy-probe")
          .set("Authorization", auth(otherId))
          .send({ url: "http://service.example.test", publicOnly });
        expect(res.status).toBe(502);
        expect(res.body.error).toBe("That destination is not allowed.");
        expect(adapter).not.toHaveBeenCalled();
        expect(dnsLookup).toHaveBeenCalledExactlyOnceWith("service.example.test", { all: true, verbatim: true });
      },
    );
  }

  it("permits public DNS for a non-owner and pins every validated answer against rebinding", async () => {
    const answers = [
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ];
    dnsLookup.mockResolvedValueOnce(answers)
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const res = await testConnection(otherId, "https://public.example.test");
    expect(res.body.ok).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(1);
    expectPinned(adapter.mock.calls[0]![0], answers);
    expect(dnsLookup).toHaveBeenCalledExactlyOnceWith("public.example.test", { all: true, verbatim: true });
  });

  it("permits and pins the owner's private hostname", async () => {
    const answers = [{ address: "192.168.1.10", family: 4 }, { address: "fd00::5", family: 6 }];
    dnsLookup.mockResolvedValue(answers);
    expect((await testConnection(ownerId, "http://nas.example.test")).body.ok).toBe(true);
    expectPinned(adapter.mock.calls[0]![0], answers);
  });

  it("keeps concurrent owner and non-owner permissions isolated across delayed DNS", async () => {
    let releaseOwner!: (answers: Array<{ address: string; family: number }>) => void;
    let ownerStarted!: () => void;
    const started = new Promise<void>((resolve) => { ownerStarted = resolve; });
    dnsLookup.mockImplementation((host: string) => {
      if (host === "owner.example.test") {
        ownerStarted();
        return new Promise((resolve) => { releaseOwner = resolve; });
      }
      return Promise.resolve([{ address: "10.0.0.5", family: 4 }]);
    });
    const ownerRequest = testConnection(ownerId, "http://owner.example.test").then((res) => res);
    await started;
    try {
      expect((await testConnection(otherId, "http://other.example.test")).body.ok).toBe(false);
      expect(adapter).not.toHaveBeenCalled();
    } finally {
      releaseOwner([{ address: "10.0.0.5", family: 4 }]);
    }
    expect((await ownerRequest).body.ok).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls[0]![0].url).toBe("http://owner.example.test/api/v3/system/status");
    expect((await testConnection(otherId, "http://10.0.0.5")).body.ok).toBe(false);
    expect(outboundContext.getStore()).toBeUndefined();
  });
});

describe("missing, invalid, and deleted identities fail closed", () => {
  it("defaults to denying private destinations without any identity", async () => {
    expect(outboundContext.getStore()).toBeUndefined();
    await expect(httpClient.get("http://192.168.1.10/api/v3/system/status"))
      .rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(httpClient.get("http://192.168.1.10/api/v3/system/status", { ssrfPublicOnly: false }))
      .rejects.toThrow("That destination is not allowed.");
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each([0, -1, 999, 41.5, "41", null])("denies private access for signed invalid identity %s", async (id) => {
    const res = await testConnection(id as number, "http://192.168.1.10");
    expect(res.body.ok === false || res.status === 401).toBe(true);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("rejects missing and incorrectly signed tokens before transport", async () => {
    for (const authorization of ["", "Bearer invalid-token"]) {
      const res = await request(app).post("/api/connections/sonarr/test")
        .set("Authorization", authorization).send({ url: "http://10.0.0.5", apiKey: "test-key" });
      expect(res.status).toBe(401);
    }
    expect(adapter).not.toHaveBeenCalled();
  });

  it("revokes a deleted owner's signed token and derives the new owner from current rows", async () => {
    const oldToken = auth(ownerId);
    db.prepare("DELETE FROM users WHERE id = ?").run(ownerId);
    const res = await request(app).post("/api/connections/sonarr/test")
      .set("Authorization", oldToken).send({ url: "http://10.0.0.5", apiKey: "test-key" });
    expect(res.body.ok === false || res.status === 401).toBe(true);
    expect(adapter).not.toHaveBeenCalled();
    expect((await testConnection(otherId, "http://10.0.0.5")).body.ok).toBe(true);
  });

  it("denies all identities when the database has no users", async () => {
    db.prepare("DELETE FROM users").run();
    await expect(runAsOutboundUser(ownerId, () => httpClient.get("http://10.0.0.5/api/v3/system/status")))
      .rejects.toThrow("That destination is not allowed.");
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe("production widget and background entry points propagate owner context", () => {
  it.each([
    ["https://news.google.com/rss/search?q=homelab&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=homelab&hl=en-US&gl=US&ceid=US:en"],
    ["https://feeds.example.test/index.php?format=feed&type=rss",
      "https://feeds.example.test/index.php?format=feed&type=rss"],
    ["feeds.example.test/rss/?category=homelab&path=/",
      "http://feeds.example.test/rss/?category=homelab&path=/"],
  ])("preserves a complete News feed URL with queries: %s", async (url, expectedUrl) => {
    dnsLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    adapter.mockImplementationOnce(async (config) => ({
      data: '<?xml version="1.0"?><rss version="2.0"><channel><title>Query feed</title>'
        + "<item><title>Homelab news</title></item></channel></rss>",
      status: 200, statusText: "OK", headers: {}, config,
    }));
    const res = await request(app).get("/api/widgets/news").query({ url })
      .set("Authorization", auth(otherId));
    expect(res.status).toBe(200);
    expect(res.body.feedTitle).toBe("Query feed");
    expect(res.body.items[0].title).toBe("Homelab news");
    expect(adapter).toHaveBeenCalledTimes(1);
    const config = adapter.mock.calls[0]![0];
    expect(config.url).toBe(expectedUrl);
    expect(config.ssrfPublicOnly).toBe(true);
    expectPinned(config, [{ address: "8.8.8.8", family: 4 }]);
  });

  it.each([ownerId, otherId])("still blocks private query-bearing News feeds for account %s", async (userId) => {
    const res = await request(app).get("/api/widgets/news")
      .query({ url: "http://192.168.1.10/index.php?format=feed&type=rss" })
      .set("Authorization", auth(userId));
    expect(res.status).toBe(502);
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each([ownerId, otherId])("applies account %s policy to real TrueNAS diagnostic probes", async (userId) => {
    saveConnection(userId, "truenas", "http://192.168.1.10");
    const res = await request(app).get("/api/widgets/truenas/diagnostics").set("Authorization", auth(userId));
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    if (userId === ownerId) {
      expect(adapter.mock.calls.length).toBeGreaterThan(1);
      expect(adapter.mock.calls.every(([config]) =>
        config.url?.startsWith("http://192.168.1.10/api/v2.0/"))).toBe(true);
    } else {
      expect(JSON.stringify(res.body)).toContain("That destination is not allowed.");
      expect(adapter).not.toHaveBeenCalled();
    }
  });

  it.each([ownerId, otherId])("applies account %s policy to ErsatzTV query-token stream auth", async (userId) => {
    saveConnection(userId, "ersatztv", "http://100.64.0.5:8409");
    const res = await request(app).get("/api/widgets/ersatztv/stream/iptv/channel/1.m3u8")
      .query({ token: token(userId) });
    expect(res.status).toBe(userId === ownerId ? 200 : 502);
    if (userId === ownerId) {
      expect(res.text).toContain("#EXTM3U");
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(adapter.mock.calls[0]![0].url).toBe("http://100.64.0.5:8409/iptv/channel/1.m3u8");
    } else {
      expect(adapter).not.toHaveBeenCalled();
    }
  });

  it("runs real scheduler pings per user, persisting owner success and non-owner failure", async () => {
    saveConnection(ownerId, "sonarr", "http://192.168.1.10:8989");
    saveConnection(otherId, "sonarr", "http://192.168.1.10:8989");
    saveConnection(otherId, "radarr", "https://public.example.test");
    dnsLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    // An ambient owner context must not accidentally authorize every job.
    await runAsOutboundUser(ownerId, () => runHealthChecks());
    expect(healthStmts.findAllByUser.all(ownerId)).toEqual([
      expect.objectContaining({ service: "sonarr", ok: 1 }),
    ]);
    expect(healthStmts.findAllByUser.all(otherId)).toEqual([
      expect.objectContaining({ service: "radarr", ok: 1 }),
      expect.objectContaining({ service: "sonarr", ok: 0 }),
    ]);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(adapter.mock.calls.map(([config]) => config.url).sort()).toEqual([
      "http://192.168.1.10:8989/api/v3/system/status",
      "https://public.example.test/api/v3/system/status",
    ]);
    expect(outboundContext.getStore()).toBeUndefined();
  });
});