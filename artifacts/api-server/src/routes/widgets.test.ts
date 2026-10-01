import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Replace the auth middleware with a pass-through so we can exercise the routes
// without minting a real JWT.
vi.mock("../lib/auth.js", () => ({
  requireAuth: (req: { user?: { userId: number }; headers: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.user = { userId: Number(req.headers["x-test-user"] ?? 1) };
    next();
  },
}));

// Stub the DB layer so no real SQLite file is opened and we can dictate, per
// test, whether a service is "configured" (has a stored connection row).
const findByService = vi.fn();
const upsertRun = vi.fn();
vi.mock("../lib/db.js", () => ({
  connectionStmts: {
    findByService: { get: (...args: unknown[]) => findByService(...args) },
    upsert: { run: (...args: unknown[]) => upsertRun(...args) },
  },
  healthStmts: {},
}));

// Stub the shared axios instance so we control every upstream HTTP response and
// never hit the network.
const httpGet = vi.fn();
const httpPost = vi.fn();
const httpPut = vi.fn();
const httpDelete = vi.fn();
// Tailscale (and other cloud-only services) use the TLS-verifying cloud client.
const cloudGet = vi.fn();
const cloudPost = vi.fn();
vi.mock("../lib/http.js", () => ({
  HTTP_TIMEOUT: 1000,
  httpClient: {
    get: (...args: unknown[]) => httpGet(...args),
    post: (...args: unknown[]) => httpPost(...args),
    put: (...args: unknown[]) => httpPut(...args),
    delete: (...args: unknown[]) => httpDelete(...args),
  },
  cloudHttpClient: {
    get: (...args: unknown[]) => cloudGet(...args),
    post: (...args: unknown[]) => cloudPost(...args),
  },
  normalizeBaseUrl: (url: string | undefined | null) => {
    const trimmed = url?.trim();
    if (!trimmed) return undefined;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    return withScheme.replace(/\/+$/, "");
  },
  normalizeHttpError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  describeHttpError: (err: unknown) => {
    const e = err as { isAxiosError?: boolean; code?: string; message?: string; response?: { status?: number; data?: unknown } };
    if (e?.isAxiosError) {
      return {
        status: e.response?.status ?? null,
        code: e.code ?? null,
        message: e.message ?? "",
        body: e.response?.data ?? null,
      };
    }
    if (err instanceof Error) return { status: null, code: null, message: err.message, body: null };
    return { status: null, code: null, message: String(err), body: null };
  },
}));

// Keep the logger quiet during tests.
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Stub the game-server player query so no real UDP/TCP game protocol traffic
// happens (gamedig would otherwise time out slowly). guessGameType stays real.
const queryGamePlayers = vi.fn();
vi.mock("../lib/gameQuery.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/gameQuery.js")>();
  return {
    ...real,
    queryGamePlayers: (...args: unknown[]) => queryGamePlayers(...args),
    queryGamePlayersDetailed: (...args: unknown[]) => queryGamePlayersDetailed(...args),
  };
});
// Detailed variant used by the pterodactyl widget: structured result with a
// failure reason. Defaults to a timeout so unstubbed tests never hang.
const queryGamePlayersDetailed = vi.fn();

// Imported after the mocks are registered (vi.mock is hoisted above imports).
const { default: widgetsRouter } = await import("./widgets.js");
const { default: connectionsRouter } = await import("./connections.js");
// The fetch cache is real (not mocked) — weather tests invalidate their keys
// so entries never leak between tests.
const { invalidateFetchCache } = await import("../lib/fetchCache.js");

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/widgets", widgetsRouter);
  app.use("/connections", connectionsRouter);
  return app;
}

// Build a stored-connection row as the DB layer would return it.
function connRow(overrides: Record<string, unknown> = {}) {
  return {
    service: "x",
    url: null,
    api_key: null,
    username: null,
    password: null,
    extra: null,
    updated_at: "now",
    ...overrides,
  };
}

const app = makeApp();

// An axios-style error carrying an HTTP status (used to assert 502 behavior).
function httpError(status = 500): Error {
  return Object.assign(new Error(`status ${status}`), {
    response: { status },
  });
}

beforeEach(() => {
  findByService.mockReset();
  upsertRun.mockReset();
  httpGet.mockReset();
  httpPost.mockReset();
  httpPut.mockReset();
  httpDelete.mockReset();
  cloudGet.mockReset();
  cloudPost.mockReset();
  httpDelete.mockResolvedValue({ data: {} });
  queryGamePlayers.mockReset();
  queryGamePlayersDetailed.mockReset();
  // Default: the game query fails with a timeout so unstubbed tests get the
  // additive "no players + reason" path instead of hanging on real gamedig.
  queryGamePlayersDetailed.mockResolvedValue({ players: null, reason: "timeout", detail: "stubbed" });
  // Default: every service is unconfigured unless a test says otherwise.
  findByService.mockReturnValue(undefined);
});

describe("saved connection credential isolation", () => {
  // These are synthetic secrets, never the deployment's actual credentials.
  const services = [
    ["truenas", "TRUENAS", "/truenas"],
    ["truenas", "TRUENAS", "/truenas/diagnostics"],
    ["sonarr", "SONARR", "/sonarr"],
    ["radarr", "RADARR", "/radarr"],
    ["lidarr", "LIDARR", "/lidarr"],
    ["pihole", "PIHOLE", "/pihole"],
    ["prowlarr", "PROWLARR", "/prowlarr"],
    ["pterodactyl", "PTERODACTYL", "/pterodactyl"],
    ["pterodactyl", "PTERODACTYL", "/pterodactyl/diagnostics"],
    ["tailscale", "TAILSCALE", "/tailscale"],
    ["qbittorrent", "QBITTORRENT", "/qbittorrent"],
    ["nginx-proxy-manager", "NPM", "/nginx-proxy-manager"],
    ["plex", "MEDIA_SERVER", "/media?server=plex"],
    ["jellyfin", "MEDIA_SERVER", "/media?server=jellyfin"],
    ["plex", "MEDIA_SERVER", "/media/continue?server=plex"],
    ["jellyfin", "MEDIA_SERVER", "/media/continue?server=jellyfin"],
    ["plex", "MEDIA_SERVER", "/audioplayer?source=plex"],
    ["jellyfin", "MEDIA_SERVER", "/audioplayer?source=jellyfin"],
  ] as const;

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["sonarr", "SONARR"],
    ["qbittorrent", "QBITTORRENT"],
    ["nginx-proxy-manager", "NPM"],
  ])("does not borrow deployment credentials after PUT saves a partial %s connection", async (service, prefix) => {
    vi.stubEnv(`${prefix}_URL`, "https://deployment.example");
    vi.stubEnv(`${prefix}_API_KEY`, "synthetic-shared-key");
    vi.stubEnv(`${prefix}_USERNAME`, "synthetic-shared-user");
    vi.stubEnv(`${prefix}_EMAIL`, "synthetic-shared-email");
    vi.stubEnv(`${prefix}_PASSWORD`, "synthetic-shared-password");
    let row: ReturnType<typeof connRow> | undefined;
    findByService.mockImplementation((userId, name) => userId === 91 && name === service ? row : undefined);
    upsertRun.mockImplementation((userId, name, url, apiKey, username, password, extra) => {
      expect(userId).toBe(91);
      expect(name).toBe(service);
      row = connRow({ service: name, url, api_key: apiKey, username, password, extra });
    });
    const saved = await request(app).put(`/connections/${service}`).set("x-test-user", "91")
      .send({ url: "https://attacker.example", username: "own-login" });
    expect(saved.status).toBe(200);
    expect(saved.body.apiKey).toBeNull();
    expect(saved.body.password).toBeNull();
    expect((await request(app).get(`/widgets/${service}`).set("x-test-user", "91")).status).toBe(200);
    expect(httpGet).not.toHaveBeenCalled();
    expect(httpPost).not.toHaveBeenCalled();
  });

  it.each(services)("does not send shared secrets for a saved %s URL (%s, %s)", async (service, prefix, path) => {
    vi.stubEnv(`${prefix}_URL`, "https://deployment.example");
    vi.stubEnv(`${prefix}_API_KEY`, "synthetic-shared-key");
    vi.stubEnv(`${prefix}_USERNAME`, "synthetic-shared-user");
    vi.stubEnv(`${prefix}_EMAIL`, "synthetic-shared-email");
    vi.stubEnv(`${prefix}_PASSWORD`, "synthetic-shared-password");
    vi.stubEnv("TAILSCALE_TAILNET", "synthetic-shared-tailnet");
    if (prefix === "MEDIA_SERVER") vi.stubEnv("MEDIA_SERVER_TYPE", service);
    findByService.mockImplementation((_userId, name) =>
      name === service ? connRow({ service, url: "https://attacker.example" }) : undefined,
    );
    httpGet.mockResolvedValue({ data: [] });
    cloudGet.mockResolvedValue({ data: [] });
    httpPost.mockResolvedValue({ data: {}, headers: {} });

    const res = await request(app).get(`/widgets${path}`);
    expect(res.status).not.toBe(500);
    const outbound = JSON.stringify([
      httpGet.mock.calls, httpPost.mock.calls, httpPut.mock.calls,
      httpDelete.mock.calls, cloudGet.mock.calls, cloudPost.mock.calls,
    ]);
    expect(outbound).not.toContain("synthetic-shared-");
    expect(outbound).not.toContain("deployment.example");
  });

  it.each(["api_key", "username", "password", "extra"])(
    "does not complete a saved %s with an environment endpoint or secret",
    async (field) => {
      vi.stubEnv("SONARR_URL", "https://deployment.example");
      vi.stubEnv("SONARR_API_KEY", "synthetic-shared-key");
      findByService.mockReturnValue(connRow({
        [field]: field === "extra" ? JSON.stringify({ token: "own-token" }) : "own-value",
      }));
      await request(app).get("/widgets/sonarr");
      expect(httpGet).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, connRow()])("retains whole environment fallback for an empty connection", async (row) => {
    vi.stubEnv("SONARR_URL", "https://deployment.example");
    vi.stubEnv("SONARR_API_KEY", "synthetic-shared-key");
    findByService.mockReturnValue(row);
    httpGet.mockResolvedValue({ data: [] });
    const res = await request(app).get("/widgets/sonarr");
    expect(res.status).toBe(200);
    expect(httpGet).toHaveBeenCalled();
    for (const [url, options] of httpGet.mock.calls) {
      expect(url).toContain("https://deployment.example/");
      expect(options.headers["X-Api-Key"]).toBe("synthetic-shared-key");
    }
  });

  it("uses only a complete saved connection even when environment settings exist", async () => {
    vi.stubEnv("SONARR_URL", "https://deployment.example");
    vi.stubEnv("SONARR_API_KEY", "synthetic-shared-key");
    findByService.mockReturnValue(connRow({ url: "https://own.example/", api_key: "own-key" }));
    httpGet.mockResolvedValue({ data: [] });
    expect((await request(app).get("/widgets/sonarr")).status).toBe(200);
    for (const [url, options] of httpGet.mock.calls) {
      expect(url).toContain("https://own.example/");
      expect(options.headers["X-Api-Key"]).toBe("own-key");
    }
  });
});

