import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { parseVersion, isNewerVersion, isUpdateCheckDisabled, getUpdateInfo, resetUpdateCheckCache, appVersion } =
  await import("./updateCheck.js");

const ENV_KEYS = ["APP_VERSION", "APP_REPO", "UPDATE_CHECK_DISABLED"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetUpdateCheckCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("version parsing/comparison", () => {
  it("parses v-prefixed and plain versions", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("10.0")).toEqual([10, 0]);
    expect(parseVersion("dev")).toBeNull();
    expect(parseVersion("v1.2.3-beta")).toBeNull();
  });

  it("compares versions numerically with mixed lengths", () => {
    expect(isNewerVersion("v1.2.4", "v1.2.3")).toBe(true);
    expect(isNewerVersion("v1.10.0", "v1.9.9")).toBe(true);
    expect(isNewerVersion("v1.2.3", "v1.2.3")).toBe(false);
    expect(isNewerVersion("v1.2", "v1.2.0")).toBe(false);
    expect(isNewerVersion("v2.0.0", "dev")).toBe(false); // unparseable current → never nag
  });
});

describe("isUpdateCheckDisabled", () => {
  it("is disabled when no repo is known", () => {
    expect(isUpdateCheckDisabled()).toBe(true);
  });

  it("is enabled when a repo is set, unless the opt-out flag is set", () => {
    process.env.APP_REPO = "acme/tachboard";
    expect(isUpdateCheckDisabled()).toBe(false);
    process.env.UPDATE_CHECK_DISABLED = "true";
    expect(isUpdateCheckDisabled()).toBe(true);
  });
});

describe("getUpdateInfo", () => {
  it("returns defaults without fetching when disabled", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const info = await getUpdateInfo();
    expect(info).toEqual({
      currentVersion: appVersion(),
      latestVersion: null,
      releaseUrl: null,
      updateAvailable: false,
      checkEnabled: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an available update and caches the result", async () => {
    process.env.APP_REPO = "acme/tachboard";
    process.env.APP_VERSION = "v1.0.0";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v1.1.0", html_url: "https://example.com/rel" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const info = await getUpdateInfo();
    expect(info.updateAvailable).toBe(true);
    expect(info.latestVersion).toBe("v1.1.0");
    expect(info.releaseUrl).toBe("https://example.com/rel");

    // Second call within the check interval must NOT hit the network again.
    await getUpdateInfo();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not flag an update when already on the latest release", async () => {
    process.env.APP_REPO = "acme/tachboard";
    process.env.APP_VERSION = "v1.1.0";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v1.1.0", html_url: "https://example.com/rel" }),
      }),
    );
    const info = await getUpdateInfo();
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe("v1.1.0");
  });

  it("is failure-tolerant: network errors yield no update info, cached briefly", async () => {
    process.env.APP_REPO = "acme/tachboard";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchSpy);

    const info = await getUpdateInfo();
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBeNull();
    expect(info.checkEnabled).toBe(true);

    // Failure is cached — an immediate re-poll must not re-fetch.
    await getUpdateInfo();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent callers onto one request", async () => {
    process.env.APP_REPO = "acme/tachboard";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v9.9.9", html_url: "u" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    await Promise.all([getUpdateInfo(), getUpdateInfo(), getUpdateInfo()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
