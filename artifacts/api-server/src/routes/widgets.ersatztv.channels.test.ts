import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Same harness as widgets.videoplayer.test.ts: pass-through auth, stubbed DB +
// HTTP clients, quiet logger. verifyToken is also mocked because the stream
// proxy authenticates via Bearer header OR ?token= query param.
vi.mock("../lib/auth.js", () => ({
  requireAuth: (req: { user?: { userId: number } }, _res: unknown, next: () => void) => {
    req.user = { userId: 1 };
    next();
  },
  verifyToken: (token: string) => {
    if (token !== "good-token") throw new Error("bad token");
    return { userId: 1, username: "tester" };
  },
}));

const findByService = vi.fn();
vi.mock("../lib/db.js", () => ({
  userStmts: { findFirst: { get: () => ({ id: 1 }) } },
  connectionStmts: {
    findByService: { get: (...args: unknown[]) => findByService(...args) },
    upsert: { run: vi.fn() },
  },
}));

const httpGet = vi.fn();
vi.mock("../lib/http.js", () => ({
  httpClient: {
    get: (...args: unknown[]) => httpGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
  cloudHttpClient: { get: vi.fn(), post: vi.fn() },
  normalizeBaseUrl: (url: string | undefined | null) => {
    const trimmed = url?.trim();
    if (!trimmed) return undefined;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    return withScheme.replace(/\/+$/, "");
  },
  normalizeHttpError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  describeHttpError: (err: unknown) => {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    return {
      status: e?.response?.status ?? null,
      code: null,
      message: e?.message ?? String(err),
      body: e?.response?.data ?? null,
    };
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// No real game-server queries.
vi.mock("../lib/gameQuery.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/gameQuery.js")>();
  return { ...real, queryGamePlayers: vi.fn() };
});

const { default: widgetsRouter, rewriteErsatzPlaylist } = await import("./widgets.js");

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/widgets", widgetsRouter);
  return app;
}

const ersatzRow = { url: "http://ersatz.local:8409", api_key: null, extra: null };

// Minimal M3U + XMLTV fixtures shaped like ErsatzTV's real output.
const M3U = [
  "#EXTM3U",
  '#EXTINF:0 tvg-id="1" tvg-name="Movies" CUID="1" tvg-chno="1", Movies',
  "http://ersatz.local:8409/iptv/channel/1.m3u8",
  '#EXTINF:0 tvg-id="2" tvg-name="Cartoons" CUID="2" tvg-chno="2", Cartoons',
  "http://ersatz.local:8409/iptv/channel/2.m3u8",
].join("\n");

function xmltvAround(now: number): string {
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
  };
  // Includes two future programmes on channel 1 listed out of order to prove
  // "up next" picks the earliest upcoming start, not the first in the feed.
  // Also includes an already-finished programme and one starting beyond the
  // ~3h guide horizon — both must be excluded from the schedule window.
  return `<?xml version="1.0"?>
<tv>
  <programme start="${fmt(now - 120_000)}" stop="${fmt(now - 60_000)}" channel="1">
    <title>Already Over</title>
  </programme>
  <programme start="${fmt(now - 60_000)}" stop="${fmt(now + 60_000)}" channel="1">
    <title>The Maltese Falcon</title>
  </programme>
  <programme start="${fmt(now + 120_000)}" stop="${fmt(now + 180_000)}" channel="1">
    <title>Later Feature</title>
  </programme>
  <programme start="${fmt(now + 60_000)}" stop="${fmt(now + 120_000)}" channel="1">
    <title>Casablanca</title>
  </programme>
  <programme start="${fmt(now + 4 * 3_600_000)}" stop="${fmt(now + 5 * 3_600_000)}" channel="1">
    <title>Beyond Horizon</title>
  </programme>
</tv>`;
}

beforeEach(() => {
  vi.clearAllMocks();
  findByService.mockReturnValue(undefined);
  delete process.env["ERSATZTV_URL"];
});

describe("GET /api/widgets/ersatztv/channels", () => {
  it("returns a sample lineup with no stream URLs when unconfigured", async () => {
    const res = await request(makeApp()).get("/api/widgets/ersatztv/channels");
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(true);
    expect(res.body.channels.length).toBeGreaterThan(0);
    for (const c of res.body.channels) expect(c.streamUrl).toBeNull();
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("returns the real lineup with proxy stream URLs and now-airing titles", async () => {
    findByService.mockImplementation((_userId: number, service: string) =>
      service === "ersatztv" ? ersatzRow : undefined,
    );
    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/iptv/channels.m3u")) return Promise.resolve({ data: M3U });
      if (url.endsWith("/iptv/xmltv.xml"))
        return Promise.resolve({ data: xmltvAround(Date.now()) });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const res = await request(makeApp()).get("/api/widgets/ersatztv/channels");
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(false);
    expect(res.body.channels).toHaveLength(2);
    const [ch1, ch2] = res.body.channels;
    expect(ch1).toMatchObject({
      number: "1",
      name: "Movies",
      nowPlaying: "The Maltese Falcon",
      upNextTitle: "Casablanca",
      streamUrl: "/api/widgets/ersatztv/stream/iptv/channel/1.m3u8",
    });
    // Up-next start is the earliest future programme, serialized as ISO 8601.
    const upNextMs = Date.parse(ch1.upNextStart);
    expect(Number.isNaN(upNextMs)).toBe(false);
    expect(upNextMs).toBeGreaterThan(Date.now());
    expect(upNextMs).toBeLessThan(Date.now() + 90_000);
    // The current programme's window (ISO 8601) brackets "now".
    const npStart = Date.parse(ch1.nowPlayingStart);
    const npStop = Date.parse(ch1.nowPlayingStop);
    expect(Number.isNaN(npStart)).toBe(false);
    expect(Number.isNaN(npStop)).toBe(false);
    expect(npStart).toBeLessThanOrEqual(Date.now());
    expect(npStop).toBeGreaterThan(Date.now());
    expect(ch2.nowPlaying).toBeNull();
    expect(ch2.nowPlayingStart).toBeNull();
    expect(ch2.nowPlayingStop).toBeNull();
    expect(ch2.upNextTitle).toBeNull();
    expect(ch2.upNextStart).toBeNull();
    expect(ch2.streamUrl).toBe("/api/widgets/ersatztv/stream/iptv/channel/2.m3u8");
    // Schedule window: current + upcoming programmes sorted by start;
    // finished and beyond-horizon programmes are excluded.
    expect(ch1.programs.map((p: { title: string }) => p.title)).toEqual([
      "The Maltese Falcon",
      "Casablanca",
      "Later Feature",
    ]);
    for (const p of ch1.programs) {
      expect(Number.isNaN(Date.parse(p.start))).toBe(false);
      expect(Number.isNaN(Date.parse(p.stop))).toBe(false);
      expect(Date.parse(p.stop)).toBeGreaterThan(Date.parse(p.start));
    }
    // A channel with no guide data gets an empty schedule, not a missing key.
    expect(ch2.programs).toEqual([]);
  });

  it("includes a multi-hour schedule per channel in the sample lineup", async () => {
    const res = await request(makeApp()).get("/api/widgets/ersatztv/channels");
    expect(res.status).toBe(200);
    for (const c of res.body.channels) {
      expect(Array.isArray(c.programs)).toBe(true);
      expect(c.programs.length).toBeGreaterThan(1);
      // Blocks are contiguous and cover at least the next two hours.
      const last = c.programs[c.programs.length - 1];
      expect(Date.parse(last.stop)).toBeGreaterThan(Date.now() + 2 * 3_600_000);
      for (let i = 1; i < c.programs.length; i++) {
        expect(c.programs[i].start).toBe(c.programs[i - 1].stop);
      }
    }
  });

  it("still returns the channel lineup when only the XMLTV guide fails", async () => {
    findByService.mockImplementation((_userId: number, service: string) =>
      service === "ersatztv" ? ersatzRow : undefined,
    );
    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/iptv/channels.m3u")) return Promise.resolve({ data: M3U });
      if (url.endsWith("/iptv/xmltv.xml"))
        return Promise.reject(new Error("guide timeout"));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const res = await request(makeApp()).get("/api/widgets/ersatztv/channels");
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(false);
    expect(res.body.channels).toHaveLength(2);
    for (const c of res.body.channels) {
      expect(c.nowPlaying).toBeNull();
      expect(c.upNextTitle).toBeNull();
      expect(c.programs).toEqual([]);
      expect(c.streamUrl).toMatch(/^\/api\/widgets\/ersatztv\/stream\//);
    }
  });

  it("returns 502 when configured but the server fails", async () => {
    findByService.mockImplementation((_userId: number, service: string) =>
      service === "ersatztv" ? ersatzRow : undefined,
    );
    httpGet.mockRejectedValue(new Error("connection refused"));
    const res = await request(makeApp()).get("/api/widgets/ersatztv/channels");
    expect(res.status).toBe(502);
  });
});

describe("GET /api/widgets/ersatztv (monitoring)", () => {
  it("includes up-next title/start per channel in the sample data", async () => {
    const res = await request(makeApp()).get("/api/widgets/ersatztv");
    expect(res.status).toBe(200);
    const withUpNext = res.body.channels.filter(
      (c: { upNextTitle: string | null }) => c.upNextTitle != null,
    );
    expect(withUpNext.length).toBeGreaterThan(0);
    for (const c of res.body.channels) {
      expect(c).toHaveProperty("upNextTitle");
      expect(c).toHaveProperty("upNextStart");
      if (c.upNextTitle != null) {
        expect(Number.isNaN(Date.parse(c.upNextStart))).toBe(false);
      } else {
        expect(c.upNextStart).toBeNull();
      }
    }
  });

  it("includes up-next title/start per channel from the real guide", async () => {
    findByService.mockImplementation((_userId: number, service: string) =>
      service === "ersatztv" ? ersatzRow : undefined,
    );
    httpGet.mockImplementation((url: string) => {
      if (url.endsWith("/iptv/channels.m3u")) return Promise.resolve({ data: M3U });
      if (url.endsWith("/iptv/xmltv.xml"))
        return Promise.resolve({ data: xmltvAround(Date.now()) });
      if (url.endsWith("/api/sessions")) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const res = await request(makeApp()).get("/api/widgets/ersatztv");
    expect(res.status).toBe(200);
    const [ch1, ch2] = res.body.channels;
    expect(ch1).toMatchObject({
      number: "1",
      nowPlaying: "The Maltese Falcon",
      upNextTitle: "Casablanca",
    });
    const upNextMs = Date.parse(ch1.upNextStart);
    expect(Number.isNaN(upNextMs)).toBe(false);
    expect(upNextMs).toBeGreaterThan(Date.now());
    expect(upNextMs).toBeLessThan(Date.now() + 90_000);
    expect(ch2.upNextTitle).toBeNull();
    expect(ch2.upNextStart).toBeNull();
  });
});

describe("GET /api/widgets/ersatztv/stream/*", () => {
  const streamPath = "/api/widgets/ersatztv/stream/iptv/channel/1.m3u8";

  function configure() {
    findByService.mockImplementation((_userId: number, service: string) =>
      service === "ersatztv" ? ersatzRow : undefined,
    );
  }

  it("rejects requests with no token at all", async () => {
    configure();
    const res = await request(makeApp()).get(streamPath);
    expect(res.status).toBe(401);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("rejects an invalid ?token=", async () => {
    configure();
    const res = await request(makeApp()).get(`${streamPath}?token=nope`);
    expect(res.status).toBe(401);
  });

  it("accepts a Bearer header", async () => {
    configure();
    httpGet.mockResolvedValue({
      data: Buffer.from("segmentbytes"),
      headers: { "content-type": "video/mp2t" },
      request: {},
    });
    const res = await request(makeApp())
      .get("/api/widgets/ersatztv/stream/iptv/session/abc/seg1.ts")
      .set("Authorization", "Bearer good-token");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("video/mp2t");
  });

  it("404s when ErsatzTV is not configured", async () => {
    const res = await request(makeApp()).get(`${streamPath}?token=good-token`);
    expect(res.status).toBe(404);
  });

  it("rejects paths outside /iptv/", async () => {
    configure();
    const res = await request(makeApp()).get(
      "/api/widgets/ersatztv/stream/api/settings?token=good-token",
    );
    expect(res.status).toBe(400);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("rewrites playlist URIs through the proxy and keeps the token", async () => {
    configure();
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/track.m3u8"',
      "#EXTINF:4.0,",
      "seg1.ts",
      "#EXTINF:4.0,",
      "http://ersatz.local:8409/iptv/session/xyz/seg2.ts",
      "#EXTINF:4.0,",
      "https://other.example.com/seg3.ts",
    ].join("\n");
    httpGet.mockResolvedValue({
      data: Buffer.from(playlist),
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      // Simulate ErsatzTV's redirect into a per-session playlist path.
      request: { res: { responseUrl: "http://ersatz.local:8409/iptv/session/xyz/live.m3u8" } },
    });
    const res = await request(makeApp()).get(`${streamPath}?token=good-token`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("mpegurl");
    const body = res.text;
    expect(body).toContain(
      "/api/widgets/ersatztv/stream/iptv/session/xyz/seg1.ts?token=good-token",
    );
    expect(body).toContain(
      "/api/widgets/ersatztv/stream/iptv/session/xyz/seg2.ts?token=good-token",
    );
    expect(body).toContain(
      'URI="/api/widgets/ersatztv/stream/iptv/session/xyz/audio/track.m3u8?token=good-token"',
    );
    // Foreign-origin URIs are left untouched.
    expect(body).toContain("https://other.example.com/seg3.ts");
    // The upstream fetch went to the ErsatzTV host without our token.
    const calledUrl = httpGet.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://ersatz.local:8409/iptv/channel/1.m3u8");
  });

  it("passes media segments through untouched", async () => {
    configure();
    const bytes = Buffer.from([0x47, 0x40, 0x11, 0x10]);
    httpGet.mockResolvedValue({
      data: bytes,
      headers: { "content-type": "video/mp2t" },
      request: {},
    });
    const res = await request(makeApp()).get(
      "/api/widgets/ersatztv/stream/iptv/session/xyz/seg1.ts?token=good-token",
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it("returns 502 when the upstream fetch fails", async () => {
    configure();
    httpGet.mockRejectedValue(new Error("timeout"));
    const res = await request(makeApp()).get(`${streamPath}?token=good-token`);
    expect(res.status).toBe(502);
  });
});

describe("rewriteErsatzPlaylist", () => {
  it("resolves relative URIs against the upstream URL", () => {
    const out = rewriteErsatzPlaylist(
      "seg1.ts",
      "http://host:8409/iptv/session/abc/live.m3u8",
      "tok",
    );
    expect(out).toBe("/api/widgets/ersatztv/stream/iptv/session/abc/seg1.ts?token=tok");
  });

  it("preserves existing query params on rewritten URIs", () => {
    const out = rewriteErsatzPlaylist(
      "seg1.ts?mode=segmenter",
      "http://host:8409/iptv/session/abc/live.m3u8",
      "tok",
    );
    expect(out).toBe(
      "/api/widgets/ersatztv/stream/iptv/session/abc/seg1.ts?mode=segmenter&token=tok",
    );
  });
});