describe("upstream session isolation", () => {
  const cases = ["qbittorrent", "nginx-proxy-manager"] as const;

  function configure(service: typeof cases[number], suffix: string) {
    const url = `https://${service}-${suffix}.example`;
    let password = "correct-password";
    findByService.mockImplementation((_userId, name) =>
      name === service ? connRow({ service, url, username: "known-login", password }) : undefined,
    );
    httpPost.mockResolvedValue(service === "qbittorrent"
      ? { data: "Ok.", headers: { "set-cookie": ["SID=victim; path=/"] } }
      : { data: { token: "victim-token", expires: new Date(Date.now() + 3600_000).toISOString() } });
    httpGet.mockResolvedValue({ data: [] });
    return {
      setPassword(value: string) { password = value; },
      rejectLogin() {
        httpPost.mockResolvedValue(service === "qbittorrent"
          ? { data: "Fails.", headers: {} }
          : { data: {} });
      },
    };
  }

  it.each(cases)("%s reuses a session only for the same user and credentials", async (service) => {
    configure(service, "reuse");
    expect((await request(app).get(`/widgets/${service}`).set("x-test-user", "71")).status).toBe(200);
    expect((await request(app).get(`/widgets/${service}`).set("x-test-user", "71")).status).toBe(200);
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect((await request(app).get(`/widgets/${service}`).set("x-test-user", "72")).status).toBe(200);
    expect(httpPost).toHaveBeenCalledTimes(2);
    expect(findByService).toHaveBeenCalledWith(72, service);
  });

  it.each(cases)("%s does not let another user with a wrong password reuse the victim session", async (service) => {
    const fixture = configure(service, "cross-user");
    expect((await request(app).get(`/widgets/${service}`).set("x-test-user", "81")).status).toBe(200);
    fixture.setPassword("wrong-password");
    fixture.rejectLogin();
    httpGet.mockClear();
    const res = await request(app).get(`/widgets/${service}`).set("x-test-user", "82");
    expect(res.status).toBe(502);
    expect(httpPost).toHaveBeenCalledTimes(2);
    expect(httpGet).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("victim");
  });

  it.each(cases)("%s reauthenticates after the same user's password changes", async (service) => {
    const fixture = configure(service, "changed-password");
    expect((await request(app).get(`/widgets/${service}`)).status).toBe(200);
    fixture.setPassword("wrong-password");
    fixture.rejectLogin();
    httpGet.mockClear();
    expect((await request(app).get(`/widgets/${service}`)).status).toBe(502);
    expect(httpPost).toHaveBeenCalledTimes(2);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("locally expires a qBittorrent session even if upstream never rejects it", async () => {
    configure("qbittorrent", "local-expiry");
    expect((await request(app).get("/widgets/qbittorrent")).status).toBe(200);
    const later = Date.now() + 24 * 3600_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect((await request(app).get("/widgets/qbittorrent")).status).toBe(200);
      expect(httpPost).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("Finnhub TLS-verified requests", () => {
  beforeEach(() => {
    findByService.mockImplementation((_userId, service) =>
      service === "stocks" ? connRow({ service, api_key: "test-finnhub-key" }) : undefined,
    );
  });

  it("fetches quotes and company profiles only through the cloud client", async () => {
    cloudGet.mockResolvedValueOnce({ data: { c: 123, d: 2, dp: 1.65 } });
    cloudGet.mockResolvedValueOnce({ data: { name: "Apple Inc" } });

    const res = await request(app).get("/widgets/stocks?symbols=AAPL");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      quotes: [{ symbol: "AAPL", name: "Apple Inc", price: 123, change: 2, changePercent: 1.65 }],
      sample: false,
    });
    for (const path of ["quote", "stock/profile2"]) {
      expect(cloudGet).toHaveBeenCalledWith(`https://finnhub.io/api/v1/${path}`, {
        params: { symbol: "AAPL", token: "test-finnhub-key" },
      });
    }
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("fetches candles only through the cloud client", async () => {
    cloudGet.mockResolvedValue({ data: { s: "ok", c: [120, 121, 123] } });
    const res = await request(app).get("/widgets/stocks/candles?symbols=AAPL");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ series: [{ symbol: "AAPL", closes: [120, 121, 123] }], sample: false });
    expect(cloudGet).toHaveBeenCalledWith("https://finnhub.io/api/v1/stock/candle", {
      params: { symbol: "AAPL", token: "test-finnhub-key", resolution: "D", from: expect.any(Number), to: expect.any(Number) },
    });
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("searches only through the cloud client", async () => {
    cloudGet.mockResolvedValue({ data: { result: [{ symbol: "AAPL", description: "Apple Inc" }] } });
    const res = await request(app).get("/widgets/stocks/search?q=Apple");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [{ symbol: "AAPL", description: "Apple Inc" }], sample: false });
    expect(cloudGet).toHaveBeenCalledWith("https://finnhub.io/api/v1/search", {
      params: { q: "Apple", token: "test-finnhub-key" },
    });
    expect(httpGet).not.toHaveBeenCalled();
  });

  it.each([
    "/widgets/stocks?symbols=AAPL",
    "/widgets/stocks/candles?symbols=AAPL",
    "/widgets/stocks/search?q=Apple",
  ])("does not retry certificate failures through the insecure client: %s", async (path) => {
    cloudGet.mockRejectedValue(new Error("self-signed certificate"));
    const res = await request(app).get(path);
    expect(res.status).toBe(502);
    expect(cloudGet).toHaveBeenCalledTimes(1);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("keeps profile failures optional without retrying insecurely", async () => {
    cloudGet.mockResolvedValueOnce({ data: { c: 123 } });
    cloudGet.mockRejectedValueOnce(new Error("self-signed certificate"));
    const res = await request(app).get("/widgets/stocks?symbols=AAPL");
    expect(res.status).toBe(200);
    expect(res.body.quotes[0].name).toBeNull();
    expect(cloudGet).toHaveBeenCalledTimes(2);
    expect(httpGet).not.toHaveBeenCalled();
  });
});

// ── TrueNAS ─────────────────────────────────────────────────────────────────
describe("GET /widgets/truenas", () => {
  it("returns sample data when unconfigured", async () => {
    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.cpuPercent).toBe(12.4);
    expect(res.body.pools).toHaveLength(2);
    // Sample disks include a hot, SMART-failed drive so the tile preview shows
    // the degraded styling without a live connection.
    expect(res.body.disks).toHaveLength(3);
    expect(res.body.disks.some((d: { smartPassed: boolean | null }) => d.smartPassed === false)).toBe(true);
    // No upstream calls should be made for sample data.
    expect(httpGet).not.toHaveBeenCalled();
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("normalizes live data: CPU = 100 - idle, memory buckets, pool capacity", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );

    // reporting/get_data → POST. The real response puts "time" first in the
    // legend and each data row is aligned to that full legend (timestamp first).
    // CPU legend includes idle=80 (→ 20% used). Memory values are in bytes; total
    // is the sum of present buckets.
    httpPost.mockResolvedValue({
      data: [
        {
          name: "cpu",
          legend: ["time", "user", "system", "idle"],
          data: [[1000, 15, 5, 80]],
        },
        {
          name: "memory",
          legend: ["time", "used", "free", "cached", "buffers"],
          data: [[1000, 8e9, 4e9, 3e9, 1e9]],
        },
      ],
    });
    // pool → GET. Capacity summed from the data vdev stats.
    httpGet.mockResolvedValue({
      data: [
        {
          name: "tank",
          status: "ONLINE",
          topology: {
            data: [{ stats: { allocated: 2e12, size: 10e12 } }],
          },
        },
      ],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.cpuPercent).toBe(20); // 100 - 80
    expect(res.body.memUsedGb).toBe(8); // 8e9 bytes / 1e9
    expect(res.body.memTotalGb).toBe(16); // (8+4+3+1)e9 / 1e9
    expect(res.body.pools).toEqual([
      { name: "tank", status: "ONLINE", usedBytes: 2e12, totalBytes: 10e12 },
    ]);

    // Reporting must be a POST with the graphs query and integer unix-timestamp
    // start/end (the modern Netdata backend rejects relative "now-30s" strings).
    // The window must end slightly in the past, not at "now" (the latest samples
    // aren't collected yet), so `end` is strictly before the current second.
    const [, postBody] = httpPost.mock.calls[0]!;
    expect(postBody.graphs).toEqual([{ name: "cpu" }, { name: "memory" }]);
    expect(Number.isInteger(postBody.query.start)).toBe(true);
    expect(Number.isInteger(postBody.query.end)).toBe(true);
    expect(postBody.query.end).toBeGreaterThan(postBody.query.start);
    expect(postBody.query.end).toBeLessThan(Math.floor(Date.now() / 1000));
    expect(postBody.query.aggregate).toBe(true);
  });

  it("parses SCALE 25.10 shapes: aggregate cpu column + available-only memory", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    // 25.10's cpu graph reports an aggregate "cpu" usage column (+ per-core cpuN),
    // and the memory graph reports ONLY available bytes — so total RAM must come
    // from system/info (physmem) and used = total - available.
    // SCALE 25.10 returns aggregations.mean as an OBJECT keyed by legend name
    // (not a positional array), so the parser must read the aggregate from there.
    mockTruenasReporting({
      core: [
        {
          name: "cpu",
          legend: ["time", "cpu", "cpu0", "cpu1"],
          data: [[1000, 3.5, 4, 1]],
          aggregations: { mean: { cpu: 3.5, cpu0: 4, cpu1: 1 } },
        },
        {
          name: "memory",
          legend: ["time", "available"],
          data: [[1000, 9e9]],
          aggregations: { mean: { available: 9e9 } },
        },
      ],
    });
    mockTruenasGets({ pool: [], systemInfo: { physmem: 32e9 } });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.cpuPercent).toBe(3.5); // aggregate "cpu" column, not 100 - idle
    expect(res.body.memTotalGb).toBe(32); // physmem from system/info
    expect(res.body.memUsedGb).toBe(23); // (32e9 - 9e9) / 1e9
  });

  it("renders pool data when only reporting fails (partial)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    httpPost.mockRejectedValue(httpError(422)); // modern backend rejected the query
    httpGet.mockResolvedValue({
      data: [
        {
          name: "tank",
          status: "ONLINE",
          topology: { data: [{ stats: { allocated: 2e12, size: 10e12 } }] },
        },
      ],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    // Reporting missing → zeroed CPU/RAM, but pools still render.
    expect(res.body.cpuPercent).toBe(0);
    expect(res.body.memUsedGb).toBe(0);
    expect(res.body.memTotalGb).toBe(0);
    expect(res.body.pools).toEqual([
      { name: "tank", status: "ONLINE", usedBytes: 2e12, totalBytes: 10e12 },
    ]);
  });

  it("renders CPU/RAM when only the pool call fails (partial)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    httpPost.mockResolvedValue({
      data: [
        { name: "cpu", legend: ["time", "user", "idle"], data: [[1000, 20, 80]] },
        { name: "memory", legend: ["time", "used", "free"], data: [[1000, 8e9, 8e9]] },
      ],
    });
    httpGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.cpuPercent).toBe(20);
    expect(res.body.memUsedGb).toBe(8);
    expect(res.body.pools).toEqual([]);
  });

  it("prefers aggregated mean over the last data row", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    // `aggregations.mean` excludes the "time" column, so [10, 70] maps to
    // user=10, idle=70 against the time-stripped legend.
    httpPost.mockResolvedValue({
      data: [
        {
          name: "cpu",
          legend: ["time", "user", "idle"],
          data: [[1000, 1, 1]],
          aggregations: { mean: [10, 70] },
        },
        { name: "memory", legend: ["time", "used", "free"], data: [[1000, 1e9, 1e9]] },
      ],
    });
    httpGet.mockResolvedValue({ data: [] });

    const res = await request(app).get("/widgets/truenas");
    expect(res.body.cpuPercent).toBe(30); // 100 - 70 (from mean)
  });

  it("returns 502 on upstream failure (no mock fallback)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    httpPost.mockRejectedValue(httpError(500));
    httpGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/TrueNAS/);
  });

  // Route GET responses by URL so the pool, disk-inventory and SMART-results
  // calls each return their own payload.
  function mockTruenasGets(opts: {
    pool?: unknown;
    poolError?: Error;
    disk?: unknown;
    diskError?: Error;
    smart?: unknown;
    smartError?: Error;
    graphs?: unknown;
    systemInfo?: unknown;
  }) {
    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/api/v2.0/pool")) {
        return opts.poolError ? Promise.reject(opts.poolError) : Promise.resolve({ data: opts.pool ?? [] });
      }
      if (url.endsWith("/api/v2.0/disk")) {
        return opts.diskError ? Promise.reject(opts.diskError) : Promise.resolve({ data: opts.disk ?? [] });
      }
      if (url.endsWith("/api/v2.0/smart/test/results")) {
        return opts.smartError ? Promise.reject(opts.smartError) : Promise.resolve({ data: opts.smart ?? [] });
      }
      if (url.endsWith("/api/v2.0/reporting/graphs")) {
        return Promise.resolve({ data: opts.graphs ?? [] });
      }
      if (url.endsWith("/api/v2.0/system/info")) {
        return Promise.resolve({ data: opts.systemInfo ?? {} });
      }
      return Promise.resolve({ data: [] });
    });
  }

  it("merges disk temperatures with SMART test results into per-disk health", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    httpPost.mockResolvedValue({
      data: [
        { name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] },
        { name: "memory", legend: ["time", "used", "free"], data: [[1000, 1e9, 1e9]] },
      ],
    });
    mockTruenasGets({
      pool: [],
      disk: [
        { name: "sda", temperature: 34 },
        { name: "sdb", temperature: 55 },
      ],
      smart: [
        { disk: "sda", tests: [{ status: "SUCCESS" }] },
        { disk: "sdb", tests: [{ status: "RUNNING" }, { status: "FAILED" }] },
      ],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.disks).toEqual([
      { name: "sda", temperatureC: 34, smartPassed: true },
      { name: "sdb", temperatureC: 55, smartPassed: false },
    ]);
  });

  it("reads live temperatures from the dedicated /disk/temperatures endpoint", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    // The inventory carries NO temperature; live temps come from the POST endpoint.
    httpPost.mockImplementation((url: string) => {
      if (url.endsWith("/api/v2.0/disk/temperatures")) {
        return Promise.resolve({ data: { sda: 34, nvme0n1: 41, sdb: null } });
      }
      // reporting/get_data (core + extras) and anything else → reporting shape.
      return Promise.resolve({
        data: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      });
    });
    mockTruenasGets({
      pool: [],
      disk: [{ name: "sda" }, { name: "nvme0n1" }, { name: "sdb" }],
      smart: [{ disk: "sda", tests: [{ status: "SUCCESS" }] }],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.disks).toEqual([
      { name: "sda", temperatureC: 34, smartPassed: true },
      { name: "nvme0n1", temperatureC: 41, smartPassed: null },
      // null temperature from the endpoint → unknown ("--").
      { name: "sdb", temperatureC: null, smartPassed: null },
    ]);
    // The temperatures endpoint was queried with the resolved disk names.
    const tempCall = httpPost.mock.calls.find((c) =>
      String(c[0]).endsWith("/api/v2.0/disk/temperatures"),
    );
    expect(tempCall).toBeDefined();
    expect((tempCall![1] as { names: string[] }).names).toEqual(["sda", "nvme0n1", "sdb"]);
  });

  it("leaves temperature null when /disk/temperatures fails (additive, no 502)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    httpPost.mockImplementation((url: string) => {
      if (url.endsWith("/api/v2.0/disk/temperatures")) {
        return Promise.reject(httpError(500)); // temperatures endpoint unavailable
      }
      return Promise.resolve({
        data: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 60]] }],
      });
    });
    // Inventory has names but no temperature fields → temp is fully unknown.
    mockTruenasGets({
      pool: [],
      disk: [{ name: "sda" }, { name: "sdb" }],
      smart: [{ disk: "sda", tests: [{ status: "SUCCESS" }] }],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200); // disk-health failure never blanks the tile
    expect(res.body.disks).toEqual([
      { name: "sda", temperatureC: null, smartPassed: true },
      { name: "sdb", temperatureC: null, smartPassed: null },
    ]);
  });

  it("reports unknown SMART/temperature as null without dropping the disk", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    httpPost.mockResolvedValue({
      data: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 90]] }],
    });
    // Temperatures available, SMART call failed entirely → smartPassed null.
    mockTruenasGets({
      pool: [],
      disk: [{ name: "sda", temperature: 30 }, { name: "sdc" }],
      smartError: httpError(500),
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.disks).toEqual([
      { name: "sda", temperatureC: 30, smartPassed: null },
      { name: "sdc", temperatureC: null, smartPassed: null },
    ]);
  });

  it("reports live CPU temperature (hottest core) from the cputemp graph", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      cpuDiskTemp: [
        {
          name: "cputemp",
          legend: ["time", "cpu0", "cpu1", "cpu2", "cpu3"],
          data: [[1000, 45, 47, 44, 46]],
        },
      ],
    });
    mockTruenasGets({ pool: [], disk: [], smart: [] });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.cpuTempC).toBe(47); // hottest core
    expect(res.body.cpuTempCoresC).toEqual([45, 47, 44, 46]);
  });

  it("leaves CPU temperature null when no cputemp sensor is reported (additive, no 502)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      // Sensorless box: the graph exists but every core reads a non-positive 0.
      cpuDiskTemp: [
        { name: "cputemp", legend: ["time", "cpu0", "cpu1"], data: [[1000, 0, 0]] },
      ],
    });
    mockTruenasGets({ pool: [], disk: [], smart: [] });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.cpuTempC).toBeNull();
    expect(res.body.cpuTempCoresC).toEqual([]);
  });

  it("leaves CPU temperature null when the cputemp reporting call fails (additive, no 502)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      cpuDiskTempError: httpError(422), // one bad graph name 422s the whole batch
    });
    mockTruenasGets({ pool: [], disk: [], smart: [] });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200); // temperature failure never blanks the tile
    expect(res.body.cpuTempC).toBeNull();
    expect(res.body.cpuTempCoresC).toEqual([]);
    expect(res.body.cpuPercent).toBe(20); // core CPU/RAM still render
  });

  it("falls back to the disktemp graph when /disk/temperatures has no value", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      // The dedicated endpoint knows sda but not sdb (null → unknown).
      diskTemps: { sda: 34, sdb: null },
      // The disktemp reporting graph fills the gap for sdb.
      cpuDiskTemp: [
        { name: "disktemp", legend: ["time", "sda", "sdb"], data: [[1000, 33, 41]] },
      ],
    });
    mockTruenasGets({
      pool: [],
      disk: [{ name: "sda" }, { name: "sdb" }],
      smart: [{ disk: "sda", tests: [{ status: "SUCCESS" }] }],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.disks).toEqual([
      // Dedicated endpoint wins for sda; graph fills sdb.
      { name: "sda", temperatureC: 34, smartPassed: true },
      { name: "sdb", temperatureC: 41, smartPassed: null },
    ]);
  });

  it("fetches disk temperatures BY identifier when the endpoint 400s and the name-only graph is empty (newer SCALE)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      // Newer SCALE rejects the dedicated endpoint outright...
      diskTempsError: Object.assign(new Error("400"), {
        response: { status: 400, data: "attributes are not expected: names, powermode" },
      }),
      // ...and a name-only disktemp reporting request returns nothing.
      cpuDiskTemp: [{ name: "cputemp", legend: ["time", "cpu0"], data: [[1000, 61]] }],
      // The identifier-scoped disktemp call is the reliable source. Each entry
      // echoes its identifier and carries one value column beside "time".
      diskTempById: [
        {
          name: "disktemp",
          identifier: "sda | Type: HDD | Model: X | Serial: A1",
          legend: ["time", "temperature"],
          data: [[1000, 36]],
        },
        {
          name: "disktemp",
          identifier: "sdb | Type: SSD | Model: Y | Serial: B2",
          legend: ["time", "temperature"],
          data: [[1000, 44]],
        },
      ],
    });
    mockTruenasGets({
      pool: [],
      disk: [{ name: "sda" }, { name: "sdb" }],
      // reporting/graphs advertises the per-disk disktemp identifiers.
      graphs: [
        {
          name: "disktemp",
          identifiers: [
            "sda | Type: HDD | Model: X | Serial: A1",
            "sdb | Type: SSD | Model: Y | Serial: B2",
          ],
        },
      ],
      smart: [],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.disks).toEqual([
      { name: "sda", temperatureC: 36, smartPassed: null },
      { name: "sdb", temperatureC: 44, smartPassed: null },
    ]);
  });

  it("coerces numeric-string and nested-object disk temperature shapes", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      // Some SCALE versions return a numeric string or a nested object here.
      diskTemps: { sda: "34", sdb: { temperature_c: 41 }, sdc: "n/a" },
    });
    mockTruenasGets({
      pool: [],
      disk: [{ name: "sda" }, { name: "sdb" }, { name: "sdc" }],
      smart: [],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.disks).toEqual([
      { name: "sda", temperatureC: 34, smartPassed: null },
      { name: "sdb", temperatureC: 41, smartPassed: null },
      // Non-numeric string → unknown ("--").
      { name: "sdc", temperatureC: null, smartPassed: null },
    ]);
  });

  it("returns empty disks when the disk inventory call fails (additive, no 502)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    httpPost.mockResolvedValue({
      data: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 70]] }],
    });
    mockTruenasGets({
      pool: [{ name: "tank", status: "ONLINE", topology: { data: [{ stats: { allocated: 1e12, size: 2e12 } }] } }],
      diskError: httpError(500),
      smart: [{ disk: "sda", tests: [{ status: "SUCCESS" }] }],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.pools).toHaveLength(1); // pool still renders
    expect(res.body.disks).toEqual([]); // no inventory → nothing to show
  });

  // Route the two reporting POSTs by their requested graph names: the core call
  // asks for cpu/memory, the extras call asks for interface/arcsize/ARC hit %.
  // Three POST shapes hit get_data: the core cpu/memory call, the core extras
  // (interface + arcsize), and the ARC hit-ratio call (arcresult/arcrate/...).
  // The latter two ride SEPARATE calls so one cannot 422 the other.
  const ARC_HIT_NAMES = [
    "arcresult",
    "arcrate",
    "arcactualrate",
    "demanddatahitpercentage",
    "demandmetadatahitpercentage",
  ];
  function mockTruenasReporting(opts: {
    core?: unknown;
    coreError?: Error;
    extras?: unknown;
    extrasError?: Error;
    arcHit?: unknown;
    arcHitError?: Error;
    cpuDiskTemp?: unknown;
    cpuDiskTempError?: Error;
    diskTemps?: unknown;
    diskTempsError?: Error;
    diskTempById?: unknown;
    diskTempByIdError?: Error;
  }) {
    httpPost.mockImplementation(
      (url: string, body: { graphs?: Array<{ name?: string; identifier?: string }> }) => {
        // The dedicated disk-temperature endpoint is a POST too (no `graphs` body).
        if (url.endsWith("/api/v2.0/disk/temperatures")) {
          return opts.diskTempsError
            ? Promise.reject(opts.diskTempsError)
            : Promise.resolve({ data: opts.diskTemps ?? {} });
        }
        const graphs = body.graphs ?? [];
        const names = graphs.map((g) => g.name);
        // The identifier-scoped disktemp fallback: every graph is disktemp AND
        // carries an identifier. Route it apart from the name-only cputemp/disktemp
        // call so a test can assert the two independently.
        if (graphs.length > 0 && graphs.every((g) => g.name === "disktemp" && g.identifier)) {
          return opts.diskTempByIdError
            ? Promise.reject(opts.diskTempByIdError)
            : Promise.resolve({ data: opts.diskTempById ?? [] });
        }
        // cputemp/disktemp (name-only) ride their own isolated POST (see widgets.ts).
        if (names.includes("cputemp") || names.includes("disktemp")) {
          return opts.cpuDiskTempError
            ? Promise.reject(opts.cpuDiskTempError)
            : Promise.resolve({ data: opts.cpuDiskTemp ?? [] });
        }
      if (names.some((n) => ARC_HIT_NAMES.includes(n ?? ""))) {
        return opts.arcHitError ? Promise.reject(opts.arcHitError) : Promise.resolve({ data: opts.arcHit ?? [] });
      }
      if (names.includes("arcsize")) {
        return opts.extrasError ? Promise.reject(opts.extrasError) : Promise.resolve({ data: opts.extras ?? [] });
      }
      return opts.coreError ? Promise.reject(opts.coreError) : Promise.resolve({ data: opts.core ?? [] });
    });
  }

  it("parses network throughput and ARC stats from the extras reporting call", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      // interface throughput is kilobits/s (→ Mbps is /1000); arcsize is bytes.
      // Two data rows per graph so the route can build a per-sample series. The
      // current value is the LAST row.
      extras: [
        {
          name: "interface",
          identifier: "enp14s0",
          legend: ["time", "received", "sent"],
          data: [
            [1000, 120000, 30000],
            [1060, 184600, 42300],
          ],
        },
        { name: "arcsize", legend: ["time", "size"], data: [[1000, 31.4e9]] },
      ],
      // ARC hit ratio rides its own call. arcresult exposes a direct percentage.
      arcHit: [
        {
          name: "arcresult",
          legend: ["time", "percentage"],
          data: [
            [1000, 80],
            [1060, 90],
          ],
        },
      ],
    });
    // reporting/graphs must expose the interface identifier so the route can ask
    // for the physical NIC (the virtual pterodactyl0 bridge is skipped).
    mockTruenasGets({
      graphs: [{ name: "interface", identifiers: ["pterodactyl0", "enp14s0"] }],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.netInMbps).toBe(184.6);
    expect(res.body.netOutMbps).toBe(42.3);
    expect(res.body.arcHitRatio).toBe(90);
    expect(res.body.arcSizeGb).toBeCloseTo(31.4, 1);
    // Per-sample series (kilobits/s → Mbps; ARC hit % per row).
    expect(res.body.netInSeries).toEqual([120, 184.6]);
    expect(res.body.netOutSeries).toEqual([30, 42.3]);
    expect(res.body.arcHitSeries).toEqual([80, 90]);
    // CPU still parsed from the core call.
    expect(res.body.cpuPercent).toBe(20);

    // The extras must ride a SEPARATE reporting POST (not bundled with cpu/memory),
    // request the resolved physical interface, and use a longer NON-aggregated
    // window so the data rows form a series (aggregate:true collapses to a mean).
    const extraCall = httpPost.mock.calls.find(
      ([, body]: [string, { graphs: Array<{ name?: string }> }]) =>
        body.graphs.some((g) => g.name === "arcsize"),
    );
    expect(extraCall).toBeDefined();
    expect(extraCall![1].query?.aggregate).toBe(false);
    // Core extras carry ONLY interface + arcsize (guaranteed-valid graph names).
    expect(extraCall![1].graphs).toEqual([
      { name: "interface", identifier: "enp14s0" },
      { name: "arcsize" },
    ]);
    // Each ARC hit-ratio candidate rides its OWN isolated call: one unknown graph
    // name fails a whole get_data batch, and the accepted set is version-specific
    // (legacy arc* vs demand* percentage graphs), so every candidate is requested
    // separately and the first that returns data wins.
    const arcHitCalls = httpPost.mock.calls.filter(
      ([, body]: [string, { graphs: Array<{ name?: string }> }]) =>
        body.graphs.length === 1 && ARC_HIT_NAMES.includes(body.graphs[0]!.name ?? ""),
    );
    expect(
      arcHitCalls.map(([, body]: [string, { graphs: Array<{ name?: string }> }]) => body.graphs[0]!.name).sort(),
    ).toEqual([...ARC_HIT_NAMES].sort());
    for (const [, body] of arcHitCalls as Array<
      [string, { graphs: Array<{ name?: string }>; query?: { aggregate?: boolean } }]
    >) {
      expect(body.query?.aggregate).toBe(false);
      expect(body.graphs).toHaveLength(1);
    }
  });

  it("nulls net/ARC when the extras call fails but keeps CPU/RAM (additive)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [
        { name: "cpu", legend: ["time", "idle"], data: [[1000, 70]] },
        { name: "memory", legend: ["time", "used", "free"], data: [[1000, 8e9, 8e9]] },
      ],
      extrasError: httpError(422), // interface graph rejected by the backend
    });
    httpGet.mockResolvedValue({ data: [] });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200); // additive failure → never a 502
    expect(res.body.cpuPercent).toBe(30); // core reporting unaffected
    expect(res.body.memUsedGb).toBe(8);
    expect(res.body.netInMbps).toBeNull();
    expect(res.body.netOutMbps).toBeNull();
    expect(res.body.arcHitRatio).toBeNull();
    expect(res.body.arcSizeGb).toBeNull();
    // Series fall back to empty (not null) so the tile simply omits the sparkline.
    expect(res.body.netInSeries).toEqual([]);
    expect(res.body.netOutSeries).toEqual([]);
    expect(res.body.arcHitSeries).toEqual([]);
  });

  it("falls back to a later ARC graph when the first candidate is empty", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    mockTruenasReporting({
      core: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
      extras: [{ name: "arcsize", legend: ["time", "size"], data: [[1000, 31.4e9]] }],
      // The first candidate (arcresult) is present but EMPTY; the route must skip
      // it and read the next populated candidate (arcrate, here as hits/misses).
      arcHit: [
        { name: "arcresult", legend: ["time", "percentage"], data: [] },
        {
          name: "arcrate",
          legend: ["time", "hits", "misses"],
          data: [
            [1000, 90, 10],
            [1060, 75, 25],
          ],
        },
      ],
    });
    mockTruenasGets({
      graphs: [{ name: "interface", identifiers: ["enp14s0"] }],
    });

    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    // hits/misses → ratio: latest row 75/(75+25) = 75%.
    expect(res.body.arcHitRatio).toBe(75);
    expect(res.body.arcHitSeries).toEqual([90, 75]);
    // ARC size from the core extras call is unaffected.
    expect(res.body.arcSizeGb).toBeCloseTo(31.4, 1);
  });

  it("includes network and ARC sample values when unconfigured", async () => {
    const res = await request(app).get("/widgets/truenas");
    expect(res.status).toBe(200);
    expect(res.body.netInMbps).toBe(184.6);
    expect(res.body.netOutMbps).toBe(42.3);
    expect(res.body.arcHitRatio).toBe(98.7);
    expect(res.body.arcSizeGb).toBe(31.4);
    // Sample series are non-empty so the sparkline renders on dev/Replit.
    expect(res.body.netInSeries.length).toBeGreaterThan(2);
    expect(res.body.arcHitSeries.length).toBeGreaterThan(2);
    // ARC hit ratio is a percentage, so the sample stays within 0-100.
    expect(Math.max(...res.body.arcHitSeries)).toBeLessThanOrEqual(100);
  });
});

