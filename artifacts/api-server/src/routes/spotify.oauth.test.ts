import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { post, persist, find } = vi.hoisted(() => ({
  post: vi.fn(), persist: vi.fn(), find: vi.fn(),
}));
vi.mock("../lib/auth.js", () => ({
  requireAuth: (req: { user?: { userId: number } }, _res: unknown, next: () => void) => {
    req.user = { userId: 7 };
    next();
  },
}));
vi.mock("../lib/db.js", () => ({
  connectionStmts: { findByService: { get: find }, upsert: { run: persist } },
}));
vi.mock("../lib/http.js", () => ({
  cloudHttpClient: { post, get: vi.fn() }, normalizeHttpError: () => "failed",
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import router from "./spotify.js";
import { createPendingAuth, consumePendingAuth } from "../lib/spotify.js";
import { newBrowserBinding } from "../lib/oauthBrowser.js";

const app = express();
app.use(express.json());
app.use("/api/connections/spotify", router);
const callback = "/api/connections/spotify/callback";

beforeEach(() => {
  vi.clearAllMocks();
  find.mockReturnValue({ api_key: "test-client", password: "test-secret", extra: null });
  post.mockResolvedValue({ data: { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 } });
});
afterEach(() => vi.useRealTimers());

async function start() {
  const response = await request(app).post("/api/connections/spotify/authorize")
    .send({ origin: "http://localhost" });
  expect(response.status).toBe(200);
  const state = new URL(response.body.url).searchParams.get("state")!;
  const cookie = (response.headers["set-cookie"] as unknown as string[])[0];
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Path=/api");
  expect(response.body.url).not.toContain(cookie.split("=")[1].split(";")[0]);
  return { state, cookie: cookie.split(";")[0] };
}

describe("Spotify browser-bound account linking", () => {
  it("rejects a shared authorization URL in a different browser, then accepts the initiating browser once", async () => {
    const flow = await start();
    for (const cookie of [undefined, `tachboard-oauth-${flow.state}=${newBrowserBinding()}`]) {
      const req = request(app).get(callback).query({ state: flow.state, code: "victim-code" });
      if (cookie) req.set("Cookie", cookie);
      const response = await req;
      expect(response.headers.location).toContain("spotify=error");
      expect(post).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    }
    const accepted = await request(app).get(callback).query({ state: flow.state, code: "owner-code" })
      .set("Cookie", flow.cookie);
    expect(accepted.headers.location).toContain("spotify=connected");
    expect(accepted.headers["set-cookie"][0]).toContain("Expires=Thu, 01 Jan 1970");
    expect(post).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toBe(7);
    const replay = await request(app).get(callback).query({ state: flow.state, code: "replay" })
      .set("Cookie", flow.cookie);
    expect(replay.headers.location).toContain("spotify=error");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("rejects cookies from a separate attempt", async () => {
    const first = await start();
    const second = await start();
    const response = await request(app).get(callback).query({ state: first.state, code: "code" })
      .set("Cookie", second.cookie);
    expect(response.headers.location).toContain("spotify=error");
    expect(persist).not.toHaveBeenCalled();
  });

  it("consumes a denied callback without exchanging a code", async () => {
    const flow = await start();
    const response = await request(app).get(callback).query({ state: flow.state, error: "access_denied" })
      .set("Cookie", flow.cookie);
    expect(response.headers.location).toContain("spotify=error");
    expect(post).not.toHaveBeenCalled();
    const retry = await request(app).get(callback).query({ state: flow.state, code: "code" })
      .set("Cookie", flow.cookie);
    expect(retry.headers.location).toContain("spotify=error");
    expect(persist).not.toHaveBeenCalled();
  });

  it("expires pending states even with the correct browser proof", () => {
    vi.useFakeTimers();
    const binding = newBrowserBinding();
    const state = createPendingAuth(7, "http://localhost/callback", "http://localhost/settings", binding);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(consumePendingAuth(state, binding)).toBeNull();
  });

  it("sets Secure behind an HTTPS proxy", async () => {
    const response = await request(app).post("/api/connections/spotify/authorize")
      .set("X-Forwarded-Proto", "https").send({});
    expect(response.headers["set-cookie"][0]).toContain("Secure");
  });
});