/**
 * Update check — polls the GitHub releases API (at most once a day) to see
 * whether a newer release than the running build exists.
 *
 * Design constraints (see Settings "About" card):
 *   - Fully failure-tolerant: any error just means "no update info" — never
 *     throws out of getUpdateInfo(), never fails the /version endpoint.
 *   - Disableable via UPDATE_CHECK_DISABLED=1|true|yes. Also implicitly off
 *     when no repository is known (local dev builds).
 *   - Version + repo are stamped into release builds by esbuild `define`
 *     (__APP_VERSION__ / __APP_REPO__ from the git tag in the release
 *     workflow); env vars APP_VERSION / APP_REPO act as runtime overrides
 *     and as the source in tests/dev where the defines don't exist.
 */
import { logger } from "./logger.js";

declare const __APP_VERSION__: string | undefined;
declare const __APP_REPO__: string | undefined;

const buildVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "";
const buildRepo = typeof __APP_REPO__ !== "undefined" ? __APP_REPO__ : "";

export function appVersion(): string {
  return process.env.APP_VERSION || buildVersion || "dev";
}

function appRepo(): string {
  // "owner/name" GitHub slug.
  return process.env.APP_REPO || buildRepo || "";
}

export function isUpdateCheckDisabled(): boolean {
  const flag = (process.env.UPDATE_CHECK_DISABLED ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  return appRepo() === "";
}

/** Parse "v1.2.3" / "1.2.3" into numeric parts; null when not a version. */
export function parseVersion(raw: string): number[] | null {
  const m = raw.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+)*$/.test(m)) return null;
  return m.split(".").map(Number);
}

/** True when `latest` is strictly newer than `current`. Unparseable → false. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // successful checks: once a day
const FAILURE_RETRY_MS = 60 * 60 * 1000; // failed checks: retry after an hour

type LatestRelease = { version: string; url: string } | null;

let cache: { at: number; ok: boolean; latest: LatestRelease } | null = null;
let inflight: Promise<LatestRelease> | null = null;

/** Test hook. */
export function resetUpdateCheckCache(): void {
  cache = null;
  inflight = null;
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  const repo = appRepo();
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "tachboard-update-check",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub releases API responded ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
  if (typeof body.tag_name !== "string" || body.tag_name === "") return null;
  return {
    version: body.tag_name,
    url: typeof body.html_url === "string" ? body.html_url : `https://github.com/${repo}/releases/latest`,
  };
}

export type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  checkEnabled: boolean;
};

export async function getUpdateInfo(): Promise<UpdateInfo> {
  const currentVersion = appVersion();
  const base: UpdateInfo = {
    currentVersion,
    latestVersion: null,
    releaseUrl: null,
    updateAvailable: false,
    checkEnabled: !isUpdateCheckDisabled(),
  };
  if (!base.checkEnabled) return base;

  const now = Date.now();
  const fresh = cache && now - cache.at < (cache.ok ? CHECK_INTERVAL_MS : FAILURE_RETRY_MS);
  if (!fresh) {
    // Dedupe concurrent callers onto one request; never let a failure escape.
    inflight ??= fetchLatestRelease()
      .then((latest) => {
        cache = { at: Date.now(), ok: true, latest };
        return latest;
      })
      .catch((err) => {
        logger.debug({ err }, "update check failed (will retry later)");
        cache = { at: Date.now(), ok: false, latest: null };
        return null;
      })
      .finally(() => {
        inflight = null;
      });
    await inflight;
  }

  const latest = cache?.latest ?? null;
  if (!latest) return base;
  return {
    ...base,
    latestVersion: latest.version,
    releaseUrl: latest.url,
    updateAvailable: isNewerVersion(latest.version, currentVersion),
  };
}