// ── TrueNAS reporting diagnostic ───────────────────────────────────────────────
describe("GET /widgets/truenas/diagnostics", () => {
  // An axios-style error that also carries a response BODY, so we can assert the
  // diagnostic surfaces the server's actual rejection message (not just status).
  function httpErrorWithBody(status: number, body: unknown): Error {
    return Object.assign(new Error(`status ${status}`), {
      isAxiosError: true,
      code: "ERR_BAD_REQUEST",
      response: { status, data: body },
    });
  }

  it("returns 409 (not configured) and makes no upstream calls when unconfigured", async () => {
    const res = await request(app).get("/widgets/truenas/diagnostics");
    expect(res.status).toBe(409);
    expect(res.body.configured).toBe(false);
    expect(res.body.message).toMatch(/not configured/i);
    expect(httpGet).not.toHaveBeenCalled();
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("probes multiple request forms and surfaces each raw outcome", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    // The graphs-list GET succeeds; the get_data POSTs are rejected by the
    // backend with a body explaining why (the whole point of the diagnostic).
    httpGet.mockResolvedValue({
      status: 200,
      data: [{ name: "cpu", identifiers: null }, { name: "memory", identifiers: null }],
    });
    httpPost.mockRejectedValue(
      httpErrorWithBody(422, { message: "Invalid reporting_query: end must be in the past" }),
    );

    const res = await request(app).get("/widgets/truenas/diagnostics");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    // One graphs-list probe + several get_data candidate probes.
    expect(Array.isArray(res.body.probes)).toBe(true);
    expect(res.body.probes.length).toBeGreaterThan(2);

    const graphsProbe = res.body.probes[0];
    expect(graphsProbe.ok).toBe(true);
    expect(graphsProbe.request.method).toBe("GET");
    expect(graphsProbe.response).toEqual([
      { name: "cpu", identifiers: null },
      { name: "memory", identifiers: null },
    ]);

    // Every get_data POST probe records the EXACT request body it sent and the
    // raw error (status + the server's response body), so the user can copy the
    // real reason. (Disk-health POST probes have a different body shape.)
    const postProbes = res.body.probes.filter(
      (p: { request: { method: string; url: string } }) =>
        p.request.method === "POST" && p.request.url.endsWith("/reporting/get_data"),
    );
    expect(postProbes.length).toBeGreaterThan(1);
    for (const p of postProbes) {
      expect(p.ok).toBe(false);
      expect(p.status).toBe(422);
      expect(p.body).toEqual({ message: "Invalid reporting_query: end must be in the past" });
      expect(p.request.body.graphs).toBeDefined();
      expect(p.request.body.query).toBeDefined();
    }

    // The disk-health probes are present so a "--" cell on the tile is explainable.
    const labels = res.body.probes.map((p: { label: string }) => p.label);
    expect(labels.some((l: string) => l.includes("/disk"))).toBe(true);
    expect(labels.some((l: string) => l.includes("/disk/temperatures"))).toBe(true);
    expect(labels.some((l: string) => l.includes("/smart/test/results"))).toBe(true);

    // The temperatures probe sends the powermode the widget uses, with the disk
    // names resolved from the inventory probe.
    const tempProbe = res.body.probes.find(
      (p: { request: { method: string; url: string } }) =>
        p.request.method === "POST" && p.request.url.endsWith("/disk/temperatures"),
    );
    expect(tempProbe.request.body.powermode).toBe("NEVER");
    expect(Array.isArray(tempProbe.request.body.names)).toBe(true);
  });

  it("captures a successful probe's response body when a form is accepted", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "key" }),
    );
    httpGet.mockResolvedValue({ status: 200, data: [] });
    httpPost.mockResolvedValue({
      status: 200,
      data: [{ name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] }],
    });

    const res = await request(app).get("/widgets/truenas/diagnostics");
    expect(res.status).toBe(200);
    const postProbes = res.body.probes.filter(
      (p: { request: { method: string } }) => p.request.method === "POST",
    );
    expect(postProbes.every((p: { ok: boolean; status: number }) => p.ok && p.status === 200)).toBe(true);
    expect(postProbes[0].response).toEqual([
      { name: "cpu", legend: ["time", "idle"], data: [[1000, 80]] },
    ]);
  });

  it("never leaks the API key in the diagnostic payload", async () => {
    findByService.mockReturnValue(
      connRow({ service: "truenas", url: "https://nas.local", api_key: "super-secret-key" }),
    );
    httpGet.mockResolvedValue({ status: 200, data: [] });
    httpPost.mockRejectedValue(httpErrorWithBody(422, { message: "nope" }));

    const res = await request(app).get("/widgets/truenas/diagnostics");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("super-secret-key");
  });
});

// ── Media (Plex) ──────────────────────────────────────────────────────────────
describe("GET /widgets/media", () => {
  it("returns sample data when unconfigured", async () => {
    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    // Sample items carry a demo deep link so the click-through can be tested
    // before a real Plex server is connected.
    expect(res.body[0].url).toBe(
      "https://app.plex.tv/desktop/#!/server/demo/details?key=%2Flibrary%2Fmetadata%2F1",
    );
    expect(res.body.every((i: { url: string | null }) => typeof i.url === "string")).toBe(true);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("normalizes live Plex recently-added items", async () => {
    // A saved Plex token in the `extra` blob makes the route use Plex.
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    httpGet.mockResolvedValue({
      data: {
        MediaContainer: {
          Metadata: [
            { ratingKey: 42, title: "Severance", type: "show", year: 2022, thumb: "/t.jpg", addedAt: 1700000000 },
          ],
        },
      },
    });

    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: "42", title: "Severance", type: "show", year: 2022 });
    expect(res.body[0].thumb).toContain("X-Plex-Token=plex-token");

    // Token must ride as the X-Plex-Token header.
    const [, opts] = httpGet.mock.calls[0]!;
    expect(opts.headers["X-Plex-Token"]).toBe("plex-token");
  });

  it("derives the show name + season label from parentTitle for season items", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    // Plex "recently added" surfaces TV as a season item: the show name lives in
    // parentTitle and the per-season label is the item's own title.
    httpGet.mockResolvedValue({
      data: {
        MediaContainer: {
          Metadata: [
            { ratingKey: 7, title: "Season 2", type: "season", parentTitle: "Severance" },
          ],
        },
      },
    });

    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      title: "Season 2",
      type: "season",
      seriesName: "Severance",
      seasonLabel: "Season 2",
    });
  });

  it("derives the show name from grandparentTitle for episode items", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    // Episodes carry the show name in grandparentTitle and the season label in
    // parentTitle ("Severance · Season 3").
    httpGet.mockResolvedValue({
      data: {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 9,
              title: "Chapter 7",
              type: "episode",
              grandparentTitle: "Severance",
              parentTitle: "Season 3",
            },
          ],
        },
      },
    });

    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      title: "Chapter 7",
      type: "episode",
      seriesName: "Severance",
      seasonLabel: "Season 3",
    });
  });

  it("builds a Plex deep link from the /identity machineIdentifier + ratingKey", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    // The recentlyAdded container omits machineIdentifier; it is sourced from
    // the separate /identity call instead. Route GETs by URL so each returns its
    // own payload.
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/identity")) {
        return Promise.resolve({ data: { MediaContainer: { machineIdentifier: "abc123" } } });
      }
      return Promise.resolve({
        data: { MediaContainer: { Metadata: [{ ratingKey: 42, title: "Severance", type: "show" }] } },
      });
    });

    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(200);
    // The cover deep link points at app.plex.tv with the server id and an
    // encoded /library/metadata/<ratingKey> key.
    expect(res.body[0].url).toBe(
      "https://app.plex.tv/desktop/#!/server/abc123/details?key=%2Flibrary%2Fmetadata%2F42",
    );
    // The machineIdentifier must come from a dedicated /identity request.
    expect(httpGet.mock.calls.some(([u]: [string]) => String(u).endsWith("/identity"))).toBe(true);
  });

  it("omits the deep link when /identity cannot resolve the machineIdentifier", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    // /identity fails (or omits the id) → no deep link can be built, but the
    // recentlyAdded list still renders. The identity failure must not 502.
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/identity")) {
        return Promise.reject(httpError(500));
      }
      return Promise.resolve({
        data: { MediaContainer: { Metadata: [{ ratingKey: 42, title: "Severance", type: "show" }] } },
      });
    });

    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: "42", title: "Severance" });
    expect(res.body[0].url).toBeNull();
  });

  it("falls back to the server root when /identity omits the machineIdentifier", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    // Some servers omit machineIdentifier from /identity; the server root
    // MediaContainer still carries it, so resolution must fall back to "/".
    httpGet.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/identity")) {
        return Promise.resolve({ data: { MediaContainer: {} } });
      }
      if (u.endsWith("/library/recentlyAdded")) {
        return Promise.resolve({
          data: { MediaContainer: { Metadata: [{ ratingKey: 42, title: "Severance", type: "show" }] } },
        });
      }
      // Server root ("/") carries the machineIdentifier.
      return Promise.resolve({ data: { MediaContainer: { machineIdentifier: "root-id" } } });
    });

    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(200);
    expect(res.body[0].url).toBe(
      "https://app.plex.tv/desktop/#!/server/root-id/details?key=%2Flibrary%2Fmetadata%2F42",
    );
  });

  it("parses the machineIdentifier out of an XML /identity response", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    // Some setups ignore Accept: application/json and return XML as a string;
    // the identifier must still be extracted via regex.
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/identity")) {
        return Promise.resolve({
          data: '<MediaContainer size="0" machineIdentifier="xml-id" version="1.0" />',
        });
      }
      return Promise.resolve({
        data: { MediaContainer: { Metadata: [{ ratingKey: 42, title: "Severance", type: "show" }] } },
      });
    });

    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(200);
    expect(res.body[0].url).toBe(
      "https://app.plex.tv/desktop/#!/server/xml-id/details?key=%2Flibrary%2Fmetadata%2F42",
    );
  });

  it("builds a Jellyfin deep link from the /System/Info ServerId + item id", async () => {
    findByService.mockReturnValue(
      connRow({ service: "jellyfin", url: "https://jelly.local", api_key: "jelly-key" }),
    );
    // The /Items list omits the ServerId; it is sourced from the separate
    // /System/Info call. Route GETs by URL so each returns its own payload.
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/System/Info")) {
        return Promise.resolve({ data: { Id: "srv-abc" } });
      }
      return Promise.resolve({
        data: { Items: [{ Id: "item-9", Name: "Oppenheimer", Type: "Movie", ProductionYear: 2023 }] },
      });
    });

    const res = await request(app).get("/widgets/media?server=jellyfin");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: "item-9", title: "Oppenheimer", type: "movie" });
    // The deep link opens the Jellyfin web app for the exact item, scoped to the
    // resolved server id.
    expect(res.body[0].url).toBe(
      "https://jelly.local/web/index.html#!/details?id=item-9&serverId=srv-abc",
    );
    // The ServerId must come from a dedicated /System/Info request.
    expect(httpGet.mock.calls.some(([u]: [string]) => String(u).endsWith("/System/Info"))).toBe(true);
  });

  it("omits the Jellyfin deep link when /System/Info cannot resolve the ServerId", async () => {
    findByService.mockReturnValue(
      connRow({ service: "jellyfin", url: "https://jelly.local", api_key: "jelly-key" }),
    );
    // /System/Info fails → no deep link can be built, but the recently-added
    // list still renders. The System/Info failure must not 502.
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/System/Info")) {
        return Promise.reject(httpError(500));
      }
      return Promise.resolve({
        data: { Items: [{ Id: "item-9", Name: "Oppenheimer", Type: "Movie" }] },
      });
    });

    const res = await request(app).get("/widgets/media?server=jellyfin");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: "item-9", title: "Oppenheimer" });
    expect(res.body[0].url).toBeNull();
  });

  it("returns 502 on upstream failure (no mock fallback)", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    httpGet.mockRejectedValue(httpError(401));

    const res = await request(app).get("/widgets/media");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/media/);
  });
});

// ── Media: Continue Watching (Plex On Deck) ───────────────────────────────────
describe("GET /widgets/media/continue", () => {
  it("returns sample data when unconfigured", async () => {
    const res = await request(app).get("/widgets/media/continue");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ title: "Chapter 7", seriesName: "Severance", progress: 42 });
    // Sample items carry a demo deep link so the click-through can be tested
    // before a real Plex server is connected.
    expect(res.body[0].url).toBe(
      "https://app.plex.tv/desktop/#!/server/demo/details?key=%2Flibrary%2Fmetadata%2F1",
    );
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("normalizes On Deck: grandparentTitle show name + viewOffset/duration progress", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    // onDeck omits machineIdentifier; the deep link sources it from /identity.
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/identity")) {
        return Promise.resolve({ data: { MediaContainer: { machineIdentifier: "srv-1" } } });
      }
      return Promise.resolve({
        data: {
          MediaContainer: {
            Metadata: [
              {
                ratingKey: 55,
                title: "Chapter 7",
                type: "episode",
                grandparentTitle: "Severance",
                viewOffset: 600000,
                duration: 1200000,
                thumb: "/t.jpg",
              },
            ],
          },
        },
      });
    });

    const res = await request(app).get("/widgets/media/continue");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: "55",
      title: "Chapter 7",
      type: "episode",
      seriesName: "Severance",
      progress: 50, // 600000 / 1200000 → 50%
    });
    // Deep link is built from the /identity machineIdentifier + ratingKey.
    expect(res.body[0].url).toBe(
      "https://app.plex.tv/desktop/#!/server/srv-1/details?key=%2Flibrary%2Fmetadata%2F55",
    );
    // Token rides as the X-Plex-Token header against the onDeck endpoint (the
    // first GET; /identity is fetched in parallel).
    const [url, opts] = httpGet.mock.calls[0]!;
    expect(String(url)).toContain("/library/onDeck");
    expect(opts.headers["X-Plex-Token"]).toBe("plex-token");
  });

  it("leaves progress null when viewOffset or duration is missing", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    // Movies (non-episode) carry no series name; without a duration there is no
    // played fraction to compute.
    httpGet.mockResolvedValue({
      data: {
        MediaContainer: {
          Metadata: [{ ratingKey: 8, title: "Dune: Part Two", type: "movie", viewOffset: 1000 }],
        },
      },
    });

    const res = await request(app).get("/widgets/media/continue");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ title: "Dune: Part Two", type: "movie", seriesName: null, progress: null });
  });

  it("returns 502 on upstream failure (no mock fallback)", async () => {
    findByService.mockReturnValue(
      connRow({
        service: "plex",
        url: "https://plex.local",
        extra: JSON.stringify({ token: "plex-token" }),
      }),
    );
    httpGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/media/continue");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/continue watching/i);
  });

  it("normalizes Jellyfin Resume: SeriesName + PlaybackPositionTicks/RunTimeTicks progress", async () => {
    findByService.mockReturnValue(
      connRow({ service: "jellyfin", url: "https://jelly.local", api_key: "jelly-key" }),
    );
    // /Items/Resume omits the ServerId; the deep link sources it from the
    // separate /System/Info call. Route GETs by URL so each returns its payload.
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/System/Info")) {
        return Promise.resolve({ data: { Id: "srv-abc" } });
      }
      return Promise.resolve({
        data: {
          Items: [
            {
              Id: "item-7",
              Name: "Chapter 7",
              Type: "Episode",
              SeriesName: "Severance",
              ImageTags: { Primary: "tag1" },
              UserData: { PlaybackPositionTicks: 6000000000 },
              RunTimeTicks: 12000000000,
            },
          ],
        },
      });
    });

    const res = await request(app).get("/widgets/media/continue?server=jellyfin");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: "item-7",
      title: "Chapter 7",
      type: "episode",
      seriesName: "Severance",
      progress: 50, // 6000000000 / 12000000000 → 50%
    });
    // Deep link opens the Jellyfin web app for the exact item, scoped to the
    // resolved server id.
    expect(res.body[0].url).toBe(
      "https://jelly.local/web/index.html#!/details?id=item-7&serverId=srv-abc",
    );
    // The resume list must come from the dedicated /Items/Resume endpoint.
    expect(httpGet.mock.calls.some(([u]: [string]) => String(u).endsWith("/Items/Resume"))).toBe(true);
  });

  it("falls back to the series poster when a Jellyfin episode has no primary image", async () => {
    findByService.mockReturnValue(
      connRow({ service: "jellyfin", url: "https://jelly.local", api_key: "jelly-key" }),
    );
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/System/Info")) {
        return Promise.resolve({ data: { Id: "srv-abc" } });
      }
      return Promise.resolve({
        data: {
          Items: [
            {
              Id: "item-7",
              Name: "Chapter 7",
              Type: "Episode",
              SeriesName: "Severance",
              SeriesId: "series-1",
              SeriesPrimaryImageTag: "stag",
              UserData: { PlaybackPositionTicks: 3000000000 },
              RunTimeTicks: 12000000000,
            },
          ],
        },
      });
    });

    const res = await request(app).get("/widgets/media/continue?server=jellyfin");
    expect(res.status).toBe(200);
    expect(res.body[0].progress).toBe(25); // 3000000000 / 12000000000 → 25%
    // No episode still → thumb sources the series' primary image instead.
    expect(res.body[0].thumb).toContain("/Items/series-1/Images/Primary");
  });

  it("omits the Jellyfin deep link when /System/Info cannot resolve the ServerId", async () => {
    findByService.mockReturnValue(
      connRow({ service: "jellyfin", url: "https://jelly.local", api_key: "jelly-key" }),
    );
    // /System/Info fails → no deep link can be built, but the resume list still
    // renders. The System/Info failure must not 502.
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/System/Info")) {
        return Promise.reject(httpError(500));
      }
      return Promise.resolve({
        data: { Items: [{ Id: "item-7", Name: "Dune: Part Two", Type: "Movie" }] },
      });
    });

    const res = await request(app).get("/widgets/media/continue?server=jellyfin");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: "item-7", title: "Dune: Part Two", seriesName: null, progress: null });
    expect(res.body[0].url).toBeNull();
  });

  it("degrades to an empty list (200, never 502) when the Jellyfin Resume call fails", async () => {
    findByService.mockReturnValue(
      connRow({ service: "jellyfin", url: "https://jelly.local", api_key: "jelly-key" }),
    );
    // The resume fetch is additive: a failure must NOT take the tile down with a
    // 502 — Continue Watching is a supplementary section, so the route returns an
    // empty list and the tile keeps its other sections (e.g. Recently Added).
    httpGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/System/Info")) {
        return Promise.resolve({ data: { Id: "srv-abc" } });
      }
      return Promise.reject(httpError(500));
    });

    const res = await request(app).get("/widgets/media/continue?server=jellyfin");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── Sonarr ──────────────────────────────────────────────────────────────────
describe("GET /widgets/sonarr", () => {
  it("returns sample data when unconfigured", async () => {
    const res = await request(app).get("/widgets/sonarr");
    expect(res.status).toBe(200);
    expect(res.body.queue).toHaveLength(2);
    expect(res.body.upcoming).toHaveLength(2);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("normalizes live queue + calendar", async () => {
    findByService.mockReturnValue(
      connRow({ service: "sonarr", url: "https://sonarr.local", api_key: "key" }),
    );
    httpGet
      .mockResolvedValueOnce({
        data: {
          records: [
            { id: 1, title: "raw", status: "downloading", sizeleft: 25, size: 100, series: { title: "The Bear" } },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: [
          { id: 101, title: "Episode 5", series: { title: "The Bear" }, airDateUtc: "2026-06-14T00:00:00Z", seasonNumber: 3, episodeNumber: 5 },
        ],
      });

    const res = await request(app).get("/widgets/sonarr");
    expect(res.status).toBe(200);
    expect(res.body.queue[0]).toMatchObject({ id: 1, title: "The Bear", status: "downloading", progress: 75 });
    expect(res.body.upcoming[0]).toMatchObject({ seriesTitle: "The Bear", airDate: "2026-06-14", seasonNumber: 3 });

    // Auth must ride as X-Api-Key.
    const [, opts] = httpGet.mock.calls[0]!;
    expect(opts.headers["X-Api-Key"]).toBe("key");
  });

  it("returns 502 on upstream failure (no mock fallback)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "sonarr", url: "https://sonarr.local", api_key: "key" }),
    );
    httpGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/sonarr");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Sonarr/);
  });
});

// ── Radarr ──────────────────────────────────────────────────────────────────
describe("GET /widgets/radarr", () => {
  it("returns sample data when unconfigured", async () => {
    const res = await request(app).get("/widgets/radarr");
    expect(res.status).toBe(200);
    expect(res.body.queue).toHaveLength(2);
    expect(res.body.upcoming).toHaveLength(2);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("normalizes live queue + calendar (prefers digital release)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "radarr", url: "https://radarr.local", api_key: "key" }),
    );
    httpGet
      .mockResolvedValueOnce({
        data: {
          records: [
            { id: 1, title: "raw", status: "downloading", sizeleft: 20, size: 200, movie: { title: "Dune: Part Two" } },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: [
          { id: 201, title: "Furiosa", year: 2024, inCinemas: "2024-05-24T00:00:00Z", digitalRelease: "2024-07-16T00:00:00Z" },
        ],
      });

    const res = await request(app).get("/widgets/radarr");
    expect(res.status).toBe(200);
    expect(res.body.queue[0]).toMatchObject({ title: "Dune: Part Two", progress: 90 });
    expect(res.body.upcoming[0]).toMatchObject({ title: "Furiosa", releaseDate: "2024-07-16", year: 2024 });
  });

  it("returns 502 on upstream failure (no mock fallback)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "radarr", url: "https://radarr.local", api_key: "key" }),
    );
    httpGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/radarr");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Radarr/);
  });
});

// ── qBittorrent ─────────────────────────────────────────────────────────────
describe("GET /widgets/qbittorrent", () => {
  it("returns sample data when unconfigured", async () => {
    const res = await request(app).get("/widgets/qbittorrent");
    expect(res.status).toBe(200);
    expect(res.body.torrents).toHaveLength(3);
    // The mock fallback advertises a representative category catalog so the
    // tile filter has something to list even without a live qBittorrent.
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories.length).toBeGreaterThan(0);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("logs in for a SID cookie, then reuses it on the data calls", async () => {
    // Unique URL so the module-level SID cache key is isolated per test.
    const baseUrl = "https://qb-login.local";
    findByService.mockReturnValue(
      connRow({ service: "qbittorrent", url: baseUrl, username: "admin", password: "pw" }),
    );
    // Login → returns a Set-Cookie with the SID.
    httpPost.mockResolvedValue({ data: "Ok.", headers: { "set-cookie": ["SID=abc123; HttpOnly; path=/"] } });
    httpGet
      .mockResolvedValueOnce({
        data: [{ name: "ubuntu.iso", progress: 0.5, state: "downloading", dlspeed: 1000, upspeed: 50 }],
      })
      .mockResolvedValueOnce({ data: { dl_info_speed: 1000, up_info_speed: 50 } })
      // Categories endpoint: the dedicated catalog includes a category with no
      // active torrents ("Archive") that must still surface in the response.
      .mockResolvedValueOnce({
        data: {
          "Linux ISOs": { name: "Linux ISOs", savePath: "" },
          Archive: { name: "Archive", savePath: "" },
        },
      });

    const res = await request(app).get("/widgets/qbittorrent");
    expect(res.status).toBe(200);
    expect(res.body.torrents[0]).toMatchObject({ name: "ubuntu.iso", progress: 50, state: "downloading" });
    expect(res.body.downloadSpeed).toBe(1000);
    // Sorted catalog of all defined categories, including the empty "Archive".
    expect(res.body.categories).toEqual(["Archive", "Linux ISOs"]);

    // Login posts a form to the auth/login endpoint.
    expect(httpPost.mock.calls[0]![0]).toBe(`${baseUrl}/api/v2/auth/login`);
    // Both data calls must carry the extracted SID cookie.
    for (const call of httpGet.mock.calls) {
      const opts = call[1] as { headers: Record<string, string> };
      expect(opts.headers.Cookie).toBe("SID=abc123");
    }
  });

  it("handles the qBittorrent 5.x QBT_SID_<port> session cookie", async () => {
    const baseUrl = "https://qb-v5.local";
    findByService.mockReturnValue(
      connRow({ service: "qbittorrent", url: baseUrl, username: "admin", password: "pw" }),
    );
    // qBittorrent 5.x renamed the session cookie to "QBT_SID_<port>".
    httpPost.mockResolvedValue({
      data: "Ok.",
      headers: { "set-cookie": ["QBT_SID_8080=v5token; HttpOnly; SameSite=Strict; path=/"] },
    });
    httpGet
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { dl_info_speed: 0, up_info_speed: 0 } })
      .mockResolvedValueOnce({ data: {} });

    const res = await request(app).get("/widgets/qbittorrent");
    expect(res.status).toBe(200);
    // The full name=value pair must be sent back verbatim on the data calls
    // (torrents, transfer, and the categories catalog call).
    for (const call of httpGet.mock.calls) {
      const opts = call[1] as { headers: Record<string, string> };
      expect(opts.headers.Cookie).toBe("QBT_SID_8080=v5token");
    }
  });

  it("re-authenticates once when the cached session returns 403", async () => {
    const baseUrl = "https://qb-403.local";
    findByService.mockReturnValue(
      connRow({ service: "qbittorrent", url: baseUrl, username: "admin", password: "pw" }),
    );
    httpPost.mockResolvedValue({ data: "Ok.", headers: { "set-cookie": ["SID=first; path=/"] } });
    // First data fetch 403s (expired session); after re-login the retry succeeds.
    // Each fetch issues two GETs (torrents + transfer), so the first pair 403s
    // and the second pair resolves.
    httpGet
      .mockRejectedValueOnce(httpError(403))
      .mockRejectedValueOnce(httpError(403))
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { dl_info_speed: 0, up_info_speed: 0 } })
      .mockResolvedValueOnce({ data: {} });

    const res = await request(app).get("/widgets/qbittorrent");
    expect(res.status).toBe(200);
    // Logged in twice: initial + after the 403.
    expect(httpPost).toHaveBeenCalledTimes(2);
  });

  it("still returns torrents/transfer when the categories fetch fails", async () => {
    const baseUrl = "https://qb-cats-fail.local";
    findByService.mockReturnValue(
      connRow({ service: "qbittorrent", url: baseUrl, username: "admin", password: "pw" }),
    );
    httpPost.mockResolvedValue({ data: "Ok.", headers: { "set-cookie": ["SID=cats; path=/"] } });
    // Torrents + transfer succeed, but the dedicated categories call errors.
    // The catalog must degrade to an empty list without failing the response.
    httpGet
      .mockResolvedValueOnce({
        data: [{ name: "ubuntu.iso", progress: 0.5, state: "downloading", dlspeed: 1000, upspeed: 50 }],
      })
      .mockResolvedValueOnce({ data: { dl_info_speed: 1000, up_info_speed: 50 } })
      .mockRejectedValueOnce(httpError(500));

    const res = await request(app).get("/widgets/qbittorrent");
    expect(res.status).toBe(200);
    expect(res.body.torrents).toHaveLength(1);
    expect(res.body.categories).toEqual([]);
  });

  it("returns 502 when authentication fails", async () => {
    const baseUrl = "https://qb-fail.local";
    findByService.mockReturnValue(
      connRow({ service: "qbittorrent", url: baseUrl, username: "admin", password: "wrong" }),
    );
    httpPost.mockResolvedValue({ data: "Fails.", headers: {} });

    const res = await request(app).get("/widgets/qbittorrent");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/authentication failed/i);
  });

  it("returns 502 on upstream failure (no mock fallback)", async () => {
    const baseUrl = "https://qb-err.local";
    findByService.mockReturnValue(
      connRow({ service: "qbittorrent", url: baseUrl, username: "admin", password: "pw" }),
    );
    httpPost.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/qbittorrent");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/qBittorrent/);
  });
});

// ── Pi-hole ─────────────────────────────────────────────────────────────────
describe("GET /widgets/pihole", () => {
  it("returns 503 (not configured) when no base URL is saved", async () => {
    const res = await request(app).get("/widgets/pihole");
    expect(res.status).toBe(503);
    expect(httpPost).not.toHaveBeenCalled();
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("reads stats from a v6 instance (session login + REST API)", async () => {
    const baseUrl = "https://pi6.local";
    findByService.mockReturnValue(connRow({ service: "pihole", url: baseUrl, api_key: "app-pw" }));
    // v6 login succeeds and returns a session id.
    httpPost.mockResolvedValue({ data: { session: { valid: true, sid: "sid-123" } } });
    httpGet
      .mockResolvedValueOnce({
        data: {
          queries: { total: 5000, blocked: 1000, percent_blocked: 20 },
          gravity: { domains_being_blocked: 123456 },
        },
      })
      .mockResolvedValueOnce({ data: { blocking: "enabled" } });

    const res = await request(app).get("/widgets/pihole");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      queriesTotal: 5000,
      adsBlocked: 1000,
      adsPercentage: 20,
      domainsBlocked: 123456,
      status: "enabled",
    });
    // v6 path: POST /api/auth, GET stats + blocking carrying the SID header.
    expect(httpPost.mock.calls[0]![0]).toBe(`${baseUrl}/api/auth`);
    for (const call of httpGet.mock.calls) {
      const opts = call[1] as { headers: Record<string, string> };
      expect(opts.headers["X-FTL-SID"]).toBe("sid-123");
    }
    // The session is cleaned up afterward.
    expect(httpDelete.mock.calls[0]![0]).toBe(`${baseUrl}/api/auth`);
    // Never touched the legacy endpoint.
    expect(httpGet.mock.calls.some((c) => String(c[0]).includes("admin/api.php"))).toBe(false);
  });

  it("falls back to the v5 endpoint when /api/auth is absent (404)", async () => {
    const baseUrl = "https://pi5.local";
    findByService.mockReturnValue(connRow({ service: "pihole", url: baseUrl, api_key: "token" }));
    // v5 hosts have no /api/auth — lighttpd answers 404.
    httpPost.mockRejectedValue(httpError(404));
    httpGet.mockResolvedValue({
      data: {
        dns_queries_today: 4200,
        ads_blocked_today: 800,
        ads_percentage_today: 19.04,
        domains_being_blocked: 99999,
        status: "enabled",
      },
    });

    const res = await request(app).get("/widgets/pihole");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      queriesTotal: 4200,
      adsBlocked: 800,
      domainsBlocked: 99999,
      status: "enabled",
    });
    expect(String(httpGet.mock.calls[0]![0])).toContain("admin/api.php");
  });

  it("surfaces a clear error when the v6 password is wrong (401)", async () => {
    const baseUrl = "https://pi6-bad.local";
    findByService.mockReturnValue(connRow({ service: "pihole", url: baseUrl, api_key: "wrong" }));
    httpPost.mockRejectedValue(httpError(401));

    const res = await request(app).get("/widgets/pihole");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/invalid api key\/password/i);
    // Did not fall back to v5 on an auth failure.
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("surfaces a clear error on a bad/zeroed v5 payload (no zeros tile)", async () => {
    const baseUrl = "https://pi5-bad.local";
    findByService.mockReturnValue(connRow({ service: "pihole", url: baseUrl, api_key: "nope" }));
    httpPost.mockRejectedValue(httpError(404));
    // v5 returns 200 with the privileged fields absent when the token is wrong.
    httpGet.mockResolvedValue({ data: [] });

    const res = await request(app).get("/widgets/pihole");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/invalid pi-hole response/i);
  });
});

// ── News (RSS / Atom) ─────────────────────────────────────────────────────────
describe("GET /widgets/news", () => {
  const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First headline</title>
      <link>https://example.com/a</link>
      <pubDate>Tue, 16 Jun 2026 05:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second headline</title>
      <link>https://example.com/b</link>
      <pubDate>Tue, 16 Jun 2026 04:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Third headline</title>
      <link>https://example.com/c</link>
    </item>
  </channel>
</rss>`;

  it("returns demo headlines when no feed URL is supplied", async () => {
    const res = await request(app).get("/widgets/news");
    expect(res.status).toBe(200);
    expect(res.body.feedTitle).toBe("Demo Feed");
    expect(res.body.items.length).toBeGreaterThan(0);
    // Demo content must not hit the network.
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("honors the limit param for demo headlines", async () => {
    const res = await request(app).get("/widgets/news?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("fetches and parses a configured RSS feed", async () => {
    httpGet.mockResolvedValue({ data: RSS_SAMPLE });

    const res = await request(app).get("/widgets/news?url=https://example.com/feed.xml");
    expect(res.status).toBe(200);
    expect(res.body.feedTitle).toBe("Example Feed");
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0]).toMatchObject({
      title: "First headline",
      link: "https://example.com/a",
    });
    expect(res.body.items[0].published).toBe("2026-06-16T05:00:00.000Z");
    // An item without a date yields a null published rather than an invalid one.
    expect(res.body.items[2].published).toBeNull();

    // Feed must be fetched as text so rss-parser receives raw XML.
    const [, opts] = httpGet.mock.calls[0]!;
    expect(opts.responseType).toBe("text");
  });

  it("caps the number of items at the requested limit", async () => {
    httpGet.mockResolvedValue({ data: RSS_SAMPLE });

    const res = await request(app).get("/widgets/news?url=https://example.com/feed.xml&limit=1");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe("First headline");
  });

  it("returns 502 when the feed cannot be fetched", async () => {
    httpGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/news?url=https://down.example.com/feed.xml");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/feed/i);
  });

  it("returns 502 when the response is not a parseable feed", async () => {
    httpGet.mockResolvedValue({ data: "<html><body>not a feed</body></html>" });

    const res = await request(app).get("/widgets/news?url=https://example.com/notafeed");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/feed/i);
  });
});

// ── Pterodactyl ─────────────────────────────────────────────────────────────
describe("GET /widgets/pterodactyl", () => {
  it("returns sample data when unconfigured", async () => {
    const res = await request(app).get("/widgets/pterodactyl");
    expect(res.status).toBe(200);
    expect(res.body.servers).toHaveLength(4);
    // Sample data includes running, starting, and offline servers so the tile
    // preview shows every state without a live panel.
    const states = res.body.servers.map((s: { state: string }) => s.state);
    expect(states).toContain("running");
    expect(states).toContain("starting");
    expect(states).toContain("offline");
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("maps live servers: state, CPU, memory usage and limit", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );

    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/api/client")) {
        return Promise.resolve({
          data: {
            data: [
              {
                attributes: {
                  identifier: "abc123",
                  name: "Minecraft",
                  limits: { memory: 4096 },
                },
              },
              {
                attributes: {
                  identifier: "def456",
                  name: "Valheim",
                  // 0 = unlimited in the panel → null limit.
                  limits: { memory: 0 },
                },
              },
            ],
          },
        });
      }
      if (url.includes("/servers/abc123/resources")) {
        return Promise.resolve({
          data: {
            attributes: {
              current_state: "running",
              resources: { memory_bytes: 2147483648, cpu_absolute: 37.25 },
            },
          },
        });
      }
      if (url.includes("/servers/def456/resources")) {
        return Promise.resolve({
          data: {
            attributes: {
              current_state: "offline",
              resources: { memory_bytes: 0, cpu_absolute: 0 },
            },
          },
        });
      }
      return Promise.reject(httpError(404));
    });

    const res = await request(app).get("/widgets/pterodactyl");
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual([
      {
        id: "abc123",
        name: "Minecraft",
        state: "running",
        cpuPercent: 37.3,
        memUsedMb: 2048,
        memLimitMb: 4096,
        players: null,
        // Running Minecraft server without any allocation: the gap is
        // explained instead of silently omitted.
        playersUnavailableReason: "no-allocation",
      },
      {
        id: "def456",
        name: "Valheim",
        state: "offline",
        cpuPercent: 0,
        memUsedMb: 0,
        memLimitMb: null,
        players: null,
        // Not running — no player query is expected, so no reason either.
        playersUnavailableReason: null,
      },
    ]);

    // The list call must authenticate with the client API key as a Bearer token.
    const [, listOpts] = httpGet.mock.calls[0]!;
    expect(listOpts.headers.Authorization).toBe("Bearer ptlc_key");
    // Without allocations there is no query target, so no game query happens.
    expect(queryGamePlayersDetailed).not.toHaveBeenCalled();
  });

  it("queries live player occupancy for running servers via their allocation", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );
    queryGamePlayersDetailed.mockResolvedValue({ players: { current: 2, max: 10 }, reason: null });

    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/api/client")) {
        return Promise.resolve({
          data: {
            data: [
              {
                attributes: {
                  identifier: "abc123",
                  name: "Minecraft SMP",
                  limits: { memory: 4096 },
                  invocation: "java -jar server.jar",
                  sftp_details: { ip: "node.lan" },
                  relationships: {
                    allocations: {
                      data: [
                        // Non-default allocation first: the default one wins.
                        { attributes: { ip: "0.0.0.0", ip_alias: null, port: 25570, is_default: false } },
                        { attributes: { ip: "0.0.0.0", ip_alias: "mc.example.com", port: 25565, is_default: true } },
                      ],
                    },
                  },
                },
              },
            ],
          },
        });
      }
      if (url.includes("/servers/abc123/resources")) {
        return Promise.resolve({
          data: {
            attributes: {
              current_state: "running",
              resources: { memory_bytes: 1073741824, cpu_absolute: 10 },
            },
          },
        });
      }
      return Promise.reject(httpError(404));
    });

    const res = await request(app).get("/widgets/pterodactyl");
    expect(res.status).toBe(200);
    expect(res.body.servers[0].players).toEqual({ current: 2, max: 10 });
    expect(res.body.servers[0].playersUnavailableReason).toBeNull();
    // The game was identified from the java invocation and queried at the
    // default allocation's alias hostname and port.
    expect(queryGamePlayersDetailed).toHaveBeenCalledWith("minecraft", "mc.example.com", 25565);

    // Regression: a failing game query stays additive — players comes back
    // null WITH the failure reason and the row (and widget) still succeeds.
    queryGamePlayersDetailed.mockResolvedValue({ players: null, reason: "timeout", detail: "no response" });
    const res2 = await request(app).get("/widgets/pterodactyl");
    expect(res2.status).toBe(200);
    expect(res2.body.servers[0].players).toBeNull();
    expect(res2.body.servers[0].state).toBe("running");
    expect(res2.body.servers[0].playersUnavailableReason).toBe("timeout");
  });

  it("falls back to the next candidate host when the first query fails", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );
    // Alias host times out; the node's SFTP host answers.
    queryGamePlayersDetailed.mockImplementation(async (...args: unknown[]) =>
      args[1] === "node.lan"
        ? { players: { current: 5, max: 20 }, reason: null }
        : { players: null, reason: "timeout" as const, detail: "no response" },
    );

    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/api/client")) {
        return Promise.resolve({
          data: {
            data: [
              {
                attributes: {
                  identifier: "abc123",
                  name: "Valheim Dedicated",
                  limits: { memory: 4096 },
                  sftp_details: { ip: "node.lan" },
                  relationships: {
                    allocations: {
                      data: [
                        { attributes: { ip: "0.0.0.0", ip_alias: "vh.example.com", port: 2456, is_default: true } },
                      ],
                    },
                  },
                },
              },
            ],
          },
        });
      }
      if (url.includes("/resources")) {
        return Promise.resolve({
          data: { attributes: { current_state: "running", resources: { memory_bytes: 0, cpu_absolute: 0 } } },
        });
      }
      return Promise.reject(httpError(404));
    });

    const res = await request(app).get("/widgets/pterodactyl");
    expect(res.status).toBe(200);
    expect(res.body.servers[0].players).toEqual({ current: 5, max: 20 });
    // Valheim answers Steam queries on game port + 1 (2457) — first the alias
    // host, then the SFTP host fallback.
    expect(queryGamePlayersDetailed).toHaveBeenNthCalledWith(1, "valheim", "vh.example.com", 2457);
    expect(queryGamePlayersDetailed).toHaveBeenNthCalledWith(2, "valheim", "node.lan", 2457);
  });

  it("also tries the standard Minecraft port when the allocation port fails", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );
    queryGamePlayersDetailed.mockImplementation(async (...args: unknown[]) =>
      args[2] === 25565
        ? { players: { current: 1, max: 20 }, reason: null }
        : { players: null, reason: "timeout" as const, detail: "no response" },
    );

    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/api/client")) {
        return Promise.resolve({
          data: {
            data: [
              {
                attributes: {
                  identifier: "abc123",
                  name: "Paper Lobby",
                  limits: { memory: 4096 },
                  relationships: {
                    allocations: {
                      data: [
                        { attributes: { ip: "0.0.0.0", ip_alias: "mc.example.com", port: 25570, is_default: true } },
                      ],
                    },
                  },
                },
              },
            ],
          },
        });
      }
      if (url.includes("/resources")) {
        return Promise.resolve({
          data: { attributes: { current_state: "running", resources: { memory_bytes: 0, cpu_absolute: 0 } } },
        });
      }
      return Promise.reject(httpError(404));
    });

    const res = await request(app).get("/widgets/pterodactyl");
    expect(res.status).toBe(200);
    expect(res.body.servers[0].players).toEqual({ current: 1, max: 20 });
    expect(queryGamePlayersDetailed).toHaveBeenCalledWith("minecraft", "mc.example.com", 25570);
    expect(queryGamePlayersDetailed).toHaveBeenCalledWith("minecraft", "mc.example.com", 25565);
  });

  it("reports unknown-game for a running server whose game can't be guessed", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );

    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/api/client")) {
        return Promise.resolve({
          data: {
            data: [
              {
                attributes: {
                  identifier: "abc123",
                  name: "Mystery Server",
                  limits: { memory: 2048 },
                  relationships: {
                    allocations: {
                      data: [
                        { attributes: { ip: "0.0.0.0", ip_alias: "srv.example.com", port: 7777, is_default: true } },
                      ],
                    },
                  },
                },
              },
            ],
          },
        });
      }
      if (url.includes("/resources")) {
        return Promise.resolve({
          data: { attributes: { current_state: "running", resources: { memory_bytes: 0, cpu_absolute: 0 } } },
        });
      }
      return Promise.reject(httpError(404));
    });

    const res = await request(app).get("/widgets/pterodactyl");
    expect(res.status).toBe(200);
    expect(res.body.servers[0].players).toBeNull();
    expect(res.body.servers[0].playersUnavailableReason).toBe("unknown-game");
    // No query target could even be planned, so no live query happened.
    expect(queryGamePlayersDetailed).not.toHaveBeenCalled();
  });

  it("keeps a server row with state unknown when its resources call fails", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );

    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/api/client")) {
        return Promise.resolve({
          data: {
            data: [
              { attributes: { identifier: "abc123", name: "Minecraft", limits: { memory: 4096 } } },
            ],
          },
        });
      }
      return Promise.reject(httpError(500));
    });

    const res = await request(app).get("/widgets/pterodactyl");
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual([
      {
        id: "abc123",
        name: "Minecraft",
        state: "unknown",
        cpuPercent: null,
        memUsedMb: null,
        memLimitMb: 4096,
        players: null,
        playersUnavailableReason: null,
      },
    ]);
  });

  it("returns 502 when configured but the panel is unreachable", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );
    httpGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/pterodactyl");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/pterodactyl/i);
  });
});

describe("POST /widgets/pterodactyl/power", () => {
  it("rejects a missing server id", async () => {
    const res = await request(app)
      .post("/widgets/pterodactyl/power")
      .send({ signal: "start" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/serverId/i);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("rejects an invalid power signal", async () => {
    const res = await request(app)
      .post("/widgets/pterodactyl/power")
      .send({ serverId: "abc123", signal: "kill" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signal/i);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("acknowledges as a demo no-op when unconfigured", async () => {
    const res = await request(app)
      .post("/widgets/pterodactyl/power")
      .send({ serverId: "a1b2c3d4", signal: "restart" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, demo: true });
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("sends the power signal to the panel when configured", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );
    httpPost.mockResolvedValue({ status: 204, data: "" });

    const res = await request(app)
      .post("/widgets/pterodactyl/power")
      .send({ serverId: "abc123", signal: "stop" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, demo: false });
    expect(httpPost).toHaveBeenCalledWith(
      "https://panel.local/api/client/servers/abc123/power",
      { signal: "stop" },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ptlc_key" }),
      }),
    );
  });

  it("returns 502 when the panel rejects the signal", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );
    httpPost.mockRejectedValue(httpError(409));

    const res = await request(app)
      .post("/widgets/pterodactyl/power")
      .send({ serverId: "abc123", signal: "start" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/start/i);
  });
});

describe("GET /widgets/pterodactyl/diagnostics", () => {
  it("returns 409 when unconfigured (no sample data)", async () => {
    const res = await request(app).get("/widgets/pterodactyl/diagnostics");
    expect(res.status).toBe(409);
    expect(res.body.configured).toBe(false);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("reports hints, guessed game, candidates, and live query outcome per server", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );
    queryGamePlayersDetailed.mockResolvedValue({ players: null, reason: "timeout", detail: "no response" });

    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/api/client")) {
        return Promise.resolve({
          data: {
            data: [
              {
                attributes: {
                  identifier: "abc123",
                  name: "Minecraft SMP",
                  invocation: "java -jar server.jar",
                  docker_image: "ghcr.io/pterodactyl/yolks:java_21",
                  sftp_details: { ip: "node.lan" },
                  relationships: {
                    allocations: {
                      data: [
                        { attributes: { ip: "0.0.0.0", ip_alias: "mc.example.com", port: 25565, is_default: true } },
                      ],
                    },
                  },
                },
              },
              {
                attributes: {
                  identifier: "def456",
                  name: "Mystery Server",
                },
              },
            ],
          },
        });
      }
      if (url.includes("/resources")) {
        return Promise.resolve({
          data: { attributes: { current_state: "running", resources: {} } },
        });
      }
      return Promise.reject(httpError(404));
    });

    const res = await request(app).get("/widgets/pterodactyl/diagnostics");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.servers).toHaveLength(2);

    const mc = res.body.servers[0];
    expect(mc.guessedGame).toBe("minecraft");
    expect(mc.state).toBe("running");
    expect(mc.hints.name).toBe("Minecraft SMP");
    expect(mc.hints.allocations).toEqual([
      { ip: "0.0.0.0", ipAlias: "mc.example.com", port: 25565, isDefault: true },
    ]);
    expect(mc.candidates).toEqual([
      { host: "mc.example.com", port: 25565 },
      { host: "node.lan", port: 25565 },
    ]);
    expect(mc.outcome.players).toBeNull();
    expect(mc.outcome.reason).toBe("timeout");
    expect(mc.outcome.attempts).toHaveLength(2);
    expect(mc.outcome.attempts[0].outcome).toContain("no response");

    const mystery = res.body.servers[1];
    expect(mystery.guessedGame).toBeNull();
    expect(mystery.outcome).toEqual({ players: null, reason: "unknown-game" });
    expect(mystery.candidates).toEqual([]);
  });

  it("surfaces a panel failure as data instead of a 5xx", async () => {
    findByService.mockReturnValue(
      connRow({ service: "pterodactyl", url: "https://panel.local", api_key: "ptlc_key" }),
    );
    httpGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/pterodactyl/diagnostics");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.servers).toEqual([]);
    expect(res.body.panelError).toBeTruthy();
  });
});

// ── Tailscale ───────────────────────────────────────────────────────────────
describe("GET /widgets/tailscale", () => {
  it("returns sample data when unconfigured", async () => {
    const res = await request(app).get("/widgets/tailscale");
    expect(res.status).toBe(200);
    expect(res.body.tailnet).toBe("example.ts.net");
    expect(res.body.deviceCount).toBe(4);
    expect(res.body.devices).toHaveLength(4);
    // Sample devices carry addresses so the tile preview renders without a
    // live connection.
    expect(res.body.devices[0].addresses).toEqual(["100.64.0.1", "fd7a:115c:a1e0::1"]);
    // Sample data must not hit the cloud API.
    expect(cloudGet).not.toHaveBeenCalled();
  });

  it("maps live devices: addresses, online and exit-node derivation", async () => {
    findByService.mockReturnValue(
      connRow({ service: "tailscale", url: "example.ts.net", api_key: "tskey-abc" }),
    );

    const now = Date.now();
    cloudGet.mockResolvedValue({
      data: {
        devices: [
          {
            // Online (seen 1 min ago) and an approved IPv4 exit node.
            id: "node-1",
            hostname: "homelab-nas",
            name: "homelab-nas.example.ts.net",
            os: "linux",
            lastSeen: new Date(now - 60_000).toISOString(),
            enabledRoutes: ["0.0.0.0/0", "192.168.1.0/24"],
            addresses: ["100.64.0.10", "fd7a:115c:a1e0::a"],
            keyExpiryDisabled: true,
          },
          {
            // Offline (seen 2 days ago); merely advertises (not enabled) the
            // default route, so it is NOT an exit node.
            nodeId: "node-2",
            name: "old-laptop.example.ts.net",
            os: "windows",
            lastSeen: new Date(now - 2 * 86400_000).toISOString(),
            enabledRoutes: [],
            advertisedRoutes: ["0.0.0.0/0"],
            addresses: ["100.64.0.20"],
          },
        ],
      },
    });

    const res = await request(app).get("/widgets/tailscale");
    expect(res.status).toBe(200);
    expect(res.body.tailnet).toBe("example.ts.net");
    expect(res.body.deviceCount).toBe(2);
    expect(res.body.onlineCount).toBe(1);
    expect(res.body.offlineCount).toBe(1);
    // Only online exit nodes are counted.
    expect(res.body.exitNodeCount).toBe(1);

    const [nas, laptop] = res.body.devices;
    expect(nas.id).toBe("node-1");
    // Prefers the short hostname over the full DNS name.
    expect(nas.name).toBe("homelab-nas");
    expect(nas.online).toBe(true);
    expect(nas.exitNode).toBe(true);
    expect(nas.addresses).toEqual(["100.64.0.10", "fd7a:115c:a1e0::a"]);

    expect(laptop.id).toBe("node-2");
    // Falls back to the first DNS label when there is no hostname.
    expect(laptop.name).toBe("old-laptop");
    expect(laptop.online).toBe(false);
    expect(laptop.exitNode).toBe(false);
    expect(laptop.addresses).toEqual(["100.64.0.20"]);

    // Cloud API is queried with the saved token and fields=all.
    const [url, opts] = cloudGet.mock.calls[0]!;
    expect(url).toContain("/tailnet/example.ts.net/devices");
    expect(opts.headers.Authorization).toBe("Bearer tskey-abc");
    expect(opts.params.fields).toBe("all");
    // Live data must not produce a missing-address field.
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("defaults addresses to an empty array when absent", async () => {
    findByService.mockReturnValue(
      connRow({ service: "tailscale", url: "example.ts.net", api_key: "tskey-abc" }),
    );
    cloudGet.mockResolvedValue({
      data: { devices: [{ id: "n", hostname: "h", os: "linux", lastSeen: new Date().toISOString() }] },
    });

    const res = await request(app).get("/widgets/tailscale");
    expect(res.status).toBe(200);
    expect(res.body.devices[0].addresses).toEqual([]);
  });

  it("returns 502 on upstream failure (no sample fallback)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "tailscale", url: "example.ts.net", api_key: "tskey-abc" }),
    );
    cloudGet.mockRejectedValue(httpError(500));

    const res = await request(app).get("/widgets/tailscale");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/tailscale/i);
  });
});

// ── Email ───────────────────────────────────────────────────────────────────
describe("GET /widgets/email/inbox", () => {
  it("returns sample messages when no mail account is configured", async () => {
    const res = await request(app).get("/widgets/email/inbox");
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(true);
    expect(res.body.messages.length).toBeGreaterThan(0);
    expect(res.body.messages[0]).toHaveProperty("subject");
    expect(res.body.messages[0]).toHaveProperty("from");
    // Demo data never touches the network.
    expect(cloudGet).not.toHaveBeenCalled();
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("filters demo data to unread when unreadOnly=true", async () => {
    const res = await request(app).get("/widgets/email/inbox?unreadOnly=true");
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(true);
    expect(res.body.messages.every((m: { unread: boolean }) => m.unread)).toBe(true);
  });

  it("caps the message count via max", async () => {
    const res = await request(app).get("/widgets/email/inbox?max=2");
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeLessThanOrEqual(2);
  });

  it("returns empty live data (not sample) when an account exists but the filter matches none", async () => {
    // An IMAP account is configured, but the tile's filter names a stale id —
    // the route must NOT fall back to demo data (that would look like real mail).
    findByService.mockImplementation((_userId: number, service: string) =>
      service === "imap"
        ? connRow({
            service: "imap",
            extra: JSON.stringify([
              { id: "acc1", label: "Home", host: "imap.example.com", port: 993, secure: true, username: "u", password: "p" },
            ]),
          })
        : undefined,
    );
    const res = await request(app).get("/widgets/email/inbox?accounts=deleted-id");
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(false);
    expect(res.body.messages).toEqual([]);
  });
});

describe("GET /widgets/email/message", () => {
  it("rejects a missing message id", async () => {
    const res = await request(app).get("/widgets/email/message");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/id/i);
  });

  it("rejects demo messages", async () => {
    const res = await request(app).get("/widgets/email/message?id=demo:0");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/demo/i);
  });

  it("returns 404 for an unknown IMAP account", async () => {
    const res = await request(app).get("/widgets/email/message?id=nosuch:42");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/account/i);
  });

  it("returns 404 for an unknown Google account", async () => {
    const res = await request(app).get(
      "/widgets/email/message?id=gmail%3Anosuch%3Aabc123",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/google/i);
  });

  it("rejects a malformed IMAP id (non-numeric uid)", async () => {
    const res = await request(app).get("/widgets/email/message?id=acc1:notanumber");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/malformed/i);
  });
});

describe("POST /widgets/email/archive", () => {
  it("rejects a missing message id", async () => {
    const res = await request(app).post("/widgets/email/archive").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/id/i);
  });

  it("rejects demo messages", async () => {
    const res = await request(app).post("/widgets/email/archive").send({ id: "demo:0" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/demo/i);
  });

  it("returns 404 for an unknown IMAP account", async () => {
    const res = await request(app).post("/widgets/email/archive").send({ id: "nosuch:42" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/account/i);
  });

  it("returns 404 for an unknown Google account", async () => {
    const res = await request(app)
      .post("/widgets/email/archive")
      .send({ id: "gmail:nosuch:abc123" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/google/i);
  });

  it("rejects a malformed IMAP id (non-numeric uid)", async () => {
    const res = await request(app).post("/widgets/email/archive").send({ id: "acc1:notanumber" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/malformed/i);
  });
});

describe("POST /widgets/email/mark-read", () => {
  it("rejects a missing message id", async () => {
    const res = await request(app).post("/widgets/email/mark-read").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/id/i);
  });

  it("rejects demo messages", async () => {
    const res = await request(app).post("/widgets/email/mark-read").send({ id: "demo:0" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/demo/i);
  });

  it("returns 404 for an unknown IMAP account", async () => {
    const res = await request(app).post("/widgets/email/mark-read").send({ id: "nosuch:42" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/account/i);
  });

  it("returns 404 for an unknown Google account", async () => {
    const res = await request(app)
      .post("/widgets/email/mark-read")
      .send({ id: "gmail:nosuch:abc123" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/google/i);
  });

  it("rejects a malformed IMAP id (non-numeric uid)", async () => {
    const res = await request(app)
      .post("/widgets/email/mark-read")
      .send({ id: "acc1:notanumber" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/malformed/i);
  });
});

// ── Calendar ────────────────────────────────────────────────────────────────
describe("GET /widgets/calendar/events", () => {
  it("returns sample events when no calendar account is configured", async () => {
    const res = await request(app).get("/widgets/calendar/events");
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(true);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.events[0]).toHaveProperty("title");
    expect(res.body.events[0]).toHaveProperty("start");
    expect(cloudGet).not.toHaveBeenCalled();
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("caps the event count via max", async () => {
    const res = await request(app).get("/widgets/calendar/events?max=1");
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeLessThanOrEqual(1);
  });

  it("returns empty live data (not sample) when an account exists but the filter matches none", async () => {
    findByService.mockImplementation((_userId: number, service: string) =>
      service === "caldav"
        ? connRow({
            service: "caldav",
            extra: JSON.stringify([
              { id: "cal1", label: "Home", url: "https://dav.example.com", username: "u", password: "p" },
            ]),
          })
        : undefined,
    );
    const res = await request(app).get("/widgets/calendar/events?accounts=deleted-id");
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(false);
    expect(res.body.events).toEqual([]);
  });
});

// ── Google OAuth flow guard ─────────────────────────────────────────────────
// /gmail/auth is unauthenticated by necessity (top-level popup navigation), so
// it must demand a single-use intent token minted via the authenticated
// /connections/google/auth-intent route.
describe("GET /widgets/gmail/auth", () => {
  it("links only in the browser that minted the intent and rejects callback replay", async () => {
    const { default: googleRouter } = await import("./google.js");
    const oauthApp = makeApp();
    oauthApp.use("/connections/google", googleRouter);
    findByService.mockImplementation((_userId, service) => service === "google"
      ? connRow({ extra: JSON.stringify({ clientId: "test-client", clientSecret: "test-secret" }) })
      : undefined);
    cloudPost.mockResolvedValue({ data: { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 } });
    cloudGet.mockResolvedValue({ data: { email: "oauth-test@example.invalid" } });
    const minted = await request(oauthApp).post("/connections/google/auth-intent");
    expect(minted.status).toBe(200);
    const intent = minted.body.intent;
    const intentCookie = minted.headers["set-cookie"][0].split(";")[0];
    expect(minted.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(minted.headers["set-cookie"][0]).toContain("SameSite=Lax");
    expect(minted.body).not.toHaveProperty("browserBinding");
    const sharedStart = await request(oauthApp).get("/widgets/gmail/auth").query({ intent });
    expect(sharedStart.status).toBe(403);
    const started = await request(oauthApp).get("/widgets/gmail/auth")
      .query({ intent, origin: "http://localhost" }).set("Cookie", intentCookie);
    expect(started.status).toBe(302);
    const state = new URL(started.headers.location).searchParams.get("state")!;
    const stateCookie = (started.headers["set-cookie"] as unknown as string[])
      .find(c => c.startsWith(`tachboard-oauth-${state}=`))!.split(";")[0];
    const startReplay = await request(oauthApp).get("/widgets/gmail/auth")
      .query({ intent }).set("Cookie", intentCookie);
    expect(startReplay.status).toBe(403);
    const sharedCallback = await request(oauthApp).get("/widgets/gmail/callback")
      .query({ state, code: "victim-code" });
    expect(sharedCallback.headers.location).toContain("google=error");
    expect(cloudPost).not.toHaveBeenCalled();
    expect(upsertRun).not.toHaveBeenCalled();
    const accepted = await request(oauthApp).get("/widgets/gmail/callback")
      .query({ state, code: "owner-code" }).set("Cookie", stateCookie);
    expect(accepted.headers.location).toContain("google=connected");
    expect(accepted.headers["set-cookie"][0]).toContain("Expires=Thu, 01 Jan 1970");
    expect(cloudPost).toHaveBeenCalledTimes(1);
    expect(upsertRun.mock.calls.every(call => call[0] === 1)).toBe(true);
    expect(upsertRun).toHaveBeenCalledTimes(2); // Gmail and Calendar mirror.
    const replay = await request(oauthApp).get("/widgets/gmail/callback")
      .query({ state, code: "replay" }).set("Cookie", stateCookie);
    expect(replay.headers.location).toContain("google=error");
    expect(cloudPost).toHaveBeenCalledTimes(1);
    expect(upsertRun).toHaveBeenCalledTimes(2);
  });

  it("expires browser-bound intents and pending states", async () => {
    const { createGoogleAuthIntent, consumeGoogleAuthIntent, createGooglePendingAuth, consumeGooglePendingAuth } =
      await import("../lib/google.js");
    vi.useFakeTimers();
    try {
      const binding = "a".repeat(64);
      const intent = createGoogleAuthIntent(1, binding);
      const state = createGooglePendingAuth(1, "http://localhost/callback", "http://localhost/settings", binding);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(consumeGoogleAuthIntent(intent, binding)).toBeNull();
      vi.advanceTimersByTime(5 * 60_000);
      expect(consumeGooglePendingAuth(state, binding)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a shared auth intent without its initiating browser cookie", async () => {
    const { createGoogleAuthIntent } = await import("../lib/google.js");
    const intent = createGoogleAuthIntent(1, "a".repeat(64));
    for (const cookie of [undefined, `tachboard-oauth-${intent}=${"b".repeat(64)}`]) {
      const req = request(app).get(`/widgets/gmail/auth?intent=${intent}`);
      if (cookie) req.set("Cookie", cookie);
      expect((await req).status).toBe(403);
    }
    expect(cloudPost).not.toHaveBeenCalled();
    expect(upsertRun).not.toHaveBeenCalled();
  });
  it("rejects requests without an intent token", async () => {
    const res = await request(app).get("/widgets/gmail/auth");
    expect(res.status).toBe(403);
  });

  it("rejects requests with an unknown intent token", async () => {
    const res = await request(app).get("/widgets/gmail/auth?intent=not-a-real-token");
    expect(res.status).toBe(403);
  });

  it("accepts a freshly minted intent exactly once", async () => {
    const { createGoogleAuthIntent } = await import("../lib/google.js");
    const binding = "a".repeat(64);
    const intent = createGoogleAuthIntent(1, binding);
    // A valid browser-bound intent passes the guard, whether credentials
    // come from the test environment (302) or are unconfigured (400).
    const first = await request(app).get(`/widgets/gmail/auth?intent=${intent}`)
      .set("Cookie", `tachboard-oauth-${intent}=${binding}`);
    expect([400, 302]).toContain(first.status);
    // The intent is single-use: replaying it must be rejected.
    const second = await request(app).get(`/widgets/gmail/auth?intent=${intent}`);
    expect(second.status).toBe(403);
  });
});

describe("GET /widgets/gmail/callback", () => {
  it("rejects a shared Google authorization URL without matching browser proof", async () => {
    const { createGooglePendingAuth, consumeGooglePendingAuth } = await import("../lib/google.js");
    const binding = "a".repeat(64);
    const state = createGooglePendingAuth(1, "http://localhost/callback", "http://localhost/settings", binding);
    for (const cookie of [undefined, `tachboard-oauth-${state}=${"b".repeat(64)}`]) {
      const req = request(app).get("/widgets/gmail/callback").query({ state, code: "victim-code" });
      if (cookie) req.set("Cookie", cookie);
      const response = await req;
      expect(response.headers.location).toContain("google=error");
      expect(cloudPost).not.toHaveBeenCalled();
      expect(upsertRun).not.toHaveBeenCalled();
    }
    expect(consumeGooglePendingAuth(state, binding)?.userId).toBe(1);
    expect(consumeGooglePendingAuth(state, binding)).toBeNull();
  });

  it("redirects to settings with an error when the state is unknown", async () => {
    // Without a pending state created by a legitimate /gmail/auth run, the
    // callback must not exchange the code or persist any tokens.
    const res = await request(app).get("/widgets/gmail/callback?code=abc&state=bogus");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("google=error");
    expect(cloudPost).not.toHaveBeenCalled();
    expect(upsertRun).not.toHaveBeenCalled();
  });
});

// ── Weather (server-side cache) ───────────────────────────────────────────────
describe("GET /widgets/weather", () => {
  it("caches forecast + reverse-geocode responses per rounded coords and units", async () => {
    invalidateFetchCache("weather:");
    cloudGet.mockImplementation(async (url: string) => {
      if (url.includes("bigdatacloud")) return { data: { city: "Springfield" } };
      return {
        data: {
          current: { temperature_2m: 21, apparent_temperature: 20, weather_code: 1, is_day: 1 },
          daily: {
            time: ["2026-07-03"],
            weather_code: [1],
            temperature_2m_max: [25],
            temperature_2m_min: [15],
          },
        },
      };
    });

    const first = await request(app).get("/widgets/weather?lat=40.123&lon=-75.456&units=c");
    expect(first.status).toBe(200);
    expect(first.body.name).toBe("Springfield");
    expect(first.body.temp).toBe(21);
    // one reverse-geocode + one forecast call
    expect(cloudGet).toHaveBeenCalledTimes(2);

    // A second request for a coordinate that rounds to the same 2-decimal key
    // must be served entirely from cache — no new upstream calls.
    const second = await request(app).get("/widgets/weather?lat=40.1201&lon=-75.4599&units=c");
    expect(second.status).toBe(200);
    expect(second.body.temp).toBe(21);
    expect(cloudGet).toHaveBeenCalledTimes(2);

    // Different units → separate forecast entry, but the reverse-geocode
    // (units-independent) is still cached.
    const third = await request(app).get("/widgets/weather?lat=40.123&lon=-75.456&units=f");
    expect(third.status).toBe(200);
    expect(cloudGet).toHaveBeenCalledTimes(3);
  });

  it("dedupes concurrent requests into a single upstream call", async () => {
    invalidateFetchCache("weather:");
    let forecastCalls = 0;
    cloudGet.mockImplementation(async (url: string) => {
      if (url.includes("bigdatacloud")) return { data: { city: "Springfield" } };
      forecastCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        data: {
          current: { temperature_2m: 18, apparent_temperature: 17, weather_code: 2, is_day: 0 },
          daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [] },
        },
      };
    });

    const [a, b, c] = await Promise.all([
      request(app).get("/widgets/weather?lat=51.5&lon=-0.12&units=c"),
      request(app).get("/widgets/weather?lat=51.5&lon=-0.12&units=c"),
      request(app).get("/widgets/weather?lat=51.5&lon=-0.12&units=c"),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    expect(forecastCalls).toBe(1);
  });

  it("does not cache failures — a transient outage recovers on the next poll", async () => {
    invalidateFetchCache("weather:");
    cloudGet.mockImplementation(async (url: string) => {
      if (url.includes("bigdatacloud")) return { data: { city: "Springfield" } };
      throw httpError(503);
    });

    const failed = await request(app).get("/widgets/weather?lat=10&lon=20&units=c");
    expect(failed.status).toBe(502);

    cloudGet.mockImplementation(async (url: string) => {
      if (url.includes("bigdatacloud")) return { data: { city: "Springfield" } };
      return {
        data: {
          current: { temperature_2m: 30, apparent_temperature: 32, weather_code: 0, is_day: 1 },
          daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [] },
        },
      };
    });
    const recovered = await request(app).get("/widgets/weather?lat=10&lon=20&units=c");
    expect(recovered.status).toBe(200);
    expect(recovered.body.temp).toBe(30);
  });

  it("caches city geocoding so repeat city lookups skip the geocoder", async () => {
    invalidateFetchCache("weather:");
    let geocodeCalls = 0;
    cloudGet.mockImplementation(async (url: string) => {
      if (url.includes("geocoding-api")) {
        geocodeCalls += 1;
        return {
          data: { results: [{ latitude: 48.85, longitude: 2.35, name: "Paris", country: "France" }] },
        };
      }
      return {
        data: {
          current: { temperature_2m: 19, apparent_temperature: 18, weather_code: 3, is_day: 1 },
          daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [] },
        },
      };
    });

    const first = await request(app).get("/widgets/weather?city=Paris&units=c");
    expect(first.status).toBe(200);
    expect(first.body.name).toBe("Paris, France");
    expect(geocodeCalls).toBe(1);

    // Same city with different casing hits the cached geocode entry.
    const second = await request(app).get("/widgets/weather?city=paris&units=c");
    expect(second.status).toBe(200);
    expect(geocodeCalls).toBe(1);
  });
});

// ── Audio Player favorite / like toggling ─────────────────────────────────────
describe("POST /widgets/audioplayer/favorite", () => {
  // An axios-style error carrying an HTTP status AND a response body, so we can
  // assert the 502 reason surfaces the server's real rejection (status + body),
  // not a flat generic string.
  function axiosErrorWithBody(status: number, body: unknown): Error {
    return Object.assign(new Error(`status ${status}`), {
      isAxiosError: true,
      code: "ERR_BAD_REQUEST",
      response: { status, data: body },
    });
  }

  // Wrap a Subsonic REST payload in the standard envelope the server unwraps.
  function subsonicOk(): { data: { "subsonic-response": { status: string } } } {
    return { data: { "subsonic-response": { status: "ok" } } };
  }

  it("Plex like writes rating=10 to /:/rate and returns liked", async () => {
    findByService.mockReturnValue(
      connRow({ service: "plex", url: "https://plex.local", extra: JSON.stringify({ token: "plex-token" }) }),
    );
    httpPut.mockResolvedValue({ data: {} });

    const res = await request(app)
      .post("/widgets/audioplayer/favorite")
      .send({ source: "plex", id: "/library/metadata/123", liked: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: true });
    const [url, payload, opts] = httpPut.mock.calls[0];
    expect(url).toBe("https://plex.local/:/rate");
    expect(payload).toBeNull();
    expect(opts.headers["X-Plex-Token"]).toBe("plex-token");
    expect(opts.params.key).toBe("/library/metadata/123");
    expect(opts.params.rating).toBe(10);
  });

  it("Plex unlike writes rating=0 (not the -1 clear sentinel Plex rejects)", async () => {
    findByService.mockReturnValue(
      connRow({ service: "plex", url: "https://plex.local", extra: JSON.stringify({ token: "plex-token" }) }),
    );
    httpPut.mockResolvedValue({ data: {} });

    const res = await request(app)
      .post("/widgets/audioplayer/favorite")
      .send({ source: "plex", id: "/library/metadata/123", liked: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: false });
    const [, , opts] = httpPut.mock.calls[0];
    expect(opts.params.rating).toBe(0);
  });

  it("Subsonic like calls star.view with the track id", async () => {
    findByService.mockReturnValue(
      connRow({ service: "subsonic", url: "https://nav.local", username: "u", password: "p" }),
    );
    httpGet.mockResolvedValue(subsonicOk());

    const res = await request(app)
      .post("/widgets/audioplayer/favorite")
      .send({ source: "subsonic", id: "song-1", liked: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: true });
    const [url, config] = httpGet.mock.calls[0];
    expect(url).toBe("https://nav.local/rest/star.view");
    expect(config.params.id).toBe("song-1");
  });

  it("Subsonic unlike calls unstar.view with the track id", async () => {
    findByService.mockReturnValue(
      connRow({ service: "subsonic", url: "https://nav.local", username: "u", password: "p" }),
    );
    httpGet.mockResolvedValue(subsonicOk());

    const res = await request(app)
      .post("/widgets/audioplayer/favorite")
      .send({ source: "subsonic", id: "song-1", liked: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: false });
    const [url, config] = httpGet.mock.calls[0];
    expect(url).toBe("https://nav.local/rest/unstar.view");
    expect(config.params.id).toBe("song-1");
  });

  it("returns 404 when Plex is unconfigured (no upstream call)", async () => {
    // findByService defaults to undefined → no saved connection.
    const res = await request(app)
      .post("/widgets/audioplayer/favorite")
      .send({ source: "plex", id: "/library/metadata/123", liked: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no plex connection/i);
    expect(httpPut).not.toHaveBeenCalled();
  });

  it("returns 404 when Subsonic is unconfigured (no upstream call)", async () => {
    const res = await request(app)
      .post("/widgets/audioplayer/favorite")
      .send({ source: "subsonic", id: "song-1", liked: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no subsonic connection/i);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("returns 502 with the real Plex status+body on upstream failure", async () => {
    findByService.mockReturnValue(
      connRow({ service: "plex", url: "https://plex.local", extra: JSON.stringify({ token: "plex-token" }) }),
    );
    httpPut.mockRejectedValue(axiosErrorWithBody(400, "rating out of range"));

    const res = await request(app)
      .post("/widgets/audioplayer/favorite")
      .send({ source: "plex", id: "/library/metadata/123", liked: false });

    expect(res.status).toBe(502);
    // The message must carry the actual status AND body, not a flat generic string.
    expect(res.body.error).toContain("HTTP 400");
    expect(res.body.error).toContain("rating out of range");
  });

  it("returns 502 with the real Subsonic error message on a failed envelope", async () => {
    findByService.mockReturnValue(
      connRow({ service: "subsonic", url: "https://nav.local", username: "u", password: "p" }),
    );
    // Subsonic always answers HTTP 200; the real failure lives in the envelope.
    httpGet.mockResolvedValue({
      data: { "subsonic-response": { status: "failed", error: { message: "Wrong username or password" } } },
    });

    const res = await request(app)
      .post("/widgets/audioplayer/favorite")
      .send({ source: "subsonic", id: "song-1", liked: true });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Wrong username or password");
  });
});
