import { Router, type Response, type ErrorRequestHandler } from "express";
import { createHash } from "node:crypto";
import { newBrowserBinding, setBrowserBinding, readBrowserBinding, clearBrowserBinding } from "../lib/oauthBrowser.js";
import Parser from "rss-parser";
import { requireAuth, verifyToken, type AuthRequest } from "../lib/auth.js";
import { connectionStmts } from "../lib/db.js";
import { httpClient, cloudHttpClient, normalizeBaseUrl, normalizeHttpError, describeHttpError } from "../lib/http.js";
import { validateServiceBaseUrl, isServiceBaseUrlConnection, InvalidServiceBaseUrlError } from "../lib/serviceUrl.js";
import { runAsOutboundUser } from "../lib/outboundPolicy.js";
import { normalizeFeedUrl } from "../lib/feedUrl.js";
import { fetchPiholeData } from "../lib/pihole.js";
import { subsonicAuthParams, subsonicGet, subsonicMediaQuery, type SubsonicSong } from "../lib/subsonic.js";
import { logger } from "../lib/logger.js";
import { cachedFetch } from "../lib/fetchCache.js";
import {
  getSpotifyConnection,
  getValidAccessToken,
  getProfile,
  getPlayback,
  getQueue,
  sendCommand,
  type SpotifyTrackObject,
  type SpotifyPlayback,
  type SpotifyCommand,
} from "../lib/spotify.js";
import {
  isGoogleConfigured,
  isGoogleLinked,
  listGoogleAccounts,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  createGooglePendingAuth,
  consumeGooglePendingAuth,
  consumeGoogleAuthIntent,
  getGoogleAccessToken,
  CALLBACK_PATH as GMAIL_CALLBACK_PATH,
} from "../lib/google.js";
import { listImapAccounts, listCalDavAccounts } from "../lib/mailAccounts.js";
import {
  fetchGmailMessages,
  fetchImapMessages,
  fetchGmailMessageBody,
  fetchImapMessageBody,
  archiveGmailMessage,
  archiveImapMessage,
  markGmailMessageRead,
  markImapMessageRead,
  demoEmailMessages,
  type EmailMessage,
} from "../lib/email.js";
import {
  fetchGoogleCalendarEvents,
  fetchCalDavEvents,
  demoCalendarEvents,
  type CalendarEvent,
} from "../lib/calendar.js";
import { guessGameType, queryGamePlayersDetailed, type PlayerCount } from "../lib/gameQuery.js";
import { getAiAccount, listAiAccounts } from "../lib/aiAccounts.js";
import {
  aiChat,
  aiChatStream,
  aiListModels,
  resolveModel,
  type ChatMessage,
} from "../lib/aiProviders.js";

const router = Router();

// Saved connection details, normalized for widget consumption.
interface SavedConnection {
  url?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  token?: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Read a service's saved connection from the DB. Returns an empty object when
// the service has no row or no values stored. The `extra` column holds a JSON
// blob that may carry a Plex token.
function getSavedConnection(userId: number, service: string): SavedConnection {
  const row = connectionStmts.findByService.get(userId, service);
  if (!row) return {};

  let token: string | undefined;
  if (row.extra) {
    try {
      const extraToken = (JSON.parse(row.extra) as { token?: unknown }).token;
      token = typeof extraToken === "string" ? extraToken.trim() || undefined : undefined;
    } catch {
      token = undefined;
    }
  }

  return {
    url: row.url ? (isServiceBaseUrlConnection(service)
      ? validateServiceBaseUrl(row.url)
      : trimSlash(row.url.trim()) || undefined) : undefined,
    apiKey: row.api_key?.trim() || undefined,
    username: row.username?.trim() || undefined,
    password: row.password ?? undefined,
    token: token?.trim() || undefined,
  };
}

// A saved connection is atomic: once a row contains any meaningful setting,
// callers must use only that row (even if incomplete) rather than borrowing
// missing fields from the process-wide legacy configuration.
function hasSavedConnection(saved: SavedConnection): boolean {
  return Boolean(
    saved.url ||
    saved.apiKey ||
    saved.username ||
    (saved.password != null && saved.password.length > 0) ||
    saved.token,
  );
}

function savedOrEnvironmentConnection(
  userId: number,
  service: string,
  environment: SavedConnection,
): SavedConnection {
  const saved = getSavedConnection(userId, service);
  if (hasSavedConnection(saved)) return saved;
  return {
    ...environment,
    url: environment.url && isServiceBaseUrlConnection(service)
      ? validateServiceBaseUrl(environment.url)
      : environment.url,
  };
}

function resolveMediaServerConnection(
  userId: number,
  server: "plex" | "jellyfin",
): { baseUrl?: string; apiKey?: string } {
  const saved = getSavedConnection(userId, server);
  if (hasSavedConnection(saved)) {
    return {
      baseUrl: saved.url,
      apiKey: server === "plex" ? saved.token || saved.apiKey : saved.apiKey,
    };
  }

  const envType = process.env["MEDIA_SERVER_TYPE"] || "jellyfin";
  if (envType !== server) return {};
  return {
    baseUrl: process.env["MEDIA_SERVER_URL"]
      ? validateServiceBaseUrl(process.env["MEDIA_SERVER_URL"]!)
      : undefined,
    apiKey: process.env["MEDIA_SERVER_API_KEY"],
  };
}

function credentialFingerprint(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

// Build an app.plex.tv deep link for a single item so clicking its cover opens
// it directly in Plex. Needs the server's machineIdentifier (from the Plex
// MediaContainer root) and the item's ratingKey. Returns null when either is
// missing so callers can omit the link gracefully.
function plexDeepLink(machineId: string | undefined, ratingKey: string | undefined): string | null {
  if (!machineId || ratingKey == null) return null;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${key}`;
}

// A placeholder machineIdentifier used to build deep links for the built-in
// sample/demo media items (shown when no Plex server is configured). These links
// open app.plex.tv so users can verify the poster/title click-through works
// before connecting a real server; they won't resolve to a real library item.
const SAMPLE_PLEX_MACHINE_ID = "demo";

// Pull a Plex machineIdentifier out of a single response body. Plex normally
// honors `Accept: application/json` and returns { MediaContainer: { ... } }, but
// some setups (reverse proxies, older PMS) ignore the header and return XML as a
// string. Handle both: read the JSON field when present, else regex it out of
// the raw XML. Returns undefined when the field can't be found.
function extractPlexMachineId(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const id = (data as { MediaContainer?: { machineIdentifier?: string } })
      .MediaContainer?.machineIdentifier;
    if (id) return id;
  }
  if (typeof data === "string") {
    const m = data.match(/machineIdentifier="([^"]+)"/);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

// Resolve the Plex server's machineIdentifier needed for app.plex.tv deep links.
// The library-list endpoints (/library/recentlyAdded, /library/onDeck) omit it
// from their MediaContainer root, so source it here. Tries /identity first, then
// falls back to the server root MediaContainer (`/`), which also carries the
// field — this covers servers where /identity is blocked, returns an unexpected
// shape, or omits the identifier. Logs a warning when every endpoint fails so
// the cause is visible. Returns undefined on total failure so callers fall back
// to url:null and the tile still renders (additive — must never cause a 502).
async function fetchPlexMachineId(
  baseUrl: string,
  apiKey: string,
): Promise<string | undefined> {
  const paths = ["/identity", "/"];
  let lastReason: unknown;
  for (const path of paths) {
    try {
      const r = await httpClient.get(`${baseUrl}${path}`, {
        headers: { "X-Plex-Token": apiKey, Accept: "application/json" },
      });
      const id = extractPlexMachineId(r.data);
      if (id) return id;
      lastReason = `no machineIdentifier in ${path} response (status ${r.status})`;
    } catch (err) {
      lastReason = normalizeHttpError(err);
    }
  }
  logger.warn(
    { reason: lastReason },
    "Plex machineIdentifier resolution failed — deep links will be absent",
  );
  return undefined;
}

// Build a deep link that opens a Jellyfin library item directly in the Jellyfin
// web app. Needs the server's web base URL, its ServerId (from /System/Info) and
// the item id. Returns null when either id piece is missing so callers can omit
// the link gracefully.
function jellyfinDeepLink(
  baseUrl: string,
  serverId: string | undefined,
  itemId: string | undefined,
): string | null {
  if (!serverId || itemId == null) return null;
  return `${baseUrl}/web/index.html#!/details?id=${encodeURIComponent(itemId)}&serverId=${encodeURIComponent(serverId)}`;
}

// Resolve the Jellyfin server's Id from its System/Info endpoint. The /Items
// list response doesn't carry the ServerId needed for web deep links, so source
// it here in parallel. Returns undefined on any failure so callers fall back to
// url:null and the tile still renders (additive — must never cause a 502).
async function fetchJellyfinServerId(
  baseUrl: string,
  apiKey: string,
): Promise<string | undefined> {
  try {
    const r = await httpClient.get(`${baseUrl}/System/Info`, {
      params: { api_key: apiKey },
    });
    return r.data?.Id ?? undefined;
  } catch {
    return undefined;
  }
}

// ────────────────────────────────────────────────
// TrueNAS SCALE Widget
// ────────────────────────────────────────────────
// Build a legend→latest-value map for a single reporting graph. TrueNAS returns
// each graph as { legend: string[], data: number[][], aggregations? }. The real
// response includes "time" as the FIRST legend entry, and each data row is
// aligned to that full legend (the unix timestamp sits in the "time" column).
// `aggregations.mean` holds one value per legend column EXCLUDING "time", and on
// SCALE 25.10 it is an OBJECT keyed by legend name ({ cpu: 2.7, cpu0: 3.5, … } or
// { available: 8.8e9 }); older versions used a positional ARRAY. The three
// sources are therefore zipped differently. Prefer the aggregated mean when
// present, otherwise fall back to the latest data row.
function latestByLegend(graph: unknown): Record<string, number> {
  const g = graph as
    | {
        legend?: string[];
        data?: number[][];
        aggregations?: { mean?: number[] | Record<string, number> | null };
      }
    | undefined;
  const legend = g?.legend ?? [];

  const map: Record<string, number> = {};
  const mean = g?.aggregations?.mean;
  if (Array.isArray(mean)) {
    // mean excludes the "time" column → zip against the legend with "time" gone.
    const valueLegend = legend.filter((name) => name !== "time");
    const values = mean.map((n) => Number(n) || 0);
    valueLegend.forEach((name, i) => {
      map[name] = values[i] ?? 0;
    });
  } else if (mean && typeof mean === "object") {
    // SCALE 25.10 object form: already keyed by legend name (excl. "time").
    for (const [name, v] of Object.entries(mean)) {
      map[name] = Number(v) || 0;
    }
  } else {
    // Data rows are aligned to the FULL legend (timestamp in the "time" column),
    // so zip the row directly against the legend without dropping a column.
    const rows = g?.data ?? [];
    const last = rows[rows.length - 1] ?? [];
    const values = last.map((n) => Number(n) || 0);
    legend.forEach((name, i) => {
      map[name] = values[i] ?? 0;
    });
  }
  return map;
}

// Shape of a single pool row from `GET /api/v2.0/pool`, narrowed to the vdev
// stats we sum for capacity.
interface TruenasPool {
  name: string;
  status: string;
  topology?: { data?: Array<{ stats?: { allocated?: number; alloc?: number; size?: number; space?: number } }> };
}

// Reduce a TrueNAS reporting response (array of graphs) into CPU% and memory
// bytes. Kept separate so the route can call it only when the reporting request
// actually succeeded.
function parseTruenasReporting(
  reportData: unknown,
  totalMemBytes?: number,
): {
  cpuPercent: number;
  memUsedGb: number;
  memTotalGb: number;
} {
  const graphs = (reportData ?? []) as Array<{ name?: string }>;
  const cpuGraph = graphs.find((g) => g.name === "cpu") ?? graphs[0];
  const memGraph = graphs.find((g) => g.name === "memory") ?? graphs[1];

  // CPU: SCALE 25.10's "cpu" graph reports an aggregate usage % in a "cpu"
  // column (plus per-core cpu0…cpuN), so usage is that value directly. Older
  // versions instead report per-state percentages where usage = 100 - idle.
  const cpu = latestByLegend(cpuGraph);
  const cpuPercent =
    "cpu" in cpu ? (cpu["cpu"] ?? 0) : 100 - (cpu["idle"] ?? 0);

  // Memory legend values are in bytes. SCALE 25.10's "memory" graph reports a
  // single "available" column (free + reclaimable), so used = total - available
  // with the total taken from system/info (physmem). Older versions expose
  // explicit used/free/cached/buffers buckets, which we still honour.
  const mem = latestByLegend(memGraph);
  let memUsedBytes = 0;
  let memTotalBytes = 0;
  if ("used" in mem) {
    memUsedBytes = mem["used"] ?? 0;
    memTotalBytes =
      (mem["used"] ?? 0) +
      (mem["free"] ?? 0) +
      (mem["cached"] ?? 0) +
      (mem["buffers"] ?? 0);
  } else if ("available" in mem && totalMemBytes) {
    memTotalBytes = totalMemBytes;
    memUsedBytes = Math.max(0, totalMemBytes - (mem["available"] ?? 0));
  } else {
    memTotalBytes = totalMemBytes ?? 0;
  }

  return {
    cpuPercent: Number(Math.min(100, Math.max(0, cpuPercent)).toFixed(1)),
    memUsedGb: memUsedBytes / 1e9,
    memTotalGb: memTotalBytes / 1e9,
  };
}

// Total physical memory in bytes from `GET /api/v2.0/system/info`. SCALE's
// "memory" reporting graph only yields available bytes, so the total used to
// derive usage must come from here. Returns undefined when absent/unusable.
function readTotalMemBytes(sysInfo: unknown): number | undefined {
  const s = sysInfo as { physmem?: number; physical_memory?: number } | undefined;
  const v = s?.physmem ?? s?.physical_memory;
  return typeof v === "number" && v > 0 ? v : undefined;
}

// Resolve the primary PHYSICAL network interface identifier from a
// `GET /api/v2.0/reporting/graphs` response. The "interface" reporting graph
// requires an identifier — without one it returns an empty data set — and we
// want the real NIC, not docker/bridge/virtual adapters. Returns null when no
// physical interface can be identified (network is then simply omitted).
function resolvePhysicalInterface(graphsData: unknown): string | null {
  const graphs = (graphsData ?? []) as Array<{ name?: string; identifiers?: string[] | null }>;
  const ids = graphs.find((g) => g.name === "interface")?.identifiers ?? [];
  const VIRTUAL =
    /^(lo$|docker|veth|br-|virbr|tap|tun|cni|flannel|kube|vmbr|wg|zt|tailscale|pterodactyl|vlan|ovs|dummy|bond)/i;
  return ids.find((id) => id && !VIRTUAL.test(id)) ?? null;
}

// First matching legend key from a list of candidates, or null when none of the
// candidates are present. Lets the network/ARC parsers tolerate small legend
// naming differences across TrueNAS/Netdata versions.
function pickLegendValue(map: Record<string, number>, keys: string[]): number | null {
  for (const key of keys) {
    if (key in map) return map[key]!;
  }
  return null;
}

// Extract the chronological per-sample series for a single legend column from a
// graph's raw `data` rows (one value per time step, oldest→newest). The first
// matching candidate key wins. Returns [] when the column is absent or there are
// no rows. Unlike latestByLegend this never collapses to the aggregated mean — a
// sparkline needs the individual samples, so the extras call must request the
// window WITHOUT aggregation for these to be populated.
function seriesByLegend(graph: unknown, keys: string[]): number[] {
  const g = graph as { legend?: string[]; data?: number[][] } | undefined;
  const legend = g?.legend ?? [];
  const rows = g?.data ?? [];
  if (legend.length === 0 || rows.length === 0) return [];
  let idx = -1;
  for (const key of keys) {
    const i = legend.indexOf(key);
    if (i >= 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return [];
  const out: number[] = [];
  for (const row of rows) {
    const v = row?.[idx];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

// Build a deterministic, gently-wiggling demo series ending near `base`, clamped
// to [min, max]. Used only for the unconfigured sample payload so the sparkline
// renders something representative on Replit/dev where no NAS is reachable.
function sampleSeries(base: number, amp: number, min: number, max: number, n = 30): number[] {
  return Array.from({ length: n }, (_, i) => {
    const v = base + Math.sin(i / 2.3) * amp + Math.cos(i / 3.7) * amp * 0.4;
    return Number(Math.min(max, Math.max(min, v)).toFixed(2));
  });
}

// Reduce a long series to at most `max` evenly-spaced points (always keeping the
// first and last) so the sparkline payload stays small regardless of how many
// samples the reporting window returned.
function downsample(series: number[], max = 30): number[] {
  if (series.length <= max) return series;
  const out: number[] = [];
  const step = (series.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(series[Math.round(i * step)]!);
  }
  return out;
}

// Reduce a TrueNAS reporting response into network throughput and ZFS ARC stats.
// These graphs are best-effort extras: any that is missing yields null so the
// tile can simply omit it. Requested via a SEPARATE reporting call from CPU/RAM
// so an interface graph that needs an identifier (and may be rejected) never
// regresses the core CPU/RAM numbers.
//
// Unit assumptions (the same Netdata-based backend that serves CPU/RAM):
//  - interface throughput is in kilobits/sec → megabits/sec is value / 1000.
//  - arcsize is in bytes → gigabytes is value / 1e9 (matching the memory graph).
//  - ARC hit ratio is VERSION-DEPENDENT and the two working forms are mutually
//    exclusive across SCALE releases, so BOTH must be offered:
//      • Older boxes: get_data accepts the legacy aggregate graphs
//        (arcresult / arcrate / arcactualrate) even though /reporting/graphs does
//        NOT list them, and REJECTS the demand* percentage graphs with HTTP 422.
//      • Newer boxes (SCALE 25.x): the legacy names are GONE — get_data throws
//        HTTP 500 `KeyError: 'arcresult'` — and the real hit ratio lives in the
//        demand* percentage graphs (demanddatahitpercentage, vertical_label
//        "hit%") that /reporting/graphs advertises.
//    Because one invalid name fails the WHOLE get_data batch, each candidate must
//    be requested in its OWN call (see the route) and the first that returns data
//    wins. The hit graph either exposes a direct percentage dimension, a
//    percentage-style graph whose sole column IS the hit %, or hits/misses rates
//    we turn into a percentage.
const ARC_HIT_GRAPHS = [
  "arcresult",
  "arcrate",
  "arcactualrate",
  "demanddatahitpercentage",
  "demandmetadatahitpercentage",
];
function parseTruenasNetArc(reportData: unknown): {
  netInMbps: number | null;
  netOutMbps: number | null;
  arcHitRatio: number | null;
  arcSizeGb: number | null;
  netInSeries: number[];
  netOutSeries: number[];
  arcHitSeries: number[];
} {
  const graphs = (reportData ?? []) as Array<{ name?: string }>;
  const ifaceGraph = graphs.find((g) => g.name === "interface");
  const arcSizeGraph = graphs.find((g) => g.name === "arcsize");

  const rxKeys = ["received", "rx", "in", "incoming"];
  const txKeys = ["sent", "tx", "out", "outgoing"];

  let netInMbps: number | null = null;
  let netOutMbps: number | null = null;
  let netInSeries: number[] = [];
  let netOutSeries: number[] = [];
  if (ifaceGraph) {
    const iface = latestByLegend(ifaceGraph);
    const rxKbps = pickLegendValue(iface, rxKeys);
    const txKbps = pickLegendValue(iface, txKeys);
    if (rxKbps != null) netInMbps = Number((Math.abs(rxKbps) / 1000).toFixed(2));
    if (txKbps != null) netOutMbps = Number((Math.abs(txKbps) / 1000).toFixed(2));
    // Per-sample throughput trend (kilobits/sec → Mbps), oldest→newest.
    const toMbps = (v: number) => Number((Math.abs(v) / 1000).toFixed(2));
    netInSeries = downsample(seriesByLegend(ifaceGraph, rxKeys).map(toMbps));
    netOutSeries = downsample(seriesByLegend(ifaceGraph, txKeys).map(toMbps));
  }

  // ARC hit ratio: each candidate graph either exposes a ready-made percentage
  // dimension, or separate hit/miss rates we convert to hits/(hits+misses)*100.
  // Dimension names are install-dependent, so match tolerant candidate lists.
  // Try the candidate graphs in priority order and use the FIRST that actually
  // yields a value — a graph can be present-but-empty (e.g. arcresult returns no
  // data while arcrate does), so selecting purely by name would hide valid data.
  const clampPct = (v: number) => Number(Math.min(100, Math.max(0, v)).toFixed(1));
  const pctKeys = ["percentage", "percent", "hit%", "ratio", "hitratio", "value"];
  const hitKeys = ["hits", "hit", "cache_hits", "arc_hits", "demand_data_hits"];
  const missKeys = ["misses", "miss", "cache_misses", "arc_misses", "demand_data_misses"];
  const arcHitFrom = (graph: unknown): { ratio: number | null; series: number[] } => {
    const g = graph as { name?: string; legend?: string[] } | undefined;
    const latest = latestByLegend(graph);
    const directPct = pickLegendValue(latest, pctKeys);
    if (directPct != null) {
      return {
        ratio: clampPct(directPct),
        series: downsample(seriesByLegend(graph, pctKeys).map(clampPct)),
      };
    }
    // Percentage-style graph (e.g. SCALE 25.x `demanddatahitpercentage`, vertical
    // label "hit%") whose sole data column ISN'T a recognised pct key. The graph
    // has exactly one numeric column beside "time" and it already IS the hit %,
    // so read it directly by name rather than by legend key.
    if (/percent/i.test(g?.name ?? "")) {
      const valueKeys = (g?.legend ?? []).filter((k) => k !== "time");
      const pct = pickLegendValue(latest, valueKeys);
      if (pct != null) {
        return {
          ratio: clampPct(pct),
          series: downsample(seriesByLegend(graph, valueKeys).map(clampPct)),
        };
      }
    }
    // Derive a percentage from hit/miss rates (latest value and per-sample).
    let ratio: number | null = null;
    const hits = pickLegendValue(latest, hitKeys);
    const misses = pickLegendValue(latest, missKeys);
    if (hits != null && misses != null && hits + misses > 0) {
      ratio = clampPct((hits / (hits + misses)) * 100);
    }
    const hitSeries = seriesByLegend(graph, hitKeys);
    const missSeries = seriesByLegend(graph, missKeys);
    const ratioSeries: number[] = [];
    for (let i = 0; i < Math.min(hitSeries.length, missSeries.length); i++) {
      const h = hitSeries[i] ?? 0;
      const m = missSeries[i] ?? 0;
      if (h + m > 0) ratioSeries.push(clampPct((h / (h + m)) * 100));
    }
    return { ratio, series: downsample(ratioSeries) };
  };
  // A graph can be present but carry no samples; latestByLegend would then default
  // every dimension to 0, making an empty graph look like a real "0%". Only treat
  // a candidate as usable when it actually has data rows or an aggregate mean.
  const graphHasData = (graph: unknown): boolean => {
    const g = graph as { data?: unknown[]; aggregations?: { mean?: unknown } } | undefined;
    const mean = g?.aggregations?.mean;
    const meanNonEmpty = Array.isArray(mean)
      ? mean.length > 0
      : mean != null && typeof mean === "object"
        ? Object.keys(mean).length > 0
        : false;
    return (Array.isArray(g?.data) && g.data.length > 0) || meanNonEmpty;
  };
  let arcHitRatio: number | null = null;
  let arcHitSeries: number[] = [];
  for (const name of ARC_HIT_GRAPHS) {
    const graph = graphs.find((g) => g.name === name);
    if (!graph || !graphHasData(graph)) continue;
    const { ratio, series } = arcHitFrom(graph);
    if (ratio != null || series.length > 0) {
      arcHitRatio = ratio;
      arcHitSeries = series;
      break;
    }
  }

  let arcSizeGb: number | null = null;
  if (arcSizeGraph) {
    const size = latestByLegend(arcSizeGraph);
    const sizeBytes = pickLegendValue(size, ["arc_size", "size", "arcsz", "arc", "c"]);
    if (sizeBytes != null) arcSizeGb = Number((sizeBytes / 1e9).toFixed(2));
  }

  return { netInMbps, netOutMbps, arcHitRatio, arcSizeGb, netInSeries, netOutSeries, arcHitSeries };
}

// Reduce a TrueNAS `GET /api/v2.0/pool` response into per-pool used/total bytes.
function parseTruenasPools(poolData: unknown) {
  return ((poolData ?? []) as TruenasPool[]).map((p) => {
    let usedBytes = 0;
    let totalBytes = 0;
    for (const vdev of p.topology?.data ?? []) {
      const stats = vdev.stats ?? {};
      usedBytes += stats.allocated ?? stats.alloc ?? 0;
      totalBytes += stats.size ?? stats.space ?? 0;
    }
    return { name: p.name, status: p.status, usedBytes, totalBytes };
  });
}

// Coerce a single disk-temperature value into a finite °C number, or null when
// it is genuinely absent/unknown. TrueNAS SCALE versions have returned this a few
// different ways for the same endpoint, so tolerate them all:
//   • a plain number         → 34
//   • a numeric string       → "34"
//   • a nested object        → { "temperature_c": 34 } / { "temp": 34 } / …
// Anything else (null, NaN, non-numeric string, 0-less object) → null.
function coerceTempValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) && value.trim() !== "" ? n : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of ["temperature_c", "temperature", "temp_c", "temp", "celsius", "value"]) {
      if (key in obj) {
        const n = coerceTempValue(obj[key]);
        if (n != null) return n;
      }
    }
  }
  return null;
}

// Build a `name → temperature(°C)` map from a TrueNAS `POST /api/v2.0/disk/
// temperatures` response. That endpoint returns a flat object keyed by disk name
// (e.g. `{ "sda": 34, "nvme0n1": 41, "sdb": null }`); the live `GET /disk`
// inventory does NOT carry a temperature, which is why temps showed as "--".
// Best-effort: a missing/non-numeric value stays out of the map (→ unknown).
// The value coercion tolerates the numeric-string and nested-object shapes some
// SCALE versions return (see coerceTempValue), so a shape change no longer blanks
// every temperature.
function parseTruenasTemperatures(tempData: unknown): Map<string, number> {
  const byDisk = new Map<string, number>();
  if (tempData && typeof tempData === "object" && !Array.isArray(tempData)) {
    for (const [name, value] of Object.entries(tempData as Record<string, unknown>)) {
      const n = coerceTempValue(value);
      if (n != null) byDisk.set(name, n);
    }
  }
  return byDisk;
}

// Build a `name → temperature(°C)` map from a TrueNAS `disktemp` reporting graph
// (legend like `["time","sda","sdb",…]`, one column per disk in °C). This is a
// FALLBACK temperature source for boxes where the dedicated POST /disk/
// temperatures endpoint no longer returns usable values. Best-effort: absent
// graph or non-positive readings simply yield an empty map (→ unknown).
function parseTruenasDiskTempGraph(reportData: unknown): Map<string, number> {
  const byDisk = new Map<string, number>();
  const graphs = (reportData ?? []) as Array<{ name?: string }>;
  const graph = graphs.find((g) => g.name === "disktemp");
  if (!graph) return byDisk;
  const latest = latestByLegend(graph);
  for (const [key, value] of Object.entries(latest)) {
    if (key === "time") continue;
    if (Number.isFinite(value) && value > 0) byDisk.set(key, value);
  }
  return byDisk;
}

// Parse the disk device name out of a TrueNAS reporting `disktemp` identifier.
// The reporting/graphs list exposes identifiers like
// "sdk | Type: HDD | Model: ST20000NM004E-3H | Serial: ZX213D0Z" — the device
// name is the first "|"-separated token. Newer SCALE versions only return
// disktemp data when the graph is requested PER identifier (a name-only request
// yields an empty graph), and the response is keyed by these identifiers.
function diskNameFromDiskTempIdentifier(identifier: string): string {
  return identifier.split("|")[0]?.trim() || identifier.trim();
}

// The disktemp identifiers this SCALE version exposes (one per disk), read from a
// GET /reporting/graphs payload. Empty when the graph is absent or carries no
// identifiers (older versions that accept a name-only disktemp request).
function diskTempIdentifiersFrom(graphsData: unknown): string[] {
  const graphs = (graphsData ?? []) as Array<{ name?: string; identifiers?: unknown }>;
  const dt = graphs.find((g) => g.name === "disktemp");
  const ids = dt?.identifiers;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string");
}

// Build a `name → temperature(°C)` map from an IDENTIFIER-scoped `disktemp`
// reporting response — one graph entry per requested disk identifier, each with
// a single value column beside "time". The disk name comes from the echoed
// identifier. This is the reliable disk-temperature source on newer SCALE boxes
// where POST /disk/temperatures 400s and a name-only disktemp request is empty.
// Best-effort: absent/non-positive readings are skipped (→ unknown).
function parseTruenasDiskTempByIdentifier(reportData: unknown): Map<string, number> {
  const byDisk = new Map<string, number>();
  const graphs = (reportData ?? []) as Array<{ name?: string; identifier?: string }>;
  for (const graph of graphs) {
    if (graph.name !== "disktemp" || typeof graph.identifier !== "string") continue;
    const name = diskNameFromDiskTempIdentifier(graph.identifier);
    if (!name) continue;
    const latest = latestByLegend(graph);
    let temp: number | null = null;
    for (const [key, value] of Object.entries(latest)) {
      if (key === "time") continue;
      if (Number.isFinite(value) && value > 0) {
        temp = temp == null ? value : Math.max(temp, value);
      }
    }
    if (temp != null) byDisk.set(name, Number(temp.toFixed(1)));
  }
  return byDisk;
}

// Reduce a TrueNAS `cputemp` reporting graph into a current CPU temperature. The
// graph reports one column per core (legend like `["time","cpu0","cpu1",…]`) in
// °C — there is no single "package" column — so the headline value is the
// hottest core (what a temperature warning cares about) and every per-core
// reading is returned alongside it. Best-effort: a box with no temperature
// sensor yields an empty graph → null current temp and an empty core list.
function parseTruenasCpuTemp(reportData: unknown): {
  cpuTempC: number | null;
  cpuTempCoresC: number[];
} {
  const graphs = (reportData ?? []) as Array<{ name?: string }>;
  const graph = graphs.find((g) => g.name === "cputemp");
  if (!graph) return { cpuTempC: null, cpuTempCoresC: [] };
  const latest = latestByLegend(graph);
  const cores: number[] = [];
  for (const [key, value] of Object.entries(latest)) {
    if (key === "time") continue;
    // A missing sensor reads 0 (or negative); treat only positive values as real.
    if (Number.isFinite(value) && value > 0) cores.push(Number(value.toFixed(1)));
  }
  if (cores.length === 0) return { cpuTempC: null, cpuTempCoresC: [] };
  return { cpuTempC: Number(Math.max(...cores).toFixed(1)), cpuTempCoresC: cores };
}

// Merge a TrueNAS `GET /api/v2.0/disk` inventory (disk names), the live
// `POST /api/v2.0/disk/temperatures` map (name → °C) and the
// `GET /api/v2.0/smart/test/results` SMART history into a per-disk health row:
// `{ name, temperatureC, smartPassed }`. All three inputs are best-effort — any
// may be missing/empty — so each field defaults to null ("unknown") when absent.
function parseTruenasDisks(
  diskData: unknown,
  smartData: unknown,
  tempByDisk: Map<string, number> = new Map(),
) {
  // Latest SMART verdict per disk. A disk's most recent test result decides the
  // pass/fail: SUCCESS → passed, anything else with a known status → failed,
  // an unrecognized/empty status → unknown (null).
  const smartByDisk = new Map<string, boolean | null>();
  for (const entry of (smartData ?? []) as Array<{
    disk?: string;
    tests?: Array<{ status?: string }>;
  }>) {
    if (!entry.disk) continue;
    const tests = entry.tests ?? [];
    const latest = tests[tests.length - 1];
    const status = latest?.status?.toUpperCase();
    let passed: boolean | null = null;
    if (status === "SUCCESS") passed = true;
    else if (status === "FAILED" || status === "FAILURE" || status === "ERROR") passed = false;
    smartByDisk.set(entry.disk, passed);
  }

  return ((diskData ?? []) as Array<{
    name?: string;
    devname?: string;
    temperature?: number;
    temp?: number;
  }>)
    .map((d) => {
      const name = d.name ?? d.devname ?? "";
      // Prefer the live temperatures map; fall back to any temp the inventory
      // happens to carry (older versions) before giving up (null = unknown).
      const liveTemp = tempByDisk.get(name);
      const rawTemp = typeof liveTemp === "number" ? liveTemp : d.temperature ?? d.temp;
      const temperatureC = typeof rawTemp === "number" ? rawTemp : null;
      const smartPassed = smartByDisk.has(name) ? smartByDisk.get(name)! : null;
      return { name, temperatureC, smartPassed };
    })
    .filter((d) => d.name);
}

// Extract the disk device names from a `GET /api/v2.0/disk` inventory so the
// temperatures endpoint (which requires an explicit name list) can be queried.
function diskNamesFrom(diskData: unknown): string[] {
  return ((diskData ?? []) as Array<{ name?: string; devname?: string }>)
    .map((d) => d.name ?? d.devname ?? "")
    .filter((n): n is string => Boolean(n));
}

router.get("/truenas", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "truenas", {
    url: process.env["TRUENAS_URL"],
    apiKey: process.env["TRUENAS_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;

  if (!baseUrl || !apiKey) {
    // Sample data only when the service is genuinely unconfigured.
    res.json({
      cpuPercent: 12.4,
      memUsedGb: 14.2,
      memTotalGb: 64.0,
      netInMbps: 184.6,
      netOutMbps: 42.3,
      arcHitRatio: 98.7,
      arcSizeGb: 31.4,
      netInSeries: sampleSeries(184.6, 45, 90, 300),
      netOutSeries: sampleSeries(42.3, 18, 5, 200),
      arcHitSeries: sampleSeries(98.7, 1.2, 80, 100),
      cpuTempC: 47,
      cpuTempCoresC: [45, 47, 44, 46],
      pools: [
        { name: "tank", status: "ONLINE", usedBytes: 2.1e12, totalBytes: 10e12 },
        { name: "backup", status: "ONLINE", usedBytes: 500e9, totalBytes: 4e12 },
      ],
      disks: [
        { name: "sda", temperatureC: 34, smartPassed: true },
        { name: "sdb", temperatureC: 38, smartPassed: true },
        { name: "sdc", temperatureC: 52, smartPassed: false },
      ],
    });
    return;
  }

  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  // The reporting endpoint must be a POST with the query as the JSON body.
  // (Issuing a GET with a body does not reliably send the payload.) The window
  // and aggregation options go under the `query` attribute — NOT `reporting_query`.
  // A live SCALE 25.10 diagnostic confirmed the old `reporting_query` name is
  // rejected with HTTP 400 ("The following attributes are not expected:
  // reporting_query"), which is why CPU/RAM read 0 while pools still loaded.
  // The modern Netdata-based backend (SCALE 24.04+) also needs integer unix
  // `start`/`end` (seconds), not relative "now-30s" strings, and rejects a window
  // whose `end` is "now" (the most recent samples aren't collected yet) — so the
  // window must end slightly in the past. Request a short trailing window ending
  // a few seconds ago and aggregate it (working form: now-90s … now-30s).
  const nowSec = Math.floor(Date.now() / 1000);
  const reportingQuery = { start: nowSec - 90, end: nowSec - 30, aggregate: true };
  const reportingBody = {
    graphs: [{ name: "cpu" }, { name: "memory" }],
    query: reportingQuery,
  };
  // CPU + disk TEMPERATURES ride a SEPARATE reporting/get_data POST from the core
  // cpu/memory call. `cputemp` (per-core CPU temperature) and `disktemp` (per-disk
  // temperature) are both in the get_data accepted enum, but a box with no sensor
  // returns an empty graph — keeping them isolated means their absence can never
  // regress the core CPU/RAM numbers (and get_data 422s an ENTIRE batch on one
  // bad name). `disktemp` is a FALLBACK temperature source used when the dedicated
  // POST /disk/temperatures endpoint stops returning usable values on a version.
  const cpuDiskTempBody = {
    graphs: [{ name: "cputemp" }, { name: "disktemp" }],
    query: reportingQuery,
  };
  // The reporting (CPU/RAM), pool (storage), disk-health (temperature + SMART),
  // system-info (total RAM), reporting/graphs (interface identifiers) and the
  // temperature (cputemp/disktemp) calls are all independent. Settle them
  // separately so one failing source no longer blanks the whole tile — whatever
  // data is available still renders. The disk, SMART, system-info, graphs and
  // temperature calls are purely additive: they never count toward the 502
  // "unavailable" decision, which is reserved for a fully unreachable server
  // (both the reporting and pool calls failing).
  const [reportResult, poolResult, diskResult, smartResult, sysInfoResult, graphsResult, cpuDiskTempResult] =
    await Promise.allSettled([
      httpClient.post(`${baseUrl}/api/v2.0/reporting/get_data`, reportingBody, { headers }),
      httpClient.get(`${baseUrl}/api/v2.0/pool`, { headers }),
      httpClient.get(`${baseUrl}/api/v2.0/disk`, { headers }),
      httpClient.get(`${baseUrl}/api/v2.0/smart/test/results`, { headers }),
      httpClient.get(`${baseUrl}/api/v2.0/system/info`, { headers }),
      httpClient.get(`${baseUrl}/api/v2.0/reporting/graphs`, { headers }),
      httpClient.post(`${baseUrl}/api/v2.0/reporting/get_data`, cpuDiskTempBody, { headers }),
    ]);

  if (reportResult.status === "rejected" && poolResult.status === "rejected") {
    logger.error(
      {
        reporting: normalizeHttpError(reportResult.reason),
        pool: normalizeHttpError(poolResult.reason),
      },
      "TrueNAS widget error (both reporting and pool failed)",
    );
    res.status(502).json({ error: "Failed to fetch TrueNAS data" });
    return;
  }

  // Partial data is fine: fall back to empty/zero values for whichever source
  // failed, and log a one-line reason naming the failed call.
  let reporting = { cpuPercent: 0, memUsedGb: 0, memTotalGb: 0 };
  // Total RAM (for the memory "used / total") comes from system/info because the
  // SCALE 25.10 "memory" reporting graph only reports available bytes. Additive:
  // a missing total just means memory falls back to whatever the graph provides.
  const totalMemBytes =
    sysInfoResult.status === "fulfilled" ? readTotalMemBytes(sysInfoResult.value.data) : undefined;
  if (sysInfoResult.status === "rejected") {
    logger.error(
      { reason: normalizeHttpError(sysInfoResult.reason) },
      "TrueNAS widget: system/info call failed (total RAM unavailable)",
    );
  }

  if (reportResult.status === "fulfilled") {
    reporting = parseTruenasReporting(reportResult.value.data, totalMemBytes);
  } else {
    // Log the structured failure (incl. the upstream response body) so the
    // server's actual rejection reason is visible in the container logs, not
    // just a generic "Service responded with an error (422)." The exact request
    // window sent is logged too so the failure is fully reproducible.
    logger.error(
      {
        reason: normalizeHttpError(reportResult.reason),
        detail: describeHttpError(reportResult.reason),
        request: reportingBody,
      },
      "TrueNAS widget: reporting call failed (CPU/RAM unavailable)",
    );
  }

  let pools: ReturnType<typeof parseTruenasPools> = [];
  if (poolResult.status === "fulfilled") {
    pools = parseTruenasPools(poolResult.value.data);
  } else {
    logger.error(
      { reason: normalizeHttpError(poolResult.reason) },
      "TrueNAS widget: pool call failed (storage unavailable)",
    );
  }

  // Disk health (temperature + SMART) is best-effort and built from two
  // optional sources. A failure in either only drops that signal — temperatures
  // without SMART, or SMART without temperatures, still render usefully.
  const diskData = diskResult.status === "fulfilled" ? diskResult.value.data : undefined;
  const smartData = smartResult.status === "fulfilled" ? smartResult.value.data : undefined;
  if (diskResult.status === "rejected") {
    logger.error(
      { reason: normalizeHttpError(diskResult.reason) },
      "TrueNAS widget: disk call failed (temperatures unavailable)",
    );
  }
  if (smartResult.status === "rejected") {
    logger.error(
      { reason: normalizeHttpError(smartResult.reason) },
      "TrueNAS widget: SMART call failed (drive health unavailable)",
    );
  }
  // Live disk temperatures come from a SEPARATE endpoint that must be given the
  // disk names (the inventory carries none) — so it can only run once /disk has
  // resolved. Additive: a failure just leaves temperatures unknown ("--").
  let tempByDisk = new Map<string, number>();
  const diskNames = diskNamesFrom(diskData);
  if (diskNames.length > 0) {
    try {
      const tempRes = await httpClient.post(
        `${baseUrl}/api/v2.0/disk/temperatures`,
        { names: diskNames, powermode: "NEVER" },
        { headers },
      );
      // A non-object response (e.g. a bare job-id number) means this SCALE
      // version no longer returns the flat name→°C map here; log it so the shape
      // is visible, and fall back to the disktemp reporting graph below.
      if (tempRes.data && typeof tempRes.data === "object" && !Array.isArray(tempRes.data)) {
        tempByDisk = parseTruenasTemperatures(tempRes.data);
      } else {
        logger.warn(
          { received: typeof tempRes.data },
          "TrueNAS widget: disk/temperatures returned a non-map payload (falling back to disktemp graph)",
        );
      }
    } catch (err) {
      logger.error(
        { reason: normalizeHttpError(err), detail: describeHttpError(err) },
        "TrueNAS widget: disk/temperatures call failed (temperatures unavailable)",
      );
    }
  }

  // CPU temperature + a per-disk temperature FALLBACK from the isolated
  // cputemp/disktemp reporting call. Additive: a rejection or an empty sensor
  // just leaves the CPU temp null and adds no disk temps.
  let cpuTemp = { cpuTempC: null as number | null, cpuTempCoresC: [] as number[] };
  if (cpuDiskTempResult.status === "fulfilled") {
    cpuTemp = parseTruenasCpuTemp(cpuDiskTempResult.value.data);
    // Fill any disk whose live-endpoint temperature is missing from the reporting
    // graph so temps still show when POST /disk/temperatures stops working.
    const diskTempGraph = parseTruenasDiskTempGraph(cpuDiskTempResult.value.data);
    for (const [name, temp] of diskTempGraph) {
      if (!tempByDisk.has(name)) tempByDisk.set(name, temp);
    }
  } else {
    logger.error(
      {
        reason: normalizeHttpError(cpuDiskTempResult.reason),
        detail: describeHttpError(cpuDiskTempResult.reason),
        request: cpuDiskTempBody,
      },
      "TrueNAS widget: cputemp/disktemp reporting call failed (CPU/disk temperatures unavailable)",
    );
  }

  // If disk temperatures are STILL missing (the dedicated POST /disk/temperatures
  // 400s on newer SCALE — "attributes are not expected: names, powermode" — and a
  // name-only disktemp reporting request returns nothing when the graph is
  // per-identifier), fetch the disktemp graph explicitly BY identifier. The
  // identifiers come from the reporting/graphs list already fetched above, and the
  // reporting mechanism that powers cputemp works reliably here. Best-effort: a
  // rejection or empty result just leaves temperatures unknown ("--").
  const diskTempIds =
    graphsResult.status === "fulfilled" ? diskTempIdentifiersFrom(graphsResult.value.data) : [];
  const missingDiskTemps = diskNames.some((n) => !tempByDisk.has(n));
  if (diskTempIds.length > 0 && missingDiskTemps) {
    // Disk temperatures are sampled far less often than CPU temp (minutes, not
    // seconds), so the short cpu/mem window (now-90s … now-30s) frequently holds
    // ZERO disktemp samples → an empty graph → no reading. Aggregate a wider
    // window so a recent sample is always captured; the mean of a slow-moving
    // temperature over the hour is effectively the current value.
    const diskTempQuery = { start: nowSec - 3600, end: nowSec - 30, aggregate: true };
    const diskTempBody = {
      graphs: diskTempIds.map((identifier) => ({ name: "disktemp", identifier })),
      query: diskTempQuery,
    };
    try {
      const dtRes = await httpClient.post(
        `${baseUrl}/api/v2.0/reporting/get_data`,
        diskTempBody,
        { headers },
      );
      const byId = parseTruenasDiskTempByIdentifier(dtRes.data);
      for (const [name, temp] of byId) {
        if (!tempByDisk.has(name)) tempByDisk.set(name, temp);
      }
    } catch (err) {
      logger.error(
        {
          reason: normalizeHttpError(err),
          detail: describeHttpError(err),
          request: diskTempBody,
        },
        "TrueNAS widget: disktemp-by-identifier reporting call failed (disk temperatures unavailable)",
      );
    }
  }

  const disks = parseTruenasDisks(diskData, smartData, tempByDisk);

  // Network + ARC extras: additive. They ride a SEPARATE reporting call so a
  // rejection only drops these (never a 502). The "interface" graph needs a
  // physical-NIC identifier (resolved from reporting/graphs above) — without one
  // it returns no data — so it's only requested when one is found. The net/ARC
  // extras want a short *series* over time (for sparklines), so they use a longer
  // trailing window with aggregation OFF; the same "end in the past" rule applies
  // (the most recent samples aren't collected yet). The current value is the last
  // sample of the series.
  let netArc = {
    netInMbps: null as number | null,
    netOutMbps: null as number | null,
    arcHitRatio: null as number | null,
    arcSizeGb: null as number | null,
    netInSeries: [] as number[],
    netOutSeries: [] as number[],
    arcHitSeries: [] as number[],
  };
  const ifaceId = graphsResult.status === "fulfilled" ? resolvePhysicalInterface(graphsResult.value.data) : null;
  if (graphsResult.status === "rejected") {
    logger.error(
      { reason: normalizeHttpError(graphsResult.reason) },
      "TrueNAS widget: reporting/graphs call failed (interface identifier unavailable)",
    );
  }
  const extrasQuery = { start: nowSec - 1800, end: nowSec - 30, aggregate: false };
  // Core extras (interface + arcsize) ride one call; the ARC hit-ratio graphs ride
  // a SEPARATE call. get_data 422s an ENTIRE batch when any single graph name is
  // not in its accepted enum, so keeping the (guaranteed-valid) interface/arcsize
  // graphs apart from the best-effort ARC-ratio candidates means a problem with
  // the latter can never take Network throughput + ARC size down with it.
  const coreExtrasBody = {
    graphs: [
      ...(ifaceId ? [{ name: "interface", identifier: ifaceId }] : []),
      { name: "arcsize" },
    ],
    query: extrasQuery,
  };
  // Each ARC-hit candidate rides its OWN call: the accepted set differs by SCALE
  // version (legacy arc* vs demand* percentage graphs) and get_data fails the
  // ENTIRE batch on any single unknown name (HTTP 422 on older boxes, HTTP 500
  // `KeyError` on newer ones). Isolating them means the working candidate always
  // gets through regardless of which others the box rejects. The parser then picks
  // the first candidate (in ARC_HIT_GRAPHS priority order) that returned data.
  const arcHitBodies = ARC_HIT_GRAPHS.map((name) => ({
    name,
    body: { graphs: [{ name }], query: extrasQuery },
  }));
  const [coreExtras, ...arcHitResults] = await Promise.allSettled([
    httpClient.post(`${baseUrl}/api/v2.0/reporting/get_data`, coreExtrasBody, { headers }),
    ...arcHitBodies.map(({ body }) =>
      httpClient.post(`${baseUrl}/api/v2.0/reporting/get_data`, body, { headers }),
    ),
  ]);
  // Merge every successful response before parsing so a single parser pass sees
  // all graphs.
  const mergedGraphs: unknown[] = [];
  if (coreExtras.status === "fulfilled") {
    const d = coreExtras.value.data;
    if (Array.isArray(d)) mergedGraphs.push(...(d as unknown[]));
  } else {
    logger.error(
      {
        reason: normalizeHttpError(coreExtras.reason),
        detail: describeHttpError(coreExtras.reason),
        request: coreExtrasBody,
      },
      "TrueNAS widget: network/ARC-size reporting call failed (interface + arcsize unavailable)",
    );
  }
  const arcHitFailures: string[] = [];
  arcHitResults.forEach((result, i) => {
    const { name, body } = arcHitBodies[i]!;
    if (result.status === "fulfilled") {
      const d = result.value.data;
      if (Array.isArray(d)) mergedGraphs.push(...(d as unknown[]));
    } else {
      arcHitFailures.push(`${name}: ${normalizeHttpError(result.reason)}`);
      logger.debug(
        { reason: describeHttpError(result.reason), request: body },
        `TrueNAS widget: ARC hit-ratio candidate "${name}" rejected (trying others)`,
      );
    }
  });
  // Only a concern if EVERY candidate failed — otherwise a rejected legacy/demand
  // name is expected on this SCALE version and not worth alarming about.
  if (arcHitFailures.length === ARC_HIT_GRAPHS.length) {
    logger.error(
      { failures: arcHitFailures },
      "TrueNAS widget: all ARC hit-ratio candidates failed (hit ratio unavailable)",
    );
  }
  netArc = parseTruenasNetArc(mergedGraphs);

  res.json({ ...reporting, ...netArc, ...cpuTemp, pools, disks });
});

// ────────────────────────────────────────────────
// TrueNAS reporting diagnostic
// ────────────────────────────────────────────────
// The reporting/get_data endpoint has been rejected on real SCALE installs while
// pools keep loading, and every prior fix was a blind guess at the request shape
// because we never captured what the live server actually says. This route makes
// the failure observable: it runs against the user's real NAS and returns, for
// each probe, the EXACT request that was sent and the raw outcome (HTTP status +
// full response body, success or error). The API key is never echoed.
//
// It probes several known-good request forms so the user can see, in one shot,
// which one this version accepts (integer unix window vs. unit/page, window
// ending in the past vs. at "now", aggregated vs. not), plus a GET of
// reporting/graphs to reveal the exact graph names + identifier requirements
// this version exposes. Read-only and auth-gated, so it is safe to leave in.

// Cap a raw upstream payload so a large reporting/graphs list (can be 100+
// graphs) doesn't bloat the diagnostic response. Arrays are sliced; deep objects
// are passed through (reporting errors are small). The cap is generous enough to
// keep every graph name visible.
function capDiagnosticBody(body: unknown): unknown {
  if (Array.isArray(body)) {
    const max = 200;
    return body.length > max
      ? [...body.slice(0, max), `…(${body.length - max} more items omitted)`]
      : body;
  }
  return body;
}

router.get("/truenas/diagnostics", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "truenas", {
    url: process.env["TRUENAS_URL"],
    apiKey: process.env["TRUENAS_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;

  if (!baseUrl || !apiKey) {
    // No sample data here — a diagnostic on an unconfigured service is
    // meaningless. Tell the caller plainly so they configure TrueNAS first.
    res.status(409).json({
      configured: false,
      message:
        "TrueNAS is not configured. Save a TrueNAS URL and API key first, then run this diagnostic from the LAN box that can reach the NAS.",
    });
    return;
  }

  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const getDataUrl = `${baseUrl}/api/v2.0/reporting/get_data`;
  const nowSec = Math.floor(Date.now() / 1000);

  // Candidate query forms to try for the core cpu/memory call. The time window
  // and aggregation options ride the `query` attribute (this SCALE version
  // rejects the old `reporting_query` name with HTTP 400). The form the server
  // accepts (HTTP 200 with graph data) is the one the widget uses; the rest
  // surface the server's own rejection reason in their body. The probes also
  // reveal the real response shape (legend names) so the parser can be verified.
  const coreGraphs = [{ name: "cpu" }, { name: "memory" }];
  const candidates: Array<{ label: string; body: unknown }> = [
    {
      label: "cpu+memory, aggregated, unix window ending in the past (now-90s … now-30s) — the form the widget uses",
      body: { graphs: coreGraphs, query: { start: nowSec - 90, end: nowSec - 30, aggregate: true } },
    },
    {
      label: "cpu+memory, aggregated, unix window ending at now (now-90s … now)",
      body: { graphs: coreGraphs, query: { start: nowSec - 90, end: nowSec, aggregate: true } },
    },
    {
      label: "cpu+memory, unit/page form (unit=HOUR, page=1), aggregated",
      body: { graphs: coreGraphs, query: { unit: "HOUR", page: 1, aggregate: true } },
    },
    {
      label: "cpu+memory, non-aggregated series (now-1800s … now-30s)",
      body: { graphs: coreGraphs, query: { start: nowSec - 1800, end: nowSec - 30, aggregate: false } },
    },
  ];

  // Run a single POST probe, capturing the request and the raw outcome. Both the
  // success body and the error body are preserved so the server's actual reason
  // is copyable. Never includes headers (would leak the API key).
  async function probePost(label: string, body: unknown) {
    try {
      const r = await httpClient.post(getDataUrl, body, { headers });
      return {
        label,
        request: { method: "POST", url: getDataUrl, body },
        ok: true as const,
        status: r.status,
        response: capDiagnosticBody(r.data),
      };
    } catch (err) {
      return {
        label,
        request: { method: "POST", url: getDataUrl, body },
        ok: false as const,
        ...describeHttpError(err),
        body: capDiagnosticBody(describeHttpError(err).body),
      };
    }
  }

  // GET reporting/graphs reveals the exact graph names + identifier requirements
  // this version exposes — invaluable when a graph name we hard-code no longer
  // exists or now requires an identifier.
  const graphsUrl = `${baseUrl}/api/v2.0/reporting/graphs`;
  async function probeGraphsList() {
    try {
      const r = await httpClient.get(graphsUrl, { headers });
      return {
        label: "available reporting graphs (GET /reporting/graphs)",
        request: { method: "GET", url: graphsUrl },
        ok: true as const,
        status: r.status,
        response: capDiagnosticBody(r.data),
      };
    } catch (err) {
      return {
        label: "available reporting graphs (GET /reporting/graphs)",
        request: { method: "GET", url: graphsUrl },
        ok: false as const,
        ...describeHttpError(err),
        body: capDiagnosticBody(describeHttpError(err).body),
      };
    }
  }

  // Fetch the graph list first so the extras probe can request the real physical
  // NIC (the interface graph returns no data without an identifier) and confirm
  // the ARC hit % graph that replaced arcactualrate.
  const graphsProbe = await probeGraphsList();
  const ifaceId =
    graphsProbe.ok && Array.isArray(graphsProbe.response)
      ? resolvePhysicalInterface(graphsProbe.response)
      : null;
  const extrasQuery = { start: nowSec - 1800, end: nowSec - 30, aggregate: false };
  // Core extras (interface + arcsize) and the ARC hit-ratio candidates are probed
  // SEPARATELY — get_data 422s a whole batch on any one invalid graph name, so a
  // combined probe would hide the interface/arcsize legends whenever an ARC name
  // is rejected. The widget itself issues these as two calls for the same reason.
  const coreExtrasBody = {
    graphs: [
      ...(ifaceId ? [{ name: "interface", identifier: ifaceId }] : [{ name: "interface" }]),
      { name: "arcsize" },
    ],
    query: extrasQuery,
  };
  const coreExtrasLabel = `extras core (interface ${
    ifaceId ? `[${ifaceId}]` : "— no physical NIC resolved, sent without identifier"
  }, arcsize), non-aggregated series — the form the widget uses`;
  // ARC hit-ratio candidates are probed ONE PER CALL — exactly as the widget now
  // issues them — because the accepted set is version-specific (legacy arc* vs
  // demand* percentage graphs) and any single unknown name fails a whole batch
  // (422 on older boxes, 500 KeyError on newer). Per-name probes reveal precisely
  // which candidate this box accepts and the legend of the one that works.
  const arcHitProbes = ARC_HIT_GRAPHS.map((name) => ({
    label: `extras ARC hit ratio candidate "${name}", non-aggregated series — isolated call (the form the widget uses)`,
    body: { graphs: [{ name }], query: extrasQuery },
  }));
  // Temperature probe (cputemp + disktemp), aggregated short window — the form the
  // widget uses. Reveals the exact legend so the per-core CPU temp and per-disk
  // disktemp-fallback parsing can be verified (or shows an empty graph when the
  // box has no temperature sensor / needs a per-disk identifier).
  const cpuDiskTempBody = {
    graphs: [{ name: "cputemp" }, { name: "disktemp" }],
    query: { start: nowSec - 90, end: nowSec - 30, aggregate: true },
  };
  const cpuDiskTempLabel =
    "temperatures (cputemp + disktemp), aggregated window in the past — the form the widget uses";

  // Disk-health probes. The TrueNAS tile's per-disk temperature + SMART grid is
  // built from three calls; probe each so a "--" (unknown) cell is explainable:
  //   • GET /disk            → disk inventory (names; note it carries NO temperature)
  //   • POST /disk/temperatures → live name→°C map (the real temperature source)
  //   • GET /smart/test/results → SMART test history (empty when no tests have run)
  async function probeGetUrl(label: string, url: string) {
    try {
      const r = await httpClient.get(url, { headers });
      return {
        label,
        request: { method: "GET", url },
        ok: true as const,
        status: r.status,
        response: capDiagnosticBody(r.data),
      };
    } catch (err) {
      return {
        label,
        request: { method: "GET", url },
        ok: false as const,
        ...describeHttpError(err),
        body: capDiagnosticBody(describeHttpError(err).body),
      };
    }
  }
  async function probePostUrl(label: string, url: string, body: unknown) {
    try {
      const r = await httpClient.post(url, body, { headers });
      return {
        label,
        request: { method: "POST", url, body },
        ok: true as const,
        status: r.status,
        response: capDiagnosticBody(r.data),
      };
    } catch (err) {
      return {
        label,
        request: { method: "POST", url, body },
        ok: false as const,
        ...describeHttpError(err),
        body: capDiagnosticBody(describeHttpError(err).body),
      };
    }
  }
  const diskUrl = `${baseUrl}/api/v2.0/disk`;
  const tempUrl = `${baseUrl}/api/v2.0/disk/temperatures`;
  const smartUrl = `${baseUrl}/api/v2.0/smart/test/results`;
  // The inventory must run first so the temperatures probe can send real names.
  const diskProbe = await probeGetUrl("disk inventory (GET /disk)", diskUrl);
  const probedDiskNames = diskProbe.ok ? diskNamesFrom(diskProbe.response).slice(0, 50) : [];
  const tempLabel = `disk temperatures (POST /disk/temperatures) for ${
    probedDiskNames.length
  } disk(s)${probedDiskNames.length ? "" : " — none resolved from inventory"}`;
  const tempProbe = await probePostUrl(tempLabel, tempUrl, {
    names: probedDiskNames,
    powermode: "NEVER",
  });

  // disktemp BY identifier — the disk-temperature source on newer SCALE boxes
  // where POST /disk/temperatures 400s and a name-only disktemp graph is empty.
  // Uses a WIDE aggregated window (disk temps sample slowly) so the response shows
  // the real per-identifier legend + values the fallback parser relies on.
  const diskTempIdentifiers = diskTempIdentifiersFrom(graphsProbe.response).slice(0, 50);
  const diskTempByIdLabel = `disktemp BY identifier for ${diskTempIdentifiers.length} disk(s), aggregated wide window (now-3600s … now-30s) — the fallback the widget uses${
    diskTempIdentifiers.length ? "" : " — no disktemp identifiers advertised"
  }`;
  const diskTempByIdBody = {
    graphs: diskTempIdentifiers.map((identifier) => ({ name: "disktemp", identifier })),
    query: { start: nowSec - 3600, end: nowSec - 30, aggregate: true },
  };

  const probes = await Promise.all([
    Promise.resolve(graphsProbe),
    ...candidates.map((c) => probePost(c.label, c.body)),
    probePost(coreExtrasLabel, coreExtrasBody),
    ...arcHitProbes.map((p) => probePost(p.label, p.body)),
    probePost(cpuDiskTempLabel, cpuDiskTempBody),
    Promise.resolve(diskProbe),
    Promise.resolve(tempProbe),
    ...(diskTempIdentifiers.length ? [probePost(diskTempByIdLabel, diskTempByIdBody)] : []),
    probeGetUrl("disk SMART test results (GET /smart/test/results)", smartUrl),
  ]);

  res.json({ configured: true, baseUrl, serverTimeUnixSec: nowSec, probes });
});

// ────────────────────────────────────────────────
// Media Server Widget (Plex or Jellyfin)
// ────────────────────────────────────────────────
router.get("/media", requireAuth, async (req: AuthRequest, res) => {
  // Which media server backs this tile. "jellyfin" reads the saved Jellyfin
  // connection; anything else (the default) reads the saved Plex connection.
  const server = req.query["server"] === "jellyfin" ? "jellyfin" : "plex";

  const serverType = server;
  const { baseUrl, apiKey } = resolveMediaServerConnection(req.user!.userId, server);

  if (!baseUrl || !apiKey) {
    // Sample items carry a demo deep link so the poster/title click-through can
    // be tested before a real Plex server is connected.
    res.json([
      { id: "1", title: "The Last of Us", type: "show", year: 2023, thumb: null, addedAt: new Date().toISOString(), url: plexDeepLink(SAMPLE_PLEX_MACHINE_ID, "1") },
      { id: "2", title: "Oppenheimer", type: "movie", year: 2023, thumb: null, addedAt: new Date().toISOString(), url: plexDeepLink(SAMPLE_PLEX_MACHINE_ID, "2") },
      { id: "3", title: "Severance", type: "show", year: 2022, thumb: null, addedAt: new Date().toISOString(), url: plexDeepLink(SAMPLE_PLEX_MACHINE_ID, "3") },
    ]);
    return;
  }

  try {
    if (serverType === "jellyfin") {
      // The /Items list omits the ServerId needed for web deep links, so resolve
      // it from /System/Info in parallel. fetchJellyfinServerId swallows its own
      // errors → if it can't be resolved, deep links fall back to null but the
      // tile still renders (additive — never a 502 from the server-id call).
      const [r, serverId] = await Promise.all([
        httpClient.get(`${baseUrl}/Items`, {
          params: {
            SortBy: "DateCreated",
            SortOrder: "Descending",
            IncludeItemTypes: "Movie,Episode,Series",
            Limit: 6,
            Recursive: true,
            Fields: "PrimaryImageAspectRatio,DateCreated",
            ImageTypeLimit: 1,
            EnableImageTypes: "Primary,Thumb",
            api_key: apiKey,
          },
        }),
        fetchJellyfinServerId(baseUrl, apiKey),
      ]);
      const items = (r.data?.Items ?? []).map((item: { Id: string; Name: string; Type: string; ProductionYear?: number; ImageTags?: { Primary?: string }; DateCreated?: string; SeriesName?: string; ParentIndexNumber?: number; IndexNumber?: number }) => {
        const type = item.Type.toLowerCase();
        // Jellyfin episodes carry the show name in SeriesName; build an SxxEyy
        // season label when the numbers are available.
        const seriesName = type === "episode" ? item.SeriesName ?? null : null;
        const seasonLabel =
          type === "episode" && item.ParentIndexNumber != null && item.IndexNumber != null
            ? `S${item.ParentIndexNumber}E${item.IndexNumber}`
            : null;
        return {
          id: item.Id,
          title: item.Name,
          type,
          year: item.ProductionYear ?? null,
          thumb: item.ImageTags?.Primary
            ? `${baseUrl}/Items/${item.Id}/Images/Primary?api_key=${apiKey}&maxHeight=200`
            : null,
          addedAt: item.DateCreated ?? null,
          seriesName,
          seasonLabel,
          url: jellyfinDeepLink(baseUrl, serverId, item.Id),
        };
      });
      res.json(items);
    } else {
      // Plex — recently added items. The token rides as the X-Plex-Token header
      // and is also appended to thumbnail URLs so the browser can load them.
      // The server's machineIdentifier (needed for app.plex.tv deep links) is
      // NOT included on the recentlyAdded container, so fetch it from /identity
      // in parallel. fetchPlexMachineId swallows its own errors → if it can't be
      // resolved, deep links fall back to null but the tile still renders.
      const [r, machineId] = await Promise.all([
        httpClient.get(`${baseUrl}/library/recentlyAdded`, {
          headers: { "X-Plex-Token": apiKey, Accept: "application/json" },
        }),
        fetchPlexMachineId(baseUrl, apiKey),
      ]);
      const items = (r.data?.MediaContainer?.Metadata ?? []).slice(0, 6).map(
        (item: {
          ratingKey: string;
          title: string;
          type: string;
          year?: number;
          thumb?: string;
          addedAt?: number;
          parentTitle?: string;
          grandparentTitle?: string;
          index?: number;
        }) => {
          // Plex "recently added" returns seasons for TV (type "season", with the
          // show name in parentTitle and a "Season N" title) or episodes (show
          // name in grandparentTitle). Surface the show name + a season label so
          // the tile shows e.g. "Severance · Season 2" instead of just "Season 1".
          let seriesName: string | null = null;
          let seasonLabel: string | null = null;
          if (item.type === "season") {
            seriesName = item.parentTitle ?? null;
            seasonLabel = item.title ?? null;
          } else if (item.type === "episode") {
            seriesName = item.grandparentTitle ?? null;
            seasonLabel = item.parentTitle ?? null;
          }
          return {
            id: String(item.ratingKey),
            title: item.title,
            type: item.type,
            year: item.year ?? null,
            thumb: item.thumb ? `${baseUrl}${item.thumb}?X-Plex-Token=${apiKey}` : null,
            addedAt: item.addedAt ? new Date(item.addedAt * 1000).toISOString() : null,
            seriesName,
            seasonLabel,
            url: plexDeepLink(machineId, item.ratingKey),
          };
        },
      );
      res.json(items);
    }
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Media widget error");
    res.status(502).json({ error: "Failed to fetch media data" });
  }
});

// ────────────────────────────────────────────────
// Continue Watching Widget (Plex On Deck)
// ────────────────────────────────────────────────
router.get("/media/continue", requireAuth, async (req: AuthRequest, res) => {
  // Which media server backs this tile. "jellyfin" reads the saved Jellyfin
  // connection (Resume items); anything else (the default) reads the saved Plex
  // connection (On Deck).
  const server = req.query["server"] === "jellyfin" ? "jellyfin" : "plex";

  const serverType = server;
  const { baseUrl, apiKey } = resolveMediaServerConnection(req.user!.userId, server);

  // Unconfigured → return built-in sample data so the tile has something to
  // show, consistent with the /media convention.
  if (!baseUrl || !apiKey) {
    // Sample items carry a demo deep link so the poster/title click-through can
    // be tested before a real media server is connected.
    res.json([
      { id: "1", title: "Chapter 7", type: "episode", seriesName: "Severance", thumb: null, progress: 42, url: plexDeepLink(SAMPLE_PLEX_MACHINE_ID, "1") },
      { id: "2", title: "Dune: Part Two", type: "movie", seriesName: null, thumb: null, progress: 18, url: plexDeepLink(SAMPLE_PLEX_MACHINE_ID, "2") },
    ]);
    return;
  }

  // Jellyfin: the resume fetch has its OWN try/catch so a resume failure is
  // additive — it degrades to an empty list (200) rather than a 502, per the
  // tile contract (Continue Watching is a supplementary section that must never
  // take the tile down). The Plex On Deck path below keeps its 502-on-failure
  // behavior unchanged.
  if (serverType === "jellyfin") {
    try {
      // Jellyfin exposes resume/in-progress items via /Items/Resume. The list
      // omits the ServerId needed for web deep links, so resolve it from
      // /System/Info in parallel. fetchJellyfinServerId swallows its own errors
      // → deep links fall back to null but the tile still renders (additive —
      // never a 502 from the server-id call alone).
      const [r, serverId] = await Promise.all([
        httpClient.get(`${baseUrl}/Items/Resume`, {
          params: {
            IncludeItemTypes: "Movie,Episode",
            Limit: 12,
            Recursive: true,
            Fields: "PrimaryImageAspectRatio",
            ImageTypeLimit: 1,
            EnableImageTypes: "Primary,Thumb",
            api_key: apiKey,
          },
        }),
        fetchJellyfinServerId(baseUrl, apiKey),
      ]);
      const items = (r.data?.Items ?? []).map(
        (item: {
          Id: string;
          Name: string;
          Type: string;
          SeriesName?: string;
          ImageTags?: { Primary?: string };
          SeriesId?: string;
          SeriesPrimaryImageTag?: string;
          UserData?: { PlaybackPositionTicks?: number };
          RunTimeTicks?: number;
        }) => {
          const type = item.Type.toLowerCase();
          // Episodes carry the show name in SeriesName. Progress is the played
          // fraction (PlaybackPositionTicks / RunTimeTicks), as a 0–100 percent.
          const seriesName = type === "episode" ? item.SeriesName ?? null : null;
          const positionTicks = item.UserData?.PlaybackPositionTicks;
          const progress =
            positionTicks != null && item.RunTimeTicks
              ? Math.round((positionTicks / item.RunTimeTicks) * 100)
              : null;
          // Prefer the item's own primary image; for episodes fall back to the
          // series poster when the episode has no still of its own.
          let thumb: string | null = null;
          if (item.ImageTags?.Primary) {
            thumb = `${baseUrl}/Items/${item.Id}/Images/Primary?api_key=${apiKey}&maxHeight=200`;
          } else if (item.SeriesId && item.SeriesPrimaryImageTag) {
            thumb = `${baseUrl}/Items/${item.SeriesId}/Images/Primary?api_key=${apiKey}&maxHeight=200`;
          }
          return {
            id: item.Id,
            title: item.Name,
            type,
            seriesName,
            thumb,
            progress,
            url: jellyfinDeepLink(baseUrl, serverId, item.Id),
          };
        },
      );
      res.json(items);
    } catch (err) {
      // Additive: a Jellyfin resume failure never 502s — the tile keeps its
      // other sections (e.g. Recently Added) and just shows no resume items.
      logger.error({ reason: normalizeHttpError(err) }, "Jellyfin continue watching widget error");
      res.json([]);
    }
    return;
  }

  try {
    // The onDeck container omits the server's machineIdentifier, so resolve it
    // from /identity in parallel to build app.plex.tv deep links. The identity
    // fetch swallows its own errors → deep links fall back to null on failure
    // while the tile still renders (never a 502 from the identity call alone).
    const [r, machineId] = await Promise.all([
      httpClient.get(`${baseUrl}/library/onDeck`, {
        headers: { "X-Plex-Token": apiKey, Accept: "application/json" },
      }),
      fetchPlexMachineId(baseUrl, apiKey),
    ]);
    const items = (r.data?.MediaContainer?.Metadata ?? []).map(
      (item: {
        ratingKey: string;
        title: string;
        type: string;
        thumb?: string;
        grandparentThumb?: string;
        grandparentTitle?: string;
        viewOffset?: number;
        duration?: number;
      }) => {
        // Episodes carry the show name in grandparentTitle. Progress is the
        // played fraction (viewOffset / duration), as a 0–100 percentage.
        const seriesName = item.type === "episode" ? item.grandparentTitle ?? null : null;
        const progress =
          item.viewOffset != null && item.duration
            ? Math.round((item.viewOffset / item.duration) * 100)
            : null;
        const thumbPath = item.thumb || item.grandparentThumb;
        return {
          id: String(item.ratingKey),
          title: item.title,
          type: item.type ?? null,
          seriesName,
          thumb: thumbPath ? `${baseUrl}${thumbPath}?X-Plex-Token=${apiKey}` : null,
          progress,
          url: plexDeepLink(machineId, item.ratingKey),
        };
      },
    );
    res.json(items);
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Continue watching widget error");
    res.status(502).json({ error: "Failed to fetch continue watching data" });
  }
});

// ────────────────────────────────────────────────
// Audio Player Widget
// ────────────────────────────────────────────────
// Backs the Audio Player tile. The shared client-side playback engine streams
// the returned tracks; this endpoint only resolves the source's now-playing
// track and a browser-playable queue. "source" selects the backing service —
// only "plex" exists today; it is the seam Spotify/Jellyfin/Navidrome plug into.

// A single Plex track row (from /status/sessions or a library listing) mapped to
// the AudioTrack shape. `live` carries Player.state + viewOffset for the active
// session's now-playing track; library/queue entries pass live:false so state
// and progressMs stay null (they are not a live session).
interface PlexTrackRow {
  ratingKey?: string | number;
  parentRatingKey?: string | number;
  grandparentRatingKey?: string | number;
  title?: string;
  grandparentTitle?: string;
  parentTitle?: string;
  thumb?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  duration?: number;
  viewOffset?: number;
  userRating?: number;
  Player?: { state?: string };
  Media?: { Part?: { key?: string }[] }[];
}

// Plex has no boolean "favorite" for tracks — it exposes a 0–10 `userRating`
// (the old thumbs-up mapped to 10). We treat a high rating as "liked" so the
// heart toggle round-trips with the rating we write when a user likes a track.
const PLEX_LIKE_THRESHOLD = 8;
function plexLiked(userRating: number | undefined): boolean | null {
  return typeof userRating === "number" ? userRating >= PLEX_LIKE_THRESHOLD : null;
}

function mapPlexTrack(
  item: PlexTrackRow,
  baseUrl: string,
  token: string,
  live: boolean,
) {
  const thumbPath = item.thumb || item.parentThumb || item.grandparentThumb;
  const partKey = item.Media?.[0]?.Part?.[0]?.key;
  return {
    id: String(item.ratingKey ?? ""),
    title: item.title ?? "Unknown track",
    artist: item.grandparentTitle ?? null,
    album: item.parentTitle ?? null,
    artistId: item.grandparentRatingKey != null ? String(item.grandparentRatingKey) : null,
    albumId: item.parentRatingKey != null ? String(item.parentRatingKey) : null,
    artwork: thumbPath ? `${baseUrl}${thumbPath}?X-Plex-Token=${token}` : null,
    durationMs: typeof item.duration === "number" ? item.duration : null,
    progressMs: live && typeof item.viewOffset === "number" ? item.viewOffset : null,
    state: live ? item.Player?.state ?? null : null,
    streamUrl: partKey ? `${baseUrl}${partKey}?X-Plex-Token=${token}` : null,
    liked: plexLiked(item.userRating),
  };
}

// A single Jellyfin audio item as returned by /Items, /Sessions
// (NowPlayingItem), or an album's children. Only the fields the Audio Player
// tile needs are modeled.
interface JellyfinAudioItem {
  Id?: string;
  Name?: string;
  Type?: string;
  Artists?: string[];
  ArtistItems?: Array<{ Id?: string; Name?: string }>;
  AlbumArtist?: string;
  Album?: string;
  AlbumId?: string;
  RunTimeTicks?: number;
  ImageTags?: { Primary?: string };
  AlbumPrimaryImageTag?: string;
  UserData?: { IsFavorite?: boolean };
}

// Map a Jellyfin audio item to the shared AudioTrack shape. Jellyfin reports
// durations/offsets in "ticks" (100-nanosecond units → 10,000 ticks per ms).
// `live` carries the active session's PlayState (position + paused) when this is
// the now-playing track; pass null for plain queue/recent entries. streamUrl
// uses the .mp3 transcode endpoint so the browser's <audio> element can play it
// directly regardless of the source file's codec (e.g. FLAC).
const JELLYFIN_TICKS_PER_MS = 10_000;
function mapJellyfinTrack(
  item: JellyfinAudioItem,
  baseUrl: string,
  apiKey: string,
  live: { positionTicks?: number; isPaused?: boolean } | null,
) {
  const id = String(item.Id ?? "");
  const artist =
    (item.Artists ?? []).filter(Boolean).join(", ") || item.AlbumArtist || null;
  // Prefer the track's own primary image; fall back to the album's artwork.
  let artwork: string | null = null;
  if (item.ImageTags?.Primary) {
    artwork = `${baseUrl}/Items/${id}/Images/Primary?api_key=${apiKey}&maxHeight=200`;
  } else if (item.AlbumId && item.AlbumPrimaryImageTag) {
    artwork = `${baseUrl}/Items/${item.AlbumId}/Images/Primary?api_key=${apiKey}&maxHeight=200`;
  }
  return {
    id,
    title: item.Name ?? "Unknown track",
    artist,
    album: item.Album ?? null,
    artistId: item.ArtistItems?.[0]?.Id ?? null,
    albumId: item.AlbumId ?? null,
    artwork,
    durationMs:
      typeof item.RunTimeTicks === "number"
        ? Math.round(item.RunTimeTicks / JELLYFIN_TICKS_PER_MS)
        : null,
    progressMs:
      live && typeof live.positionTicks === "number"
        ? Math.round(live.positionTicks / JELLYFIN_TICKS_PER_MS)
        : null,
    state: live ? (live.isPaused ? "paused" : "playing") : null,
    streamUrl: id
      ? `${baseUrl}/Audio/${id}/stream.mp3?api_key=${apiKey}&audioCodec=mp3`
      : null,
    liked:
      typeof item.UserData?.IsFavorite === "boolean" ? item.UserData.IsFavorite : null,
  };
}

// Resolve a Jellyfin user id for favorite reads/writes. The favorite endpoints
// are user-scoped (/Users/{userId}/FavoriteItems/...) and UserData.IsFavorite
// only populates when a userId accompanies item requests. The API key acts on
// behalf of the server, so pick the first user from /Users. Cached briefly per
// base URL to avoid an extra round-trip on every poll. Returns undefined on any
// failure so callers degrade to unknown liked state (never a 502 on read).
const jellyfinUserIdCache = new Map<string, { id: string; at: number }>();
const JELLYFIN_USER_TTL_MS = 5 * 60_000;
async function fetchJellyfinUserId(baseUrl: string, apiKey: string): Promise<string | undefined> {
  const cached = jellyfinUserIdCache.get(baseUrl);
  if (cached && Date.now() - cached.at < JELLYFIN_USER_TTL_MS) return cached.id;
  try {
    const r = await httpClient.get(`${baseUrl}/Users`, { params: { api_key: apiKey } });
    const users = (r.data ?? []) as Array<{ Id?: string }>;
    const id = users[0]?.Id;
    if (id) {
      jellyfinUserIdCache.set(baseUrl, { id, at: Date.now() });
      return id;
    }
  } catch {
    // Ignore — caller falls back to unknown liked state; favoriting will 502.
  }
  return undefined;
}

// Resolve the saved Jellyfin connection (base URL + API key), falling back to a
// Jellyfin-typed env media server when none is saved — mirrors the /media route.
function resolveJellyfinAudioConnection(userId: number): {
  baseUrl: string | undefined;
  apiKey: string | undefined;
} {
  const { baseUrl, apiKey } = resolveMediaServerConnection(userId, "jellyfin");
  return { baseUrl, apiKey };
}

// Audio Player — Jellyfin source. Reads the saved Jellyfin connection, returns
// the current music session (with progress) when one is playing, otherwise the
// most recently added music tracks. Each real track carries an authenticated,
// browser-playable .mp3 stream URL so the shared <audio> engine can play it.
async function handleJellyfinAudio(userId: number, res: import("express").Response): Promise<void> {
  const { baseUrl, apiKey } = resolveJellyfinAudioConnection(userId);

  // Unconfigured → built-in demo content (sample:true). streamUrl stays null so
  // the tile labels it not-live and disables in-browser streaming.
  if (!baseUrl || !apiKey) {
    // Demo tracks carry artistId/albumId that match the demo browse catalog
    // (d-artist-1 / d-album-1), so the clickable artist/album deep links can be
    // exercised (and e2e-tested) without a live Jellyfin server.
    const demo = [
      { id: "1", title: "Dreams", artist: "Fleetwood Mac", artistId: "d-artist-1", album: "Rumours", albumId: "d-album-1", artwork: null, durationMs: 257_000, progressMs: 72_000, state: "playing", streamUrl: null },
      { id: "2", title: "The Chain", artist: "Fleetwood Mac", artistId: "d-artist-1", album: "Rumours", albumId: "d-album-1", artwork: null, durationMs: 271_000, progressMs: null, state: null, streamUrl: null },
      { id: "3", title: "Go Your Own Way", artist: "Fleetwood Mac", artistId: "d-artist-1", album: "Rumours", albumId: "d-album-1", artwork: null, durationMs: 218_000, progressMs: null, state: null, streamUrl: null },
    ];
    res.json({ source: "jellyfin", sample: true, nowPlaying: demo[0], queue: demo });
    return;
  }

  try {
    // Resolve the Jellyfin user so item requests carry UserData.IsFavorite (the
    // like state). Best-effort — undefined just leaves liked unknown/null.
    const jfUserId = await fetchJellyfinUserId(baseUrl, apiKey);

    // Prefer the active music session: /Sessions lists everything playing now;
    // pick the first whose NowPlayingItem is an Audio track. Its album becomes
    // the queue so skip next/previous works.
    const sessions = await httpClient.get(`${baseUrl}/Sessions`, {
      params: { api_key: apiKey },
    });
    const session = (sessions.data ?? []).find(
      (s: { NowPlayingItem?: { Type?: string } }) =>
        s?.NowPlayingItem?.Type === "Audio",
    ) as
      | {
          NowPlayingItem?: JellyfinAudioItem;
          PlayState?: { PositionTicks?: number; IsPaused?: boolean };
        }
      | undefined;

    if (session?.NowPlayingItem) {
      const npItem = session.NowPlayingItem;
      const playState = session.PlayState ?? {};
      const nowPlaying = mapJellyfinTrack(npItem, baseUrl, apiKey, {
        positionTicks: playState.PositionTicks,
        isPaused: playState.IsPaused,
      });
      // Best-effort: fetch the album's tracks for skip next/previous. A failure
      // here is additive — the queue degrades to just the now-playing track.
      let queue = [nowPlaying];
      if (npItem.AlbumId) {
        try {
          const album = await httpClient.get(`${baseUrl}/Items`, {
            params: {
              ParentId: npItem.AlbumId,
              IncludeItemTypes: "Audio",
              Recursive: true,
              SortBy: "ParentIndexNumber,IndexNumber,SortName",
              api_key: apiKey,
              ...(jfUserId ? { userId: jfUserId } : {}),
            },
          });
          const tracks = (album.data?.Items ?? []) as JellyfinAudioItem[];
          if (tracks.length > 0) {
            queue = tracks.map((t) => mapJellyfinTrack(t, baseUrl, apiKey, null));
          }
        } catch (err) {
          logger.warn({ reason: normalizeHttpError(err) }, "Jellyfin album queue fetch failed — using now-playing only");
        }
      }
      // The session's NowPlayingItem rarely carries UserData, so backfill the
      // now-playing like state from the (userId-scoped) album queue entry.
      if (nowPlaying.liked == null) {
        const match = queue.find((t) => t.id === nowPlaying.id);
        if (match) nowPlaying.liked = match.liked;
      }
      res.json({ source: "jellyfin", sample: false, nowPlaying, queue });
      return;
    }

    // No active session → fall back to the most recently added music tracks.
    const recent = await httpClient.get(`${baseUrl}/Items`, {
      params: {
        IncludeItemTypes: "Audio",
        SortBy: "DateCreated",
        SortOrder: "Descending",
        Recursive: true,
        Limit: 25,
        api_key: apiKey,
        ...(jfUserId ? { userId: jfUserId } : {}),
      },
    });
    const tracks = (recent.data?.Items ?? []) as JellyfinAudioItem[];
    const queue = tracks.map((t) => mapJellyfinTrack(t, baseUrl, apiKey, null));
    res.json({ source: "jellyfin", sample: false, nowPlaying: queue[0] ?? null, queue });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Jellyfin audio player widget error");
    res.status(502).json({ error: "Failed to fetch audio player data" });
  }
}

// Map a Spotify track object to the shared AudioTrack shape. Spotify never gives
// a direct stream URL (playback is remote or via the Web Playback SDK), so
// streamUrl is always null — the tile drives it through command endpoints / SDK
// instead of the shared <audio> engine.
function mapSpotifyTrack(item: SpotifyTrackObject, playback: SpotifyPlayback | null): {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  artwork: string | null;
  durationMs: number | null;
  progressMs: number | null;
  state: string | null;
  streamUrl: null;
} {
  const artist = (item.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") || null;
  const artwork = item.album?.images?.[0]?.url ?? null;
  return {
    id: item.id ?? "",
    title: item.name ?? "Unknown track",
    artist,
    album: item.album?.name ?? null,
    artwork,
    durationMs: typeof item.duration_ms === "number" ? item.duration_ms : null,
    progressMs: playback && typeof playback.progress_ms === "number" ? playback.progress_ms : null,
    state: playback ? (playback.is_playing ? "playing" : "paused") : null,
    streamUrl: null,
  };
}

async function handleSpotifyAudio(userId: number, res: import("express").Response): Promise<void> {
  const conn = getSpotifyConnection(userId);
  const linked = Boolean(conn.clientId && conn.clientSecret && conn.tokens.refreshToken);

  // Not linked → an actionable "connect" state rather than demo content, so the
  // tile prompts the user to link their account in Settings.
  if (!linked) {
    res.json({
      source: "spotify",
      sample: false,
      auth: "needed",
      premium: null,
      canControl: false,
      device: null,
      nowPlaying: null,
      queue: [],
    });
    return;
  }

  try {
    const token = await getValidAccessToken(userId);
    // Premium gates in-browser playback; failure here shouldn't break the tile.
    let premium: boolean | null = null;
    try {
      premium = (await getProfile(token)).premium;
    } catch {
      premium = null;
    }

    const playback = await getPlayback(token);
    if (!playback || !playback.item) {
      res.json({
        source: "spotify",
        sample: false,
        auth: "connected",
        premium,
        canControl: false,
        device: null,
        nowPlaying: null,
        queue: [],
      });
      return;
    }

    const nowPlaying = mapSpotifyTrack(playback.item, playback);
    const device = playback.device
      ? {
          id: playback.device.id ?? null,
          name: playback.device.name ?? "Unknown device",
          isActive: Boolean(playback.device.is_active),
          volumePercent:
            typeof playback.device.volume_percent === "number"
              ? playback.device.volume_percent
              : null,
        }
      : null;

    // The upcoming queue is additive — degrade to just now-playing on failure.
    let queue = [nowPlaying];
    try {
      const upcoming = await getQueue(token);
      queue = [nowPlaying, ...upcoming.map((t) => mapSpotifyTrack(t, null))];
    } catch (err) {
      logger.warn({ reason: normalizeHttpError(err) }, "Spotify queue fetch failed — using now-playing only");
    }

    res.json({
      source: "spotify",
      sample: false,
      auth: "connected",
      premium,
      canControl: Boolean(device),
      device,
      nowPlaying,
      queue,
    });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Spotify audio player widget error");
    res.status(502).json({ error: "Failed to fetch Spotify playback" });
  }
}

// Map a Subsonic song to the shared AudioTrack shape. Subsonic reports
// durations in whole seconds (→ ms). It exposes no real playback cursor; the
// caller may pass an estimated `progressMs` derived from a now-playing entry's
// `minutesAgo` (see estimateSubsonicProgressMs), otherwise it stays null.
// Artwork and stream URLs embed the request's salted-token auth so the browser
// can load them directly; the stream uses `format=mp3` so the shared <audio>
// engine plays any source codec (FLAC etc.). `live` marks the now-playing entry
// so its state reads as "playing".
function mapSubsonicTrack(
  song: SubsonicSong,
  baseUrl: string,
  mediaQuery: string,
  live: boolean,
  progressMs: number | null = null,
) {
  const id = String(song.id ?? "");
  const coverArt = song.coverArt ?? song.albumId;
  return {
    id,
    title: song.title ?? "Unknown track",
    artist: song.artist ?? null,
    album: song.album ?? null,
    artistId: song.artistId ?? null,
    albumId: song.albumId ?? null,
    artwork: coverArt
      ? `${baseUrl}/rest/getCoverArt.view?id=${encodeURIComponent(coverArt)}&size=300&${mediaQuery}`
      : null,
    durationMs: typeof song.duration === "number" ? song.duration * 1000 : null,
    progressMs,
    state: live ? "playing" : null,
    streamUrl: id
      ? `${baseUrl}/rest/stream.view?id=${encodeURIComponent(id)}&format=mp3&${mediaQuery}`
      : null,
    // `starred` is an ISO date present only when the track is a favorite; treat
    // any non-empty value as liked. Never absent-but-typed, so default to false.
    liked: Boolean(song.starred),
  };
}

// Estimate a live playback offset for a now-playing entry. Subsonic exposes no
// real playback cursor — only `minutesAgo`, how long ago the server last
// registered the track as playing (whole minutes). We treat that as the elapsed
// time since the track started and clamp it to the track length so a stale entry
// never overruns the progress bar. Absent/invalid → null, so the tile falls back
// to its previous behaviour (no progress) gracefully.
function estimateSubsonicProgressMs(song: SubsonicSong): number | null {
  if (typeof song.minutesAgo !== "number" || !Number.isFinite(song.minutesAgo)) {
    return null;
  }
  const elapsedMs = Math.max(0, song.minutesAgo) * 60_000;
  const durationMs = typeof song.duration === "number" ? song.duration * 1000 : null;
  return durationMs != null ? Math.min(elapsedMs, durationMs) : elapsedMs;
}

// Audio Player — Navidrome / Subsonic source. Reuses the saved `subsonic`
// connection (base URL + username/password, salted-token auth). Returns the
// most recent now-playing entry when one exists, otherwise the newest album's
// tracks. Each real track carries an authenticated, browser-playable .mp3 stream
// URL so the shared <audio> engine can play it.
async function handleSubsonicAudio(userId: number, res: import("express").Response): Promise<void> {
  const saved = getSavedConnection(userId, "subsonic");
  const baseUrl = saved.url;
  const username = saved.username;
  const password = saved.password;

  // Unconfigured → built-in demo content (sample:true). streamUrl stays null so
  // the tile labels it not-live and disables in-browser streaming.
  if (!baseUrl || !username || !password) {
    const demo = [
      { id: "1", title: "Dreams", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 257_000, progressMs: 72_000, state: "playing", streamUrl: null },
      { id: "2", title: "The Chain", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 271_000, progressMs: null, state: null, streamUrl: null },
      { id: "3", title: "Go Your Own Way", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 218_000, progressMs: null, state: null, streamUrl: null },
    ];
    res.json({ source: "subsonic", sample: true, nowPlaying: demo[0], queue: demo });
    return;
  }

  try {
    const auth = subsonicAuthParams(username, password);
    const mediaQuery = subsonicMediaQuery(auth);

    // Prefer the most recent now-playing entry. getNowPlaying returns
    // nowPlaying.entry as an array (or a single object on some servers).
    const np = await subsonicGet(baseUrl, "getNowPlaying.view", auth);
    const rawEntries = (np["nowPlaying"] as { entry?: unknown } | undefined)?.entry;
    const entries = (
      Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : []
    ) as SubsonicSong[];

    if (entries.length > 0) {
      const current = entries[0]!;
      const progressMs = estimateSubsonicProgressMs(current);
      const nowPlaying = mapSubsonicTrack(current, baseUrl, mediaQuery, true, progressMs);
      // Best-effort: the now-playing track's album becomes the queue so skip
      // next/previous works. A failure here is additive — the queue degrades to
      // just the now-playing track.
      let queue = [nowPlaying];
      if (current.albumId) {
        try {
          const albumBody = await subsonicGet(baseUrl, "getAlbum.view", auth, {
            id: current.albumId,
          });
          const songs = ((albumBody["album"] as { song?: SubsonicSong[] } | undefined)?.song ??
            []) as SubsonicSong[];
          if (songs.length > 0) {
            queue = songs.map((s) => mapSubsonicTrack(s, baseUrl, mediaQuery, false));
          }
        } catch (err) {
          logger.warn(
            { reason: normalizeHttpError(err) },
            "Subsonic album queue fetch failed — using now-playing only",
          );
        }
      }
      res.json({ source: "subsonic", sample: false, nowPlaying, queue });
      return;
    }

    // Nothing playing → fall back to the newest album's tracks.
    const listBody = await subsonicGet(baseUrl, "getAlbumList2.view", auth, {
      type: "newest",
      size: 1,
    });
    const albums = ((listBody["albumList2"] as { album?: Array<{ id?: string }> } | undefined)
      ?.album ?? []) as Array<{ id?: string }>;
    const newestId = albums[0]?.id;
    if (!newestId) {
      // Configured but no albums — honest empty state, not demo content.
      res.json({ source: "subsonic", sample: false, nowPlaying: null, queue: [] });
      return;
    }
    const albumBody = await subsonicGet(baseUrl, "getAlbum.view", auth, { id: newestId });
    const songs = ((albumBody["album"] as { song?: SubsonicSong[] } | undefined)?.song ??
      []) as SubsonicSong[];
    const queue = songs.map((s) => mapSubsonicTrack(s, baseUrl, mediaQuery, false));
    res.json({ source: "subsonic", sample: false, nowPlaying: queue[0] ?? null, queue });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Subsonic audio player widget error");
    res.status(502).json({ error: "Failed to fetch audio player data" });
  }
}

// POST /widgets/subsonic/scrobble — report a play back to Navidrome / Subsonic.
// While the dashboard's own <audio> engine streams a Subsonic track, the
// frontend pings this with submission=false ("now playing") and, on completion,
// submission=true (a real scrobble). That makes the dashboard show up as a live
// session and feeds play counts for other Subsonic clients — closing the loop
// with the read-only progress the tile already surfaces. Reuses the saved
// `subsonic` connection + salted-token auth. Failures are surfaced as errors but
// the caller treats them as non-fatal so playback never breaks.
router.post("/subsonic/scrobble", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { id?: unknown; submission?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    res.status(400).json({ error: "A track id is required" });
    return;
  }
  const submission = body.submission === true;

  const saved = getSavedConnection(req.user!.userId, "subsonic");
  const baseUrl = saved.url;
  const username = saved.username;
  const password = saved.password;
  if (!baseUrl || !username || !password) {
    res.status(404).json({ error: "No Subsonic / Navidrome connection is configured" });
    return;
  }

  try {
    const auth = subsonicAuthParams(username, password);
    // scrobble.view returns an empty ok envelope; subsonicGet throws on a failed
    // status, so a thrown error here means the server rejected the scrobble.
    await subsonicGet(baseUrl, "scrobble.view", auth, {
      id,
      submission: submission ? "true" : "false",
    });
    res.json({ ok: true });
  } catch (err) {
    logger.warn(
      { reason: normalizeHttpError(err), submission },
      "Subsonic scrobble failed",
    );
    res.status(502).json({ error: "Failed to report play to Subsonic" });
  }
});

// ────────────────────────────────────────────────
// Audio Player — favorite / like toggling
// ────────────────────────────────────────────────
// Backs the heart button on the Audio Player tile. Each per-source setter writes
// the track's favorite state on the linked server and returns "ok" on success or
// "unconfigured" when that source has no saved connection (→ 404). Real API
// failures throw so the route answers 502 and the button can surface an error.
// Spotify is intentionally omitted: liking a track needs the user-library-modify
// OAuth scope, which the app doesn't currently request, so it would force every
// linked user to re-authorize — tracked as a fast-follow.
type FavoriteOutcome = "ok" | "unconfigured";

async function setPlexFavorite(userId: number, id: string, liked: boolean): Promise<FavoriteOutcome> {
  const conn = resolvePlexAudioConnection(userId);
  if (!conn) return "unconfigured";
  // Plex has no boolean favorite for tracks — write a user rating instead. 10 =
  // liked; 0 unlikes. Plex Media Server validates `rating` to the 0–10 range and
  // rejects the negative "clear" sentinel (-1) with HTTP 400, so unlike must send
  // 0. Reads map a rating >= PLEX_LIKE_THRESHOLD (8) back to liked (see
  // plexLiked); 0 falls under that threshold, so the toggle still round-trips.
  await httpClient.put(`${conn.baseUrl}/:/rate`, null, {
    headers: { "X-Plex-Token": conn.token, Accept: "application/json" },
    params: {
      key: id,
      identifier: "com.plexapp.plugins.library",
      rating: liked ? 10 : 0,
    },
  });
  return "ok";
}

async function setSubsonicFavorite(userId: number, id: string, liked: boolean): Promise<FavoriteOutcome> {
  const saved = getSavedConnection(userId, "subsonic");
  if (!saved.url || !saved.username || !saved.password) return "unconfigured";
  const auth = subsonicAuthParams(saved.username, saved.password);
  // star.view / unstar.view toggle the track's starred state. subsonicGet throws
  // on a failed envelope, so any rejection surfaces as a 502 to the caller.
  await subsonicGet(saved.url, liked ? "star.view" : "unstar.view", auth, { id });
  return "ok";
}

async function setJellyfinFavorite(userId: number, id: string, liked: boolean): Promise<FavoriteOutcome> {
  const { baseUrl, apiKey } = resolveJellyfinAudioConnection(userId);
  if (!baseUrl || !apiKey) return "unconfigured";
  const jfUserId = await fetchJellyfinUserId(baseUrl, apiKey);
  if (!jfUserId) throw new Error("Could not resolve a Jellyfin user for favoriting");
  const url = `${baseUrl}/Users/${jfUserId}/FavoriteItems/${encodeURIComponent(id)}`;
  if (liked) {
    await httpClient.post(url, null, { params: { api_key: apiKey } });
  } else {
    await httpClient.delete(url, { params: { api_key: apiKey } });
  }
  return "ok";
}

// POST /widgets/audioplayer/favorite — mark the currently playing track as a
// favorite (liked=true) or remove it (liked=false) on the connected source.
// Dispatches by `source`, mirroring the now-playing route. Returns the new liked
// state so the tile can settle its optimistic UI to the confirmed value.
router.post("/audioplayer/favorite", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { source?: unknown; id?: unknown; liked?: unknown };
  const source = typeof body.source === "string" ? body.source : "plex";
  const id = typeof body.id === "string" ? body.id : "";
  const liked = body.liked === true;
  if (!id) {
    res.status(400).json({ error: "A track id is required" });
    return;
  }

  const userId = req.user!.userId;
  try {
    let outcome: FavoriteOutcome;
    if (source === "subsonic") {
      outcome = await setSubsonicFavorite(userId, id, liked);
    } else if (source === "jellyfin") {
      outcome = await setJellyfinFavorite(userId, id, liked);
    } else if (source === "plex") {
      outcome = await setPlexFavorite(userId, id, liked);
    } else {
      res.status(400).json({ error: `Favoriting is not supported for source "${source}"` });
      return;
    }
    if (outcome === "unconfigured") {
      res.status(404).json({ error: `No ${source} connection is configured` });
      return;
    }
    res.json({ liked });
  } catch (err) {
    // Surface the REAL upstream reason (status + response body), not a flat
    // generic message — Plex and Navidrome fail for different reasons and future
    // failures must be diagnosable. describeHttpError keeps the status/body that
    // normalizeHttpError discards; Subsonic throws a plain Error whose message is
    // the server's own `error.message`, so that comes through the message field.
    const detail = describeHttpError(err);
    logger.error({ reason: detail, source }, "Audio favorite toggle failed");
    const bodyText =
      typeof detail.body === "string"
        ? detail.body
        : detail.body != null
          ? JSON.stringify(detail.body)
          : "";
    const statusPart = detail.status ? `HTTP ${detail.status}` : detail.message;
    const reason = bodyText ? `${statusPart}: ${bodyText.slice(0, 300)}` : statusPart;
    res.status(502).json({
      error: `Failed to update the favorite on the music source (${reason})`,
    });
  }
});

// ── Video Player widget ──────────────────────────────────────────────────────
// Lists video libraries and direct-play playlists from a connected Plex or
// Jellyfin server. Follows the widget-data convention: sample:true with empty
// data when the server is not connected, 502 when a configured server fails.

router.get("/videoplayer/libraries", requireAuth, async (req: AuthRequest, res) => {
  const server = String(req.query["server"] ?? "");
  if (server !== "plex" && server !== "jellyfin") {
    res.status(400).json({ error: "server must be plex or jellyfin" });
    return;
  }
  const userId = req.user!.userId;
  if (server === "plex") {
    const conn = resolvePlexAudioConnection(userId);
    if (!conn) {
      res.json({ sample: true, libraries: [] });
      return;
    }
    try {
      const r = await httpClient.get(`${conn.baseUrl}/library/sections`, {
        headers: { "X-Plex-Token": conn.token, Accept: "application/json" },
      });
      const dirs = (r.data?.MediaContainer?.Directory ?? []) as Array<{
        key?: string | number;
        title?: string;
        type?: string;
      }>;
      const libraries = dirs
        .filter((d) => d.type === "movie" || d.type === "show")
        .map((d) => ({
          id: String(d.key ?? ""),
          title: d.title ?? "Untitled library",
          kind: d.type === "movie" ? "movies" : "shows",
        }));
      res.json({ sample: false, libraries });
    } catch (err) {
      logger.error({ reason: describeHttpError(err) }, "Plex video libraries error");
      res.status(502).json({ error: "Failed to load video libraries from Plex" });
    }
    return;
  }
  // Jellyfin
  const { baseUrl, apiKey } = resolveJellyfinAudioConnection(userId);
  if (!baseUrl || !apiKey) {
    res.json({ sample: true, libraries: [] });
    return;
  }
  try {
    const r = await httpClient.get(`${baseUrl}/Library/MediaFolders`, {
      params: { api_key: apiKey },
    });
    const items = (r.data?.Items ?? []) as Array<{
      Id?: string;
      Name?: string;
      CollectionType?: string;
    }>;
    const videoKinds = new Set(["movies", "tvshows", "homevideos", "musicvideos"]);
    const libraries = items
      .filter((i) => videoKinds.has(String(i.CollectionType ?? "")))
      .map((i) => ({
        id: String(i.Id ?? ""),
        title: i.Name ?? "Untitled library",
        kind: i.CollectionType === "movies" ? "movies" : i.CollectionType === "tvshows" ? "shows" : (i.CollectionType ?? null),
      }));
    res.json({ sample: false, libraries });
  } catch (err) {
    logger.error({ reason: describeHttpError(err) }, "Jellyfin video libraries error");
    res.status(502).json({ error: "Failed to load video libraries from Jellyfin" });
  }
});

// Cap playlists so a huge library doesn't produce megabyte responses.
const VIDEO_PLAYLIST_LIMIT = 200;

// Audio codecs browsers can decode natively in a <video> element. Anything
// else (ac3, eac3, dts, truehd, pcm variants…) direct-plays as silent video,
// so those items are routed through Plex's universal transcode instead.
const BROWSER_SAFE_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

interface PlexVideoMedia {
  audioCodec?: string;
  Part?: Array<{ key?: string }>;
}

// Build the playable stream URL for a Plex item. Compatible audio keeps the
// existing direct part URL (no transcoding). Unsupported audio gets a Plex
// universal-transcode HLS playlist that direct-streams the video track and
// transcodes only audio to AAC. Unknown codecs stay on direct play — never
// transcode speculatively.
export function plexVideoStreamUrl(
  baseUrl: string,
  token: string,
  ratingKey: string,
  media: PlexVideoMedia | undefined,
): string | null {
  const partKey = media?.Part?.[0]?.key;
  if (!partKey) return null;
  const codec = media?.audioCodec?.toLowerCase();
  if (!codec || BROWSER_SAFE_AUDIO_CODECS.has(codec)) {
    return `${baseUrl}${partKey}?X-Plex-Token=${token}`;
  }
  const params = new URLSearchParams({
    path: `/library/metadata/${ratingKey}`,
    mediaIndex: "0",
    partIndex: "0",
    protocol: "hls",
    fastSeek: "1",
    directPlay: "0",
    directStream: "1",
    audioCodec: "aac",
    // The transcoder requires a client identity; a stable per-item session id
    // lets Plex reuse/clean up the transcode session across reloads.
    session: `tachboard-video-${ratingKey}`,
    "X-Plex-Client-Identifier": "tachboard-videoplayer",
    "X-Plex-Product": "Tachboard",
    // Without a platform the transcoder has no client profile to decide
    // what the player can handle and the HLS session can refuse to start
    // (or direct-stream audio the browser can't decode). "Chrome" selects
    // Plex's standard web profile: H.264 video + AAC audio.
    "X-Plex-Platform": "Chrome",
    "X-Plex-Device-Name": "Tachboard",
    "X-Plex-Token": token,
  });
  return `${baseUrl}/video/:/transcode/universal/start.m3u8?${params.toString()}`;
}

// GET /widgets/videoplayer/browse — gradual drill-down for the Video Player
// tile's browser: shows in a TV library → a show's seasons → a season's
// playable episodes. `show_episodes` flattens a whole show into an ordered
// episode queue (Plex allLeaves; Jellyfin recursive episode query). Movie
// libraries keep using the flat /videoplayer playlist endpoint, so no
// artificial empty levels exist here. Supports Plex and Jellyfin.
const VIDEO_BROWSE_KINDS = [
  "shows",
  "movies",
  "seasons",
  "episodes",
  "show_episodes",
  "recently_added",
  "continue_watching",
];
// Server-level home categories — Plex-only (backed by /library/recentlyAdded
// and /library/onDeck); Jellyfin equivalents are future work.
const VIDEO_BROWSE_PLEX_ONLY_KINDS = ["recently_added", "continue_watching"];
const VIDEO_BROWSE_KINDS_NEEDING_ID = ["seasons", "episodes", "show_episodes"];
const VIDEO_BROWSE_KINDS_NEEDING_LIBRARY = ["shows", "movies"];

router.get("/videoplayer/browse", requireAuth, async (req: AuthRequest, res) => {
  const server = String(req.query["server"] ?? "");
  if (server !== "plex" && server !== "jellyfin") {
    res.status(400).json({ error: "server must be plex or jellyfin" });
    return;
  }
  const kind = String(req.query["kind"] ?? "");
  const libraryId = String(req.query["libraryId"] ?? "").trim();
  const id = String(req.query["id"] ?? "").trim();
  if (!VIDEO_BROWSE_KINDS.includes(kind)) {
    res.status(400).json({ error: "Unknown browse kind" });
    return;
  }
  if (VIDEO_BROWSE_KINDS_NEEDING_LIBRARY.includes(kind) && !libraryId) {
    res.status(400).json({ error: `kind=${kind} requires a libraryId` });
    return;
  }
  if (VIDEO_BROWSE_KINDS_NEEDING_ID.includes(kind) && !id) {
    res.status(400).json({ error: `kind=${kind} requires an id` });
    return;
  }
  if (VIDEO_BROWSE_PLEX_ONLY_KINDS.includes(kind) && server !== "plex") {
    res.status(400).json({ error: `kind=${kind} is only supported for Plex` });
    return;
  }
  // Zero-based index of the first item to return: each response is one page of
  // at most VIDEO_PLAYLIST_LIMIT items; nextOffset tells the client where the
  // following page starts (null when the listing is complete).
  const rawOffset = Number(req.query["offset"] ?? 0);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  if (server === "jellyfin") {
    // Jellyfin drill-down via the Items API. Containers (Series/Season) come
    // back as VideoContainer rows; episodes are mapped to direct-play videos
    // exactly like the flat /videoplayer playlist route.
    const { baseUrl, apiKey } = resolveJellyfinAudioConnection(req.user!.userId);
    if (!baseUrl || !apiKey) {
      res.json({ sample: true, containers: [], videos: [] });
      return;
    }
    // Primary poster the browser can load directly, mirroring how the tile
    // streams straight from Jellyfin. Only items with a Primary image tag get
    // a URL so missing art falls back to the glyph.
    const thumbUrl = (item: { Id?: string; ImageTags?: Record<string, string> }): string | null =>
      item.Id && item.ImageTags?.["Primary"]
        ? `${baseUrl}/Items/${encodeURIComponent(String(item.Id))}/Images/Primary?api_key=${apiKey}`
        : null;
    try {
      const params: Record<string, string> = {
        api_key: apiKey,
        Limit: String(VIDEO_PLAYLIST_LIMIT),
        StartIndex: String(offset),
      };
      if (kind === "shows") {
        params["ParentId"] = libraryId;
        params["Recursive"] = "true";
        params["IncludeItemTypes"] = "Series";
        params["Fields"] = "RecursiveItemCount,ProductionYear";
        params["SortBy"] = "SortName";
      } else if (kind === "movies") {
        // A movie library's playable items, with posters for the grid view.
        params["ParentId"] = libraryId;
        params["Recursive"] = "true";
        params["IncludeItemTypes"] = "Movie,Video,MusicVideo";
        params["Fields"] = "RunTimeTicks";
        params["SortBy"] = "SortName";
      } else if (kind === "seasons") {
        params["ParentId"] = id;
        params["IncludeItemTypes"] = "Season";
        params["Fields"] = "RecursiveItemCount";
      } else if (kind === "episodes") {
        params["ParentId"] = id;
        params["IncludeItemTypes"] = "Episode";
        params["Fields"] = "RunTimeTicks";
      } else {
        // show_episodes: every episode of a show, in season/episode order.
        params["ParentId"] = id;
        params["Recursive"] = "true";
        params["IncludeItemTypes"] = "Episode";
        params["Fields"] = "RunTimeTicks";
        params["SortBy"] = "ParentIndexNumber,IndexNumber,SortName";
      }
      const r = await httpClient.get(`${baseUrl}/Items`, { params });
      // Jellyfin reports the level's full size; page forward until exhausted.
      const totalRecords = r.data?.TotalRecordCount;
      const total = typeof totalRecords === "number" ? totalRecords : null;
      const rawCount = (r.data?.Items ?? []).length as number;
      const nextOffset =
        total != null
          ? offset + rawCount < total
            ? offset + rawCount
            : null
          : rawCount >= VIDEO_PLAYLIST_LIMIT
            ? offset + rawCount
            : null;
      const items = (r.data?.Items ?? []) as Array<{
        Id?: string;
        Name?: string;
        Type?: string;
        ProductionYear?: number;
        RecursiveItemCount?: number;
        ChildCount?: number;
        IndexNumber?: number;
        RunTimeTicks?: number;
        ImageTags?: Record<string, string>;
      }>;
      if (kind === "movies") {
        const videos = items
          .filter((i) => i.Id)
          .map((i) => ({
            id: String(i.Id),
            title: i.Name ?? "Untitled",
            streamUrl: `${baseUrl}/Videos/${encodeURIComponent(String(i.Id))}/stream?static=true&api_key=${apiKey}`,
            durationMs:
              typeof i.RunTimeTicks === "number" ? Math.round(i.RunTimeTicks / 10000) : null,
            thumb: thumbUrl(i),
          }));
        res.json({ sample: false, videos, nextOffset, total });
        return;
      }
      if (kind === "shows" || kind === "seasons") {
        const containers = items
          .filter((i) => i.Id)
          .map((i) => {
            const count = i.RecursiveItemCount ?? i.ChildCount;
            const parts = [
              kind === "shows" && i.ProductionYear ? String(i.ProductionYear) : null,
              typeof count === "number"
                ? `${count} episode${count === 1 ? "" : "s"}`
                : null,
            ].filter(Boolean);
            return {
              id: String(i.Id),
              kind: kind === "shows" ? "show" : "season",
              title: i.Name ?? "Untitled",
              subtitle: parts.length > 0 ? parts.join(" · ") : null,
              thumb: thumbUrl(i),
            };
          });
        res.json({ sample: false, containers, nextOffset, total });
        return;
      }
      // episodes / show_episodes → playable videos.
      const videos = items
        .filter((i) => i.Id)
        .map((i) => {
          const prefix = typeof i.IndexNumber === "number" ? `${i.IndexNumber}. ` : "";
          return {
            id: String(i.Id),
            title: `${prefix}${i.Name ?? "Untitled"}`,
            streamUrl: `${baseUrl}/Videos/${encodeURIComponent(String(i.Id))}/stream?static=true&api_key=${apiKey}`,
            durationMs:
              typeof i.RunTimeTicks === "number" ? Math.round(i.RunTimeTicks / 10000) : null,
            thumb: thumbUrl(i),
          };
        });
      res.json({ sample: false, videos, nextOffset, total });
    } catch (err) {
      logger.error({ reason: describeHttpError(err) }, "Jellyfin video browse error");
      res.status(502).json({ error: "Failed to browse videos from Jellyfin" });
    }
    return;
  }

  const conn = resolvePlexAudioConnection(req.user!.userId);
  if (!conn) {
    res.json({ sample: true, containers: [], videos: [] });
    return;
  }
  const { baseUrl, token } = conn;
  // Authenticated poster URL the browser can load directly (same pattern as
  // stream URLs — the tile already talks to Plex directly for media).
  const thumbUrl = (thumb: unknown): string | null =>
    typeof thumb === "string" && thumb.startsWith("/")
      ? `${baseUrl}${thumb}?X-Plex-Token=${token}`
      : null;
  try {
    const path =
      kind === "recently_added"
        ? "/library/recentlyAdded"
        : kind === "continue_watching"
          ? "/library/onDeck"
          : kind === "shows" || kind === "movies"
            ? `/library/sections/${encodeURIComponent(libraryId)}/all`
            : kind === "show_episodes"
              ? `/library/metadata/${encodeURIComponent(id)}/allLeaves`
              : `/library/metadata/${encodeURIComponent(id)}/children`;
    const r = await httpClient.get(`${baseUrl}${path}`, {
      headers: { "X-Plex-Token": token, Accept: "application/json" },
      // Plex server-side paging: return one window of the listing. totalSize
      // in the response carries the full level size for nextOffset math.
      params: {
        "X-Plex-Container-Start": String(offset),
        "X-Plex-Container-Size": String(VIDEO_PLAYLIST_LIMIT),
      },
    });
    const container = r.data?.MediaContainer as
      | { totalSize?: number; size?: number }
      | undefined;
    const rawRows = (r.data?.MediaContainer?.Metadata ?? []) as unknown[];
    const total =
      typeof container?.totalSize === "number" ? container.totalSize : null;
    const nextOffset =
      total != null
        ? offset + rawRows.length < total
          ? offset + rawRows.length
          : null
        : rawRows.length >= VIDEO_PLAYLIST_LIMIT
          ? offset + rawRows.length
          : null;
    const rows = rawRows as Array<{
      ratingKey?: string | number;
      title?: string;
      grandparentTitle?: string;
      parentTitle?: string;
      type?: string;
      index?: number;
      year?: number;
      leafCount?: number;
      childCount?: number;
      thumb?: string;
      duration?: number;
      Media?: PlexVideoMedia[];
    }>;
    if (kind === "recently_added" || kind === "continue_watching") {
      // Home categories return MIXED rows: playable episodes/movies plus
      // show/season containers (Recently Added surfaces whole seasons).
      // Playable rows become videos with their show context in the title;
      // container rows keep drill-in behaviour via the existing grid.
      const containers: Array<{
        id: string;
        kind: string;
        title: string;
        subtitle: string | null;
        thumb: string | null;
      }> = [];
      const videos: Array<{
        id: string;
        title: string;
        streamUrl: string;
        durationMs: number | null;
        thumb: string | null;
      }> = [];
      for (const m of rows.slice(0, VIDEO_PLAYLIST_LIMIT)) {
        const ratingKey = String(m.ratingKey ?? "");
        if (m.type === "episode" || m.type === "movie") {
          const streamUrl = plexVideoStreamUrl(baseUrl, token, ratingKey, m.Media?.[0]);
          if (!streamUrl) continue;
          const context =
            m.type === "episode" && m.grandparentTitle ? `${m.grandparentTitle} · ` : "";
          const prefix =
            m.type === "episode" && typeof m.index === "number" ? `${m.index}. ` : "";
          videos.push({
            id: ratingKey,
            title: `${context}${prefix}${m.title ?? "Untitled"}`,
            streamUrl,
            durationMs: typeof m.duration === "number" ? m.duration : null,
            thumb: thumbUrl(m.thumb),
          });
        } else if (m.type === "show" || m.type === "season") {
          const count = m.leafCount ?? m.childCount;
          const parts = [
            m.type === "season" ? (m.parentTitle ?? null) : m.year ? String(m.year) : null,
            typeof count === "number"
              ? `${count} episode${count === 1 ? "" : "s"}`
              : null,
          ].filter(Boolean);
          containers.push({
            id: String(m.ratingKey ?? ""),
            kind: m.type,
            title: m.title ?? "Untitled",
            subtitle: parts.length > 0 ? parts.join(" · ") : null,
            thumb: thumbUrl(m.thumb),
          });
        }
      }
      res.json({ sample: false, containers, videos, nextOffset, total });
      return;
    }
    if (kind === "shows" || kind === "seasons") {
      const containers = rows
        // Plex season listings can include an "All episodes" pseudo-entry
        // whose type is not "season"; keep only real containers.
        .filter((m) => (kind === "shows" ? m.type === "show" : m.type === "season"))
        .slice(0, VIDEO_PLAYLIST_LIMIT)
        .map((m) => {
          const count = m.leafCount ?? m.childCount;
          const parts = [
            kind === "shows" && m.year ? String(m.year) : null,
            typeof count === "number"
              ? `${count} episode${count === 1 ? "" : "s"}`
              : null,
          ].filter(Boolean);
          return {
            id: String(m.ratingKey ?? ""),
            kind: kind === "shows" ? "show" : "season",
            title: m.title ?? "Untitled",
            subtitle: parts.length > 0 ? parts.join(" · ") : null,
            thumb: thumbUrl(m.thumb),
          };
        });
      res.json({ sample: false, containers, nextOffset, total });
      return;
    }
    // movies / episodes / show_episodes → playable videos (movies keep
    // their plain title — no index prefix — and carry a poster thumb).
    const videos = rows
      .slice(0, VIDEO_PLAYLIST_LIMIT)
      .map((m) => {
        const ratingKey = String(m.ratingKey ?? "");
        const streamUrl = plexVideoStreamUrl(baseUrl, token, ratingKey, m.Media?.[0]);
        if (!streamUrl) return null;
        const prefix =
          kind !== "movies" && typeof m.index === "number" ? `${m.index}. ` : "";
        return {
          id: ratingKey,
          title: `${prefix}${m.title ?? "Untitled"}`,
          streamUrl,
          durationMs: typeof m.duration === "number" ? m.duration : null,
          thumb: thumbUrl(m.thumb),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    res.json({ sample: false, videos, nextOffset, total });
  } catch (err) {
    logger.error({ reason: describeHttpError(err) }, "Plex video browse error");
    res.status(502).json({ error: "Failed to browse videos from Plex" });
  }
});

router.get("/videoplayer", requireAuth, async (req: AuthRequest, res) => {
  const server = String(req.query["server"] ?? "");
  if (server !== "plex" && server !== "jellyfin") {
    res.status(400).json({ error: "server must be plex or jellyfin" });
    return;
  }
  const libraryId = String(req.query["libraryId"] ?? "");
  const userId = req.user!.userId;

  if (server === "plex") {
    const conn = resolvePlexAudioConnection(userId);
    if (!conn) {
      res.json({ sample: true, videos: [] });
      return;
    }
    if (!libraryId) {
      res.status(400).json({ error: "libraryId is required" });
      return;
    }
    try {
      const { baseUrl, token } = conn;
      const fetchRows = async (params?: Record<string, string>) => {
        const r = await httpClient.get(
          `${baseUrl}/library/sections/${encodeURIComponent(libraryId)}/all`,
          { headers: { "X-Plex-Token": token, Accept: "application/json" }, params },
        );
        return (r.data?.MediaContainer?.Metadata ?? []) as Array<{
          ratingKey?: string | number;
          title?: string;
          grandparentTitle?: string;
          type?: string;
          duration?: number;
          Media?: PlexVideoMedia[];
        }>;
      };
      let rows = await fetchRows();
      // Show libraries return show containers (no playable parts); re-query
      // for episodes (Plex type 4) to get direct-play items.
      if (rows.length > 0 && rows[0]?.type === "show") {
        rows = await fetchRows({ type: "4" });
      }
      const videos = rows
        .slice(0, VIDEO_PLAYLIST_LIMIT)
        .map((m) => {
          const ratingKey = String(m.ratingKey ?? "");
          const streamUrl = plexVideoStreamUrl(baseUrl, token, ratingKey, m.Media?.[0]);
          if (!streamUrl) return null;
          const title = m.grandparentTitle ? `${m.grandparentTitle} — ${m.title ?? ""}` : (m.title ?? "Untitled");
          return {
            id: ratingKey,
            title,
            streamUrl,
            durationMs: typeof m.duration === "number" ? m.duration : null,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);
      res.json({ sample: false, videos });
    } catch (err) {
      logger.error({ reason: describeHttpError(err) }, "Plex video playlist error");
      res.status(502).json({ error: "Failed to load videos from Plex" });
    }
    return;
  }

  // Jellyfin
  const { baseUrl, apiKey } = resolveJellyfinAudioConnection(userId);
  if (!baseUrl || !apiKey) {
    res.json({ sample: true, videos: [] });
    return;
  }
  if (!libraryId) {
    res.status(400).json({ error: "libraryId is required" });
    return;
  }
  try {
    const r = await httpClient.get(`${baseUrl}/Items`, {
      params: {
        api_key: apiKey,
        ParentId: libraryId,
        Recursive: "true",
        IncludeItemTypes: "Movie,Episode,Video,MusicVideo",
        Fields: "RunTimeTicks",
        Limit: String(VIDEO_PLAYLIST_LIMIT),
      },
    });
    const items = (r.data?.Items ?? []) as Array<{
      Id?: string;
      Name?: string;
      SeriesName?: string;
      RunTimeTicks?: number;
    }>;
    const videos = items
      .filter((i) => i.Id)
      .map((i) => ({
        id: String(i.Id),
        title: i.SeriesName ? `${i.SeriesName} — ${i.Name ?? ""}` : (i.Name ?? "Untitled"),
        streamUrl: `${baseUrl}/Videos/${encodeURIComponent(String(i.Id))}/stream?static=true&api_key=${apiKey}`,
        durationMs:
          typeof i.RunTimeTicks === "number" ? Math.round(i.RunTimeTicks / 10000) : null,
      }));
    res.json({ sample: false, videos });
  } catch (err) {
    logger.error({ reason: describeHttpError(err) }, "Jellyfin video playlist error");
    res.status(502).json({ error: "Failed to load videos from Jellyfin" });
  }
});

router.get("/audioplayer", requireAuth, async (req: AuthRequest, res) => {
  // Source selects the music backend. Spotify uses the linked OAuth account;
  // anything else resolves to Plex (the original/default source).
  const requested = String(req.query["source"] ?? "plex");
  if (requested === "spotify") {
    await handleSpotifyAudio(req.user!.userId, res);
    return;
  }
  if (requested === "jellyfin") {
    await handleJellyfinAudio(req.user!.userId, res);
    return;
  }
  if (requested === "subsonic") {
    await handleSubsonicAudio(req.user!.userId, res);
    return;
  }
  const source = "plex";

  // Plex stores the token under `token` or `apiKey`. Fall back to a Plex-typed
  // env media server when no Plex connection is saved (mirrors /media).
  const { baseUrl, apiKey: token } = resolveMediaServerConnection(req.user!.userId, "plex");

  // Unconfigured → built-in demo content (sample:true). streamUrl stays null so
  // the tile labels it not-live and disables in-browser streaming.
  if (!baseUrl || !token) {
    const demo = [
      { id: "1", title: "Dreams", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 257_000, progressMs: 72_000, state: "playing", streamUrl: null },
      { id: "2", title: "The Chain", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 271_000, progressMs: null, state: null, streamUrl: null },
      { id: "3", title: "Go Your Own Way", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 218_000, progressMs: null, state: null, streamUrl: null },
    ];
    res.json({ source, sample: true, nowPlaying: demo[0], queue: demo });
    return;
  }

  try {
    // Prefer the active music session: /status/sessions lists everything playing
    // now; pick the first audio track. When one exists, the queue is its album.
    const sessions = await httpClient.get(`${baseUrl}/status/sessions`, {
      headers: { "X-Plex-Token": token, Accept: "application/json" },
    });
    const session = (sessions.data?.MediaContainer?.Metadata ?? []).find(
      (m: { type?: string }) => m.type === "track",
    ) as (PlexTrackRow & { parentRatingKey?: string | number }) | undefined;

    if (session) {
      const nowPlaying = mapPlexTrack(session, baseUrl, token, true);
      // Best-effort: fetch the album's tracks for skip next/previous. A failure
      // here is additive — the queue degrades to just the now-playing track.
      let queue = [nowPlaying];
      if (session.parentRatingKey != null) {
        try {
          const album = await httpClient.get(
            `${baseUrl}/library/metadata/${session.parentRatingKey}/children`,
            { headers: { "X-Plex-Token": token, Accept: "application/json" } },
          );
          const tracks = (album.data?.MediaContainer?.Metadata ?? []) as PlexTrackRow[];
          if (tracks.length > 0) {
            queue = tracks.map((t) => mapPlexTrack(t, baseUrl!, token!, false));
          }
        } catch (err) {
          logger.warn({ reason: normalizeHttpError(err) }, "Plex album queue fetch failed — using now-playing only");
        }
      }
      res.json({ source, sample: false, nowPlaying, queue });
      return;
    }

    // No active session → fall back to the most recently added music tracks.
    // Locate the music library section (type "artist"), then list its tracks
    // (type=10) newest-first. nowPlaying is the first of that list.
    const sections = await httpClient.get(`${baseUrl}/library/sections`, {
      headers: { "X-Plex-Token": token, Accept: "application/json" },
    });
    const musicSection = (sections.data?.MediaContainer?.Directory ?? []).find(
      (d: { type?: string }) => d.type === "artist",
    ) as { key?: string } | undefined;

    if (!musicSection?.key) {
      // Configured but no music library — return an empty, non-sample payload so
      // the tile shows an honest empty state rather than demo content.
      res.json({ source, sample: false, nowPlaying: null, queue: [] });
      return;
    }

    const recent = await httpClient.get(
      `${baseUrl}/library/sections/${musicSection.key}/all`,
      {
        headers: { "X-Plex-Token": token, Accept: "application/json" },
        params: { type: 10, sort: "addedAt:desc", "X-Plex-Container-Size": 25 },
      },
    );
    const tracks = (recent.data?.MediaContainer?.Metadata ?? []) as PlexTrackRow[];
    const queue = tracks.map((t) => mapPlexTrack(t, baseUrl!, token!, false));
    res.json({ source, sample: false, nowPlaying: queue[0] ?? null, queue });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Audio player widget error");
    res.status(502).json({ error: "Failed to fetch audio player data" });
  }
});

// ────────────────────────────────────────────────
// Audio Player — library navigation (search / browse / playlists)
// ────────────────────────────────────────────────
// Backs the pop-out music browser on Plex and Navidrome / Subsonic Audio Player
// tiles. These read-only endpoints let the user find music to play: search by
// name, browse the library (recently added, albums, artists with drill-down),
// and pick from existing playlists. Anything playable is returned in the same
// AudioTrack shape the shared playback engine already consumes; containers
// (artists / albums / playlists) carry an id the client drills into via the
// browse endpoint. Mirrors the existing widget conventions: built-in demo data
// when unconfigured (sample:true, streamUrl null), HTTP 502 on a configured
// source that fails.

// A container (artist / album / playlist) the user can drill into. `kind` tells
// the client how to expand it; `id` is the source identifier used for browse.
interface AudioContainer {
  id: string;
  kind: "artist" | "album" | "playlist";
  title: string;
  subtitle: string | null;
  artwork: string | null;
}

// A directory/listing row from Plex (artist, album, or playlist). Plex returns
// these under MediaContainer.Metadata (and occasionally Directory) with a per-
// item `type` field. Only the fields the browser needs are modeled.
interface PlexDirRow {
  ratingKey?: string | number;
  title?: string;
  parentTitle?: string;
  thumb?: string;
  composite?: string;
  leafCount?: number;
  childCount?: number;
}

// Resolve the Plex base URL + token for music browsing, mirroring the
// /audioplayer route: prefer the saved Plex connection, fall back to a
// Plex-typed env media server. Returns null when neither is configured.
function resolvePlexAudioConnection(userId: number): { baseUrl: string; token: string } | null {
  const { baseUrl, apiKey } = resolveMediaServerConnection(userId, "plex");
  if (baseUrl && apiKey) return { baseUrl, token: apiKey };
  return null;
}

function plexArtwork(
  path: string | undefined,
  baseUrl: string,
  token: string,
): string | null {
  return path ? `${baseUrl}${path}?X-Plex-Token=${token}` : null;
}

function mapPlexArtist(d: PlexDirRow, baseUrl: string, token: string): AudioContainer {
  return {
    id: String(d.ratingKey ?? ""),
    kind: "artist",
    title: d.title ?? "Unknown artist",
    subtitle: typeof d.childCount === "number" ? `${d.childCount} albums` : null,
    artwork: plexArtwork(d.thumb, baseUrl, token),
  };
}

function mapPlexAlbum(d: PlexDirRow, baseUrl: string, token: string): AudioContainer {
  return {
    id: String(d.ratingKey ?? ""),
    kind: "album",
    title: d.title ?? "Unknown album",
    subtitle: d.parentTitle ?? null,
    artwork: plexArtwork(d.thumb, baseUrl, token),
  };
}

function mapPlexPlaylist(d: PlexDirRow, baseUrl: string, token: string): AudioContainer {
  return {
    id: String(d.ratingKey ?? ""),
    kind: "playlist",
    title: d.title ?? "Untitled playlist",
    subtitle: typeof d.leafCount === "number" ? `${d.leafCount} tracks` : null,
    artwork: plexArtwork(d.composite ?? d.thumb, baseUrl, token),
  };
}

// GET a Plex endpoint and return its MediaContainer.Metadata rows (or []).
async function plexMetadata(
  baseUrl: string,
  token: string,
  path: string,
  params?: Record<string, unknown>,
): Promise<Array<PlexDirRow & PlexTrackRow>> {
  const r = await httpClient.get(`${baseUrl}${path}`, {
    headers: { "X-Plex-Token": token, Accept: "application/json" },
    ...(params ? { params } : {}),
  });
  return (r.data?.MediaContainer?.Metadata ?? []) as Array<PlexDirRow & PlexTrackRow>;
}

// Locate the Plex music library section key (the "artist"-type section). Returns
// null when the server has no music library.
async function findPlexMusicSectionKey(
  baseUrl: string,
  token: string,
): Promise<string | null> {
  const sections = await httpClient.get(`${baseUrl}/library/sections`, {
    headers: { "X-Plex-Token": token, Accept: "application/json" },
  });
  const musicSection = (sections.data?.MediaContainer?.Directory ?? []).find(
    (d: { type?: string }) => d.type === "artist",
  ) as { key?: string } | undefined;
  return musicSection?.key ?? null;
}

// ── Subsonic library listing rows ────────────────────────────────────────────
interface SubsonicAlbum {
  id?: string;
  name?: string;
  title?: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
}
interface SubsonicArtist {
  id?: string;
  name?: string;
  coverArt?: string;
  albumCount?: number;
}
interface SubsonicPlaylist {
  id?: string;
  name?: string;
  coverArt?: string;
  songCount?: number;
}

function subsonicCover(
  coverArt: string | undefined,
  baseUrl: string,
  mediaQuery: string,
): string | null {
  return coverArt
    ? `${baseUrl}/rest/getCoverArt.view?id=${encodeURIComponent(coverArt)}&size=300&${mediaQuery}`
    : null;
}

function mapSubsonicAlbum(
  a: SubsonicAlbum,
  baseUrl: string,
  mediaQuery: string,
): AudioContainer {
  return {
    id: String(a.id ?? ""),
    kind: "album",
    title: a.name ?? a.title ?? "Unknown album",
    subtitle: a.artist ?? null,
    artwork: subsonicCover(a.coverArt ?? a.id, baseUrl, mediaQuery),
  };
}

function mapSubsonicArtist(
  a: SubsonicArtist,
  baseUrl: string,
  mediaQuery: string,
): AudioContainer {
  return {
    id: String(a.id ?? ""),
    kind: "artist",
    title: a.name ?? "Unknown artist",
    subtitle: typeof a.albumCount === "number" ? `${a.albumCount} albums` : null,
    artwork: subsonicCover(a.coverArt, baseUrl, mediaQuery),
  };
}

function mapSubsonicPlaylist(
  p: SubsonicPlaylist,
  baseUrl: string,
  mediaQuery: string,
): AudioContainer {
  return {
    id: String(p.id ?? ""),
    kind: "playlist",
    title: p.name ?? "Untitled playlist",
    subtitle: typeof p.songCount === "number" ? `${p.songCount} tracks` : null,
    artwork: subsonicCover(p.coverArt ?? p.id, baseUrl, mediaQuery),
  };
}

// Built-in demo content for the browser when a source is unconfigured. Mirrors
// the demo now-playing payload: streamUrl null so nothing is actually playable.
const DEMO_TRACKS = [
  { id: "1", title: "Dreams", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 257_000, progressMs: null, state: null, streamUrl: null },
  { id: "2", title: "The Chain", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 271_000, progressMs: null, state: null, streamUrl: null },
  { id: "3", title: "Go Your Own Way", artist: "Fleetwood Mac", album: "Rumours", artwork: null, durationMs: 218_000, progressMs: null, state: null, streamUrl: null },
];
const DEMO_ALBUMS: AudioContainer[] = [
  { id: "d-album-1", kind: "album", title: "Rumours", subtitle: "Fleetwood Mac", artwork: null },
  { id: "d-album-2", kind: "album", title: "Hounds of Love", subtitle: "Kate Bush", artwork: null },
];
const DEMO_ARTISTS: AudioContainer[] = [
  { id: "d-artist-1", kind: "artist", title: "Fleetwood Mac", subtitle: "5 albums", artwork: null },
  { id: "d-artist-2", kind: "artist", title: "Kate Bush", subtitle: "3 albums", artwork: null },
];
const DEMO_PLAYLISTS: AudioContainer[] = [
  { id: "d-playlist-1", kind: "playlist", title: "Chill Mix", subtitle: "12 tracks", artwork: null },
  { id: "d-playlist-2", kind: "playlist", title: "Workout", subtitle: "20 tracks", artwork: null },
];

// Demo result for the search endpoint when unconfigured.
function demoSearchResult(source: string) {
  return {
    source,
    sample: true,
    artists: DEMO_ARTISTS,
    albums: DEMO_ALBUMS,
    tracks: DEMO_TRACKS,
  };
}

// Demo result for the browse endpoint when unconfigured, shaped per kind.
function demoBrowseResult(source: string, kind: string) {
  if (kind === "artists") return { source, sample: true, artists: DEMO_ARTISTS };
  if (kind === "playlists") return { source, sample: true, playlists: DEMO_PLAYLISTS };
  if (kind === "artist") return { source, sample: true, albums: DEMO_ALBUMS };
  if (kind === "album" || kind === "playlist" || kind === "random") {
    return { source, sample: true, tracks: DEMO_TRACKS };
  }
  // recent / albums
  return { source, sample: true, albums: DEMO_ALBUMS };
}

// ── Plex search / browse handlers ────────────────────────────────────────────
async function plexSearchLibrary(
  userId: number,
  res: import("express").Response,
  query: string,
): Promise<void> {
  const conn = resolvePlexAudioConnection(userId);
  if (!conn) {
    res.json(demoSearchResult("plex"));
    return;
  }
  if (!query) {
    res.json({ source: "plex", sample: false, artists: [], albums: [], tracks: [] });
    return;
  }
  try {
    const r = await httpClient.get(`${conn.baseUrl}/hubs/search`, {
      headers: { "X-Plex-Token": conn.token, Accept: "application/json" },
      params: { query, limit: 30 },
    });
    const hubs = (r.data?.MediaContainer?.Hub ?? []) as Array<{
      type?: string;
      Metadata?: Array<PlexDirRow & PlexTrackRow & { type?: string }>;
      Directory?: Array<PlexDirRow & { type?: string }>;
    }>;
    const artists: AudioContainer[] = [];
    const albums: AudioContainer[] = [];
    const tracks: ReturnType<typeof mapPlexTrack>[] = [];
    for (const hub of hubs) {
      const items = hub.Metadata ?? hub.Directory ?? [];
      for (const item of items) {
        const t = item.type ?? hub.type;
        if (t === "artist") artists.push(mapPlexArtist(item, conn.baseUrl, conn.token));
        else if (t === "album") albums.push(mapPlexAlbum(item, conn.baseUrl, conn.token));
        else if (t === "track") {
          tracks.push(mapPlexTrack(item as PlexTrackRow, conn.baseUrl, conn.token, false));
        }
      }
    }
    res.json({
      source: "plex",
      sample: false,
      artists: artists.slice(0, 20),
      albums: albums.slice(0, 20),
      tracks: tracks.slice(0, 30),
    });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Plex music search error");
    res.status(502).json({ error: "Failed to search the music library" });
  }
}

async function plexBrowseLibrary(
  userId: number,
  res: import("express").Response,
  kind: string,
  id: string,
): Promise<void> {
  const conn = resolvePlexAudioConnection(userId);
  if (!conn) {
    res.json(demoBrowseResult("plex", kind));
    return;
  }
  const { baseUrl, token } = conn;
  try {
    // Drill-down kinds operate on a specific container id.
    if (kind === "artist") {
      const rows = await plexMetadata(baseUrl, token, `/library/metadata/${encodeURIComponent(id)}/children`);
      res.json({ source: "plex", sample: false, albums: rows.map((d) => mapPlexAlbum(d, baseUrl, token)) });
      return;
    }
    if (kind === "album") {
      const rows = await plexMetadata(baseUrl, token, `/library/metadata/${encodeURIComponent(id)}/children`);
      res.json({ source: "plex", sample: false, tracks: rows.map((t) => mapPlexTrack(t, baseUrl, token, false)) });
      return;
    }
    if (kind === "playlist") {
      const rows = await plexMetadata(baseUrl, token, `/playlists/${encodeURIComponent(id)}/items`);
      res.json({ source: "plex", sample: false, tracks: rows.map((t) => mapPlexTrack(t, baseUrl, token, false)) });
      return;
    }
    if (kind === "playlists") {
      const rows = await plexMetadata(baseUrl, token, `/playlists`, { playlistType: "audio" });
      res.json({ source: "plex", sample: false, playlists: rows.map((d) => mapPlexPlaylist(d, baseUrl, token)) });
      return;
    }

    // Top-level library listings need the music section key.
    const sectionKey = await findPlexMusicSectionKey(baseUrl, token);
    if (!sectionKey) {
      res.json({ source: "plex", sample: false, albums: [], artists: [] });
      return;
    }
    if (kind === "random") {
      const rows = await plexMetadata(baseUrl, token, `/library/sections/${sectionKey}/all`, {
        type: 10,
        sort: "random",
        "X-Plex-Container-Size": 20,
      });
      res.json({ source: "plex", sample: false, tracks: rows.map((t) => mapPlexTrack(t, baseUrl, token, false)) });
      return;
    }
    if (kind === "artists") {
      const rows = await plexMetadata(baseUrl, token, `/library/sections/${sectionKey}/all`, {
        type: 8,
        sort: "titleSort",
        "X-Plex-Container-Size": 100,
      });
      res.json({ source: "plex", sample: false, artists: rows.map((d) => mapPlexArtist(d, baseUrl, token)) });
      return;
    }
    // recent or albums
    const params =
      kind === "recent"
        ? { type: 9, sort: "addedAt:desc", "X-Plex-Container-Size": 40 }
        : { type: 9, sort: "titleSort", "X-Plex-Container-Size": 100 };
    const rows = await plexMetadata(baseUrl, token, `/library/sections/${sectionKey}/all`, params);
    res.json({ source: "plex", sample: false, albums: rows.map((d) => mapPlexAlbum(d, baseUrl, token)) });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err), kind }, "Plex music browse error");
    res.status(502).json({ error: "Failed to browse the music library" });
  }
}

// ── Subsonic search / browse handlers ────────────────────────────────────────
function subsonicConn(userId: number) {
  const saved = getSavedConnection(userId, "subsonic");
  if (!saved.url || !saved.username || !saved.password) return null;
  return { baseUrl: saved.url, username: saved.username, password: saved.password };
}

async function subsonicSearchLibrary(
  userId: number,
  res: import("express").Response,
  query: string,
): Promise<void> {
  const conn = subsonicConn(userId);
  if (!conn) {
    res.json(demoSearchResult("subsonic"));
    return;
  }
  if (!query) {
    res.json({ source: "subsonic", sample: false, artists: [], albums: [], tracks: [] });
    return;
  }
  try {
    const auth = subsonicAuthParams(conn.username, conn.password);
    const mediaQuery = subsonicMediaQuery(auth);
    const body = await subsonicGet(conn.baseUrl, "search3.view", auth, {
      query,
      artistCount: 20,
      albumCount: 20,
      songCount: 30,
    });
    const result = (body["searchResult3"] ?? {}) as {
      artist?: SubsonicArtist[];
      album?: SubsonicAlbum[];
      song?: SubsonicSong[];
    };
    res.json({
      source: "subsonic",
      sample: false,
      artists: (result.artist ?? []).map((a) => mapSubsonicArtist(a, conn.baseUrl, mediaQuery)),
      albums: (result.album ?? []).map((a) => mapSubsonicAlbum(a, conn.baseUrl, mediaQuery)),
      tracks: (result.song ?? []).map((s) => mapSubsonicTrack(s, conn.baseUrl, mediaQuery, false)),
    });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Subsonic music search error");
    res.status(502).json({ error: "Failed to search the music library" });
  }
}

async function subsonicBrowseLibrary(
  userId: number,
  res: import("express").Response,
  kind: string,
  id: string,
): Promise<void> {
  const conn = subsonicConn(userId);
  if (!conn) {
    res.json(demoBrowseResult("subsonic", kind));
    return;
  }
  try {
    const auth = subsonicAuthParams(conn.username, conn.password);
    const mediaQuery = subsonicMediaQuery(auth);
    const { baseUrl } = conn;

    if (kind === "artist") {
      const body = await subsonicGet(baseUrl, "getArtist.view", auth, { id });
      const albums = ((body["artist"] as { album?: SubsonicAlbum[] } | undefined)?.album ?? []);
      res.json({ source: "subsonic", sample: false, albums: albums.map((a) => mapSubsonicAlbum(a, baseUrl, mediaQuery)) });
      return;
    }
    if (kind === "album") {
      const body = await subsonicGet(baseUrl, "getAlbum.view", auth, { id });
      const songs = ((body["album"] as { song?: SubsonicSong[] } | undefined)?.song ?? []);
      res.json({ source: "subsonic", sample: false, tracks: songs.map((s) => mapSubsonicTrack(s, baseUrl, mediaQuery, false)) });
      return;
    }
    if (kind === "playlist") {
      const body = await subsonicGet(baseUrl, "getPlaylist.view", auth, { id });
      const entries = ((body["playlist"] as { entry?: SubsonicSong[] } | undefined)?.entry ?? []);
      res.json({ source: "subsonic", sample: false, tracks: entries.map((s) => mapSubsonicTrack(s, baseUrl, mediaQuery, false)) });
      return;
    }
    if (kind === "playlists") {
      const body = await subsonicGet(baseUrl, "getPlaylists.view", auth);
      const lists = ((body["playlists"] as { playlist?: SubsonicPlaylist[] } | undefined)?.playlist ?? []);
      res.json({ source: "subsonic", sample: false, playlists: lists.map((p) => mapSubsonicPlaylist(p, baseUrl, mediaQuery)) });
      return;
    }
    if (kind === "artists") {
      const body = await subsonicGet(baseUrl, "getArtists.view", auth);
      const indexes = ((body["artists"] as { index?: Array<{ artist?: SubsonicArtist[] }> } | undefined)?.index ?? []);
      const artists = indexes.flatMap((i) => i.artist ?? []);
      res.json({ source: "subsonic", sample: false, artists: artists.map((a) => mapSubsonicArtist(a, baseUrl, mediaQuery)) });
      return;
    }
    if (kind === "random") {
      const body = await subsonicGet(baseUrl, "getRandomSongs.view", auth, { size: 20 });
      const songs = ((body["randomSongs"] as { song?: SubsonicSong[] } | undefined)?.song ?? []);
      res.json({ source: "subsonic", sample: false, tracks: songs.map((s) => mapSubsonicTrack(s, baseUrl, mediaQuery, false)) });
      return;
    }
    // recent or albums
    const type = kind === "recent" ? "newest" : "alphabeticalByName";
    const size = kind === "recent" ? 40 : 100;
    const body = await subsonicGet(baseUrl, "getAlbumList2.view", auth, { type, size });
    const albums = ((body["albumList2"] as { album?: SubsonicAlbum[] } | undefined)?.album ?? []);
    res.json({ source: "subsonic", sample: false, albums: albums.map((a) => mapSubsonicAlbum(a, baseUrl, mediaQuery)) });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err), kind }, "Subsonic music browse error");
    res.status(502).json({ error: "Failed to browse the music library" });
  }
}

// ── Jellyfin search / browse handlers ────────────────────────────────────────
// A Jellyfin container row (MusicArtist / MusicAlbum / Playlist item) as
// returned by /Items or /Artists. Only what the music browser needs.
interface JellyfinContainerItem {
  Id?: string;
  Name?: string;
  Type?: string;
  AlbumArtist?: string;
  ChildCount?: number;
  SongCount?: number;
  ImageTags?: { Primary?: string };
}

function jellyfinContainerArt(
  item: JellyfinContainerItem,
  baseUrl: string,
  apiKey: string,
): string | null {
  return item.ImageTags?.Primary && item.Id
    ? `${baseUrl}/Items/${item.Id}/Images/Primary?api_key=${apiKey}&maxHeight=200`
    : null;
}

function mapJellyfinArtist(
  item: JellyfinContainerItem,
  baseUrl: string,
  apiKey: string,
): AudioContainer {
  return {
    id: String(item.Id ?? ""),
    kind: "artist",
    title: item.Name ?? "Unknown artist",
    subtitle: null,
    artwork: jellyfinContainerArt(item, baseUrl, apiKey),
  };
}

function mapJellyfinAlbum(
  item: JellyfinContainerItem,
  baseUrl: string,
  apiKey: string,
): AudioContainer {
  return {
    id: String(item.Id ?? ""),
    kind: "album",
    title: item.Name ?? "Unknown album",
    subtitle: item.AlbumArtist ?? null,
    artwork: jellyfinContainerArt(item, baseUrl, apiKey),
  };
}

function mapJellyfinPlaylist(
  item: JellyfinContainerItem,
  baseUrl: string,
  apiKey: string,
): AudioContainer {
  const count = item.SongCount ?? item.ChildCount;
  return {
    id: String(item.Id ?? ""),
    kind: "playlist",
    title: item.Name ?? "Untitled playlist",
    subtitle: typeof count === "number" ? `${count} tracks` : null,
    artwork: jellyfinContainerArt(item, baseUrl, apiKey),
  };
}

// GET a Jellyfin /Items listing and return its Items rows (or []). Attaches the
// resolved Jellyfin user so tracks carry UserData.IsFavorite when possible.
async function jellyfinItems(
  baseUrl: string,
  apiKey: string,
  params: Record<string, unknown>,
): Promise<JellyfinAudioItem[]> {
  const jfUserId = await fetchJellyfinUserId(baseUrl, apiKey);
  const r = await httpClient.get(`${baseUrl}/Items`, {
    params: { api_key: apiKey, ...(jfUserId ? { userId: jfUserId } : {}), ...params },
  });
  return (r.data?.Items ?? []) as JellyfinAudioItem[];
}

async function jellyfinSearchLibrary(
  userId: number,
  res: import("express").Response,
  query: string,
): Promise<void> {
  const { baseUrl, apiKey } = resolveJellyfinAudioConnection(userId);
  if (!baseUrl || !apiKey) {
    res.json(demoSearchResult("jellyfin"));
    return;
  }
  if (!query) {
    res.json({ source: "jellyfin", sample: false, artists: [], albums: [], tracks: [] });
    return;
  }
  try {
    const items = (await jellyfinItems(baseUrl, apiKey, {
      searchTerm: query,
      IncludeItemTypes: "MusicArtist,MusicAlbum,Audio",
      Recursive: true,
      Limit: 70,
    })) as Array<JellyfinAudioItem & JellyfinContainerItem>;
    const artists: AudioContainer[] = [];
    const albums: AudioContainer[] = [];
    const tracks: ReturnType<typeof mapJellyfinTrack>[] = [];
    for (const item of items) {
      if (item.Type === "MusicArtist") artists.push(mapJellyfinArtist(item, baseUrl, apiKey));
      else if (item.Type === "MusicAlbum") albums.push(mapJellyfinAlbum(item, baseUrl, apiKey));
      else if (item.Type === "Audio") tracks.push(mapJellyfinTrack(item, baseUrl, apiKey, null));
    }
    res.json({
      source: "jellyfin",
      sample: false,
      artists: artists.slice(0, 20),
      albums: albums.slice(0, 20),
      tracks: tracks.slice(0, 30),
    });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Jellyfin music search error");
    res.status(502).json({ error: "Failed to search the music library" });
  }
}

async function jellyfinBrowseLibrary(
  userId: number,
  res: import("express").Response,
  kind: string,
  id: string,
): Promise<void> {
  const { baseUrl, apiKey } = resolveJellyfinAudioConnection(userId);
  if (!baseUrl || !apiKey) {
    res.json(demoBrowseResult("jellyfin", kind));
    return;
  }
  try {
    if (kind === "artist") {
      // An artist's albums. ArtistIds (not ParentId) — Jellyfin artists are not
      // the filesystem parent of their albums.
      const rows = await jellyfinItems(baseUrl, apiKey, {
        ArtistIds: id,
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        SortBy: "PremiereDate,SortName",
      });
      res.json({ source: "jellyfin", sample: false, albums: rows.map((r) => mapJellyfinAlbum(r, baseUrl, apiKey)) });
      return;
    }
    if (kind === "album" || kind === "playlist") {
      const rows = await jellyfinItems(baseUrl, apiKey, {
        ParentId: id,
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: kind === "album" ? "ParentIndexNumber,IndexNumber,SortName" : "ListItemOrder",
      });
      res.json({ source: "jellyfin", sample: false, tracks: rows.map((r) => mapJellyfinTrack(r, baseUrl, apiKey, null)) });
      return;
    }
    if (kind === "playlists") {
      const rows = await jellyfinItems(baseUrl, apiKey, {
        IncludeItemTypes: "Playlist",
        Recursive: true,
        SortBy: "SortName",
      });
      res.json({ source: "jellyfin", sample: false, playlists: rows.map((r) => mapJellyfinPlaylist(r, baseUrl, apiKey)) });
      return;
    }
    if (kind === "artists") {
      const rows = await jellyfinItems(baseUrl, apiKey, {
        IncludeItemTypes: "MusicArtist",
        Recursive: true,
        SortBy: "SortName",
        Limit: 100,
      });
      res.json({ source: "jellyfin", sample: false, artists: rows.map((r) => mapJellyfinArtist(r, baseUrl, apiKey)) });
      return;
    }
    if (kind === "random") {
      const rows = await jellyfinItems(baseUrl, apiKey, {
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "Random",
        Limit: 20,
      });
      res.json({ source: "jellyfin", sample: false, tracks: rows.map((r) => mapJellyfinTrack(r, baseUrl, apiKey, null)) });
      return;
    }
    // recent or albums
    const rows = await jellyfinItems(baseUrl, apiKey, {
      IncludeItemTypes: "MusicAlbum",
      Recursive: true,
      ...(kind === "recent"
        ? { SortBy: "DateCreated", SortOrder: "Descending", Limit: 40 }
        : { SortBy: "SortName", Limit: 100 }),
    });
    res.json({ source: "jellyfin", sample: false, albums: rows.map((r) => mapJellyfinAlbum(r, baseUrl, apiKey)) });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err), kind }, "Jellyfin music browse error");
    res.status(502).json({ error: "Failed to browse the music library" });
  }
}

// GET /widgets/audioplayer/search — search a source's library by name. Returns
// artists, albums, and playable tracks for the pop-out music browser.
router.get("/audioplayer/search", requireAuth, async (req: AuthRequest, res) => {
  const source = String(req.query["source"] ?? "plex");
  const query = String(req.query["query"] ?? "").trim();
  if (source === "subsonic") {
    await subsonicSearchLibrary(req.user!.userId, res, query);
    return;
  }
  if (source === "jellyfin") {
    await jellyfinSearchLibrary(req.user!.userId, res, query);
    return;
  }
  await plexSearchLibrary(req.user!.userId, res, query);
});

// GET /widgets/audioplayer/browse — list a source's library / playlists, with
// drill-down (artist→albums, album→tracks, playlist→tracks).
const BROWSE_KINDS = ["recent", "albums", "artists", "artist", "album", "playlists", "playlist", "random"];
const BROWSE_KINDS_NEEDING_ID = ["artist", "album", "playlist"];
router.get("/audioplayer/browse", requireAuth, async (req: AuthRequest, res) => {
  const source = String(req.query["source"] ?? "plex");
  const kind = String(req.query["kind"] ?? "");
  const id = String(req.query["id"] ?? "").trim();
  if (!BROWSE_KINDS.includes(kind)) {
    res.status(400).json({ error: "Unknown browse kind" });
    return;
  }
  if (BROWSE_KINDS_NEEDING_ID.includes(kind) && !id) {
    res.status(400).json({ error: `kind=${kind} requires an id` });
    return;
  }
  if (source === "subsonic") {
    await subsonicBrowseLibrary(req.user!.userId, res, kind, id);
    return;
  }
  if (source === "jellyfin") {
    await jellyfinBrowseLibrary(req.user!.userId, res, kind, id);
    return;
  }
  await plexBrowseLibrary(req.user!.userId, res, kind, id);
});

// POST /widgets/spotify/command — remote-control the active Spotify device.
// Backs the Audio Player tile's play/pause/skip buttons and the "transfer"
// action that hands playback to the in-browser Web Playback SDK device.
const SPOTIFY_ACTIONS: SpotifyCommand[] = ["play", "pause", "next", "previous", "transfer"];

router.post("/spotify/command", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { action?: string; deviceId?: string | null };
  const action = body.action as SpotifyCommand | undefined;
  if (!action || !SPOTIFY_ACTIONS.includes(action)) {
    res.status(400).json({ error: "Unknown action" });
    return;
  }
  if (action === "transfer" && !body.deviceId) {
    res.status(400).json({ error: "transfer requires a deviceId" });
    return;
  }

  const conn = getSpotifyConnection(req.user!.userId);
  if (!conn.clientId || !conn.clientSecret || !conn.tokens.refreshToken) {
    res.status(404).json({ error: "Spotify account is not linked" });
    return;
  }

  try {
    const token = await getValidAccessToken(req.user!.userId);
    const result = await sendCommand(token, action, body.deviceId ?? undefined);
    if (result === "no-device") {
      res.status(404).json({ error: "No active Spotify device" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Spotify command error");
    res.status(502).json({ error: "Failed to control Spotify" });
  }
});

// ────────────────────────────────────────────────
// Sonarr Widget
// ────────────────────────────────────────────────
router.get("/sonarr", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "sonarr", {
    url: process.env["SONARR_URL"],
    apiKey: process.env["SONARR_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;

  if (!baseUrl || !apiKey) {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    res.json({
      queue: [
        { id: 1, title: "The Bear - S03E01", status: "downloading", progress: 67.3, size: 1.2e9 },
        { id: 2, title: "House of the Dragon - S02E04", status: "paused", progress: 0, size: 2.1e9 },
      ],
      upcoming: [
        { id: 101, title: "Episode 5", seriesTitle: "The Bear", airDate: tomorrow.toISOString().split("T")[0]!, seasonNumber: 3, episodeNumber: 5 },
        { id: 102, title: "Pilot", seriesTitle: "Andor", airDate: now.toISOString().split("T")[0]!, seasonNumber: 2, episodeNumber: 1 },
      ],
    });
    return;
  }

  try {
    const headers = { "X-Api-Key": apiKey };
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 86400000);

    const [queueRes, calendarRes] = await Promise.all([
      // includeEpisode/includeSeries so each queue record carries the show and
      // episode info; queue is paged and returns its rows under `records`.
      httpClient.get(`${baseUrl}/api/v3/queue`, {
        headers,
        params: { pageSize: 50, includeEpisode: true, includeSeries: true },
      }),
      // includeSeries so the calendar entries carry the series title (otherwise
      // the upcoming list renders blank titles).
      httpClient.get(`${baseUrl}/api/v3/calendar`, {
        headers,
        params: {
          start: now.toISOString().split("T")[0],
          end: end.toISOString().split("T")[0],
          includeSeries: true,
        },
      }),
    ]);

    const queue = (queueRes.data?.records ?? []).slice(0, 5).map((item: { id: number; title: string; status: string; sizeleft?: number; size?: number; series?: { title: string } }) => ({
      id: item.id,
      title: item.series?.title ?? item.title,
      status: item.status,
      progress: item.size ? Math.round((1 - (item.sizeleft ?? 0) / item.size) * 100) : 0,
      size: item.size ?? null,
    }));

    const upcoming = (calendarRes.data ?? []).slice(0, 5).map((ep: { id: number; title: string; series?: { title: string }; airDateUtc?: string; seasonNumber?: number; episodeNumber?: number }) => ({
      id: ep.id,
      title: ep.title,
      seriesTitle: ep.series?.title ?? "",
      airDate: ep.airDateUtc?.split("T")[0] ?? "",
      seasonNumber: ep.seasonNumber ?? null,
      episodeNumber: ep.episodeNumber ?? null,
    }));

    res.json({ queue, upcoming });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Sonarr widget error");
    res.status(502).json({ error: "Failed to fetch Sonarr data" });
  }
});

// ────────────────────────────────────────────────
// Radarr Widget
// ────────────────────────────────────────────────
router.get("/radarr", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "radarr", {
    url: process.env["RADARR_URL"],
    apiKey: process.env["RADARR_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;

  if (!baseUrl || !apiKey) {
    const now = new Date();
    const soon = new Date(now.getTime() + 3 * 86400000);
    res.json({
      queue: [
        { id: 1, title: "Dune: Part Two", status: "downloading", progress: 42.1, size: 8.4e9 },
        { id: 2, title: "The Batman", status: "paused", progress: 0, size: 6.0e9 },
      ],
      upcoming: [
        { id: 201, title: "Furiosa", releaseDate: soon.toISOString().split("T")[0]!, year: 2024 },
        { id: 202, title: "Deadpool & Wolverine", releaseDate: now.toISOString().split("T")[0]!, year: 2024 },
      ],
    });
    return;
  }

  try {
    const headers = { "X-Api-Key": apiKey };
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86400000);

    const [queueRes, calendarRes] = await Promise.all([
      // includeMovie so each queue record carries the movie title; paged rows
      // live under `records`.
      httpClient.get(`${baseUrl}/api/v3/queue`, {
        headers,
        params: { pageSize: 50, includeMovie: true },
      }),
      // includeMovie so calendar entries carry the movie details/titles.
      httpClient.get(`${baseUrl}/api/v3/calendar`, {
        headers,
        params: {
          start: now.toISOString().split("T")[0],
          end: end.toISOString().split("T")[0],
          includeMovie: true,
        },
      }),
    ]);

    const queue = (queueRes.data?.records ?? []).slice(0, 5).map((item: { id: number; title: string; status: string; sizeleft?: number; size?: number; movie?: { title: string } }) => ({
      id: item.id,
      title: item.movie?.title ?? item.title,
      status: item.status,
      progress: item.size ? Math.round((1 - (item.sizeleft ?? 0) / item.size) * 100) : 0,
      size: item.size ?? null,
    }));

    const upcoming = (calendarRes.data ?? []).slice(0, 5).map((m: { id: number; title: string; year?: number; inCinemas?: string; physicalRelease?: string; digitalRelease?: string }) => {
      const release = m.digitalRelease || m.physicalRelease || m.inCinemas || "";
      return {
        id: m.id,
        title: m.title,
        releaseDate: release ? release.split("T")[0] : "",
        year: m.year ?? null,
      };
    });

    res.json({ queue, upcoming });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Radarr widget error");
    res.status(502).json({ error: "Failed to fetch Radarr data" });
  }
});

// ────────────────────────────────────────────────
// Lidarr Widget
// ────────────────────────────────────────────────
router.get("/lidarr", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "lidarr", {
    url: process.env["LIDARR_URL"],
    apiKey: process.env["LIDARR_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;

  if (!baseUrl || !apiKey) {
    const now = new Date();
    const soon = new Date(now.getTime() + 5 * 86400000);
    res.json({
      queue: [
        { id: 1, title: "Tame Impala - Currents", status: "downloading", progress: 58.0, size: 4.2e8 },
        { id: 2, title: "Radiohead - In Rainbows", status: "paused", progress: 0, size: 3.6e8 },
      ],
      upcoming: [
        { id: 301, title: "The New Album", artistName: "Bonobo", releaseDate: soon.toISOString().split("T")[0]! },
        { id: 302, title: "Live Sessions", artistName: "Khruangbin", releaseDate: now.toISOString().split("T")[0]! },
      ],
    });
    return;
  }

  try {
    // Lidarr's API lives under /api/v1/ (not /api/v3/ like Sonarr/Radarr).
    const headers = { "X-Api-Key": apiKey };
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86400000);

    const [queueRes, calendarRes] = await Promise.all([
      // includeArtist/includeAlbum so each queue record carries the artist and
      // album info; queue is paged and returns its rows under `records`.
      httpClient.get(`${baseUrl}/api/v1/queue`, {
        headers,
        params: { pageSize: 50, includeArtist: true, includeAlbum: true },
      }),
      // includeArtist so calendar entries carry the artist name (otherwise the
      // upcoming list renders blank artists).
      httpClient.get(`${baseUrl}/api/v1/calendar`, {
        headers,
        params: {
          start: now.toISOString().split("T")[0],
          end: end.toISOString().split("T")[0],
          includeArtist: true,
        },
      }),
    ]);

    const queue = (queueRes.data?.records ?? []).slice(0, 5).map((item: { id: number; title: string; status: string; sizeleft?: number; size?: number; artist?: { artistName: string } }) => ({
      id: item.id,
      title: item.artist?.artistName ?? item.title,
      status: item.status,
      progress: item.size ? Math.round((1 - (item.sizeleft ?? 0) / item.size) * 100) : 0,
      size: item.size ?? null,
    }));

    const upcoming = (calendarRes.data ?? []).slice(0, 5).map((album: { id: number; title: string; artist?: { artistName: string }; releaseDate?: string }) => ({
      id: album.id,
      title: album.title,
      artistName: album.artist?.artistName ?? "",
      releaseDate: album.releaseDate?.split("T")[0] ?? "",
    }));

    res.json({ queue, upcoming });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Lidarr widget error");
    res.status(502).json({ error: "Failed to fetch Lidarr data" });
  }
});

// ────────────────────────────────────────────────
// qBittorrent Widget
// ────────────────────────────────────────────────
// qBittorrent uses session-cookie auth: log in to obtain the session cookie,
// then reuse it for every subsequent call. The cookie is named "SID" in v4 but
// was renamed to "QBT_SID_<port>" in v5.x, so match either and return the full
// "name=value" pair to send back verbatim.
function extractSessionCookie(setCookie: string[] | undefined): string | undefined {
  for (const cookie of setCookie ?? []) {
    const match = /((?:QBT_)?SID(?:_\d+)?)=([^;]+)/.exec(cookie);
    if (match) return `${match[1]}=${match[2]}`;
  }
  return undefined;
}

// qBittorrent bans clients that log in too frequently, and the tile polls every
// ~10s. Reuse SIDs for a bounded local period, and isolate entries by user,
// normalized endpoint, identity, and a one-way credential fingerprint.
interface QbSid {
  sid: string;
  expiresAt: number;
}

const QB_SID_TTL_MS = 24 * 60 * 60_000;
const qbSidCache = new Map<string, QbSid>();

function qbCacheKey(userId: number, baseUrl: string, username: string, password: string): string {
  return [
    userId,
    normalizeBaseUrl(baseUrl),
    username,
    credentialFingerprint(password),
  ].join("\u0000");
}

// Log in to qBittorrent, cache the resulting SID, and return it. Throws a tagged
// error when authentication is rejected or no session cookie is returned.
async function qbLogin(
  baseUrl: string,
  username: string,
  password: string,
  key: string,
): Promise<string> {
  const form = new URLSearchParams({ username, password });
  const loginRes = await httpClient.post(`${baseUrl}/api/v2/auth/login`, form.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (typeof loginRes.data === "string" && loginRes.data.trim() === "Fails.") {
    throw new Error("qb-auth-failed");
  }

  const sid = extractSessionCookie(loginRes.headers["set-cookie"] as string[] | undefined);
  if (!sid) {
    throw new Error("qb-no-session");
  }

  qbSidCache.set(key, { sid, expiresAt: Date.now() + QB_SID_TTL_MS });
  return sid;
}

function isAuthError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 403
  );
}

router.get("/qbittorrent", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "qbittorrent", {
    url: process.env["QBITTORRENT_URL"],
    username: process.env["QBITTORRENT_USERNAME"],
    password: process.env["QBITTORRENT_PASSWORD"],
  });
  const baseUrl = normalizeBaseUrl(connection.url);
  const username = connection.username?.trim();
  const password = connection.password;

  if (!baseUrl || !username || password == null) {
    res.json({
      torrents: [
        { name: "ubuntu-24.04-desktop-amd64.iso", progress: 73.5, state: "downloading", dlSpeed: 5.2e6, upSpeed: 1.1e5, category: "Linux ISOs" },
        { name: "archlinux-x86_64.iso", progress: 100, state: "uploading", dlSpeed: 0, upSpeed: 8.4e5, category: "Linux ISOs" },
        { name: "Blender Open Movie - Sintel (2010)", progress: 100, state: "uploading", dlSpeed: 0, upSpeed: 2.3e5, category: "Movies" },
      ],
      downloadSpeed: 5.2e6,
      uploadSpeed: 9.5e5,
      categories: ["Linux ISOs", "Movies", "TV Shows", "Music"],
    });
    return;
  }

  // Fetch torrents + transfer stats with a given SID. Lets 403s propagate so the
  // caller can decide whether to re-authenticate.
  const fetchData = (sid: string) =>
    Promise.all([
      httpClient.get(`${baseUrl}/api/v2/torrents/info`, { headers: { Cookie: sid } }),
      httpClient.get(`${baseUrl}/api/v2/transfer/info`, { headers: { Cookie: sid } }),
    ]);

  // Fetch the full category catalog separately. qBittorrent's dedicated
  // categories endpoint returns every defined category — even ones with no
  // active torrents — so the tile filter can list them all. Failures here must
  // not break the rest of the response, so callers handle errors and fall back
  // to an empty catalog.
  const fetchCategories = (sid: string) =>
    httpClient.get(`${baseUrl}/api/v2/torrents/categories`, { headers: { Cookie: sid } });

  const key = qbCacheKey(req.user!.userId, baseUrl, username, password);

  try {
    // Reuse the cached SID when present; only log in when there is none.
    let cached = qbSidCache.get(key);
    if (cached && cached.expiresAt <= Date.now()) {
      qbSidCache.delete(key);
      cached = undefined;
    }
    let sid = cached?.sid;
    if (!sid) {
      sid = await qbLogin(baseUrl, username, password, key);
    }

    let torrentsRes;
    let transferRes;
    try {
      [torrentsRes, transferRes] = await fetchData(sid);
    } catch (err) {
      // A cached session can expire server-side; on a 403 drop it, log in once
      // more, and retry the data fetch a single time.
      if (isAuthError(err)) {
        qbSidCache.delete(key);
        sid = await qbLogin(baseUrl, username, password, key);
        [torrentsRes, transferRes] = await fetchData(sid);
      } else {
        throw err;
      }
    }

    const torrents = ((torrentsRes.data ?? []) as Array<{ name: string; progress: number; state: string; dlspeed: number; upspeed: number; category?: string }>)
      .slice(0, 8)
      .map((t) => ({
        name: t.name,
        progress: Math.round((t.progress ?? 0) * 100),
        state: t.state,
        dlSpeed: t.dlspeed ?? 0,
        upSpeed: t.upspeed ?? 0,
        category: t.category ?? "",
      }));

    const transfer = (transferRes.data ?? {}) as { dl_info_speed?: number; up_info_speed?: number };

    // Pull the full category catalog with the (now-valid) session. This is
    // best-effort: any failure or empty/unexpected payload just yields an empty
    // list rather than breaking the torrents/transfer response.
    let categories: string[] = [];
    try {
      const categoriesRes = await fetchCategories(sid);
      const raw = categoriesRes.data;
      if (raw && typeof raw === "object") {
        categories = Object.keys(raw as Record<string, unknown>).sort((a, b) =>
          a.localeCompare(b),
        );
      }
    } catch (err) {
      logger.warn(
        { reason: normalizeHttpError(err) },
        "qBittorrent categories fetch failed; returning empty category catalog",
      );
    }

    res.json({
      torrents,
      downloadSpeed: transfer.dl_info_speed ?? 0,
      uploadSpeed: transfer.up_info_speed ?? 0,
      categories,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "qb-auth-failed") {
      logger.warn({ baseUrl }, "qBittorrent authentication failed (check saved username/password)");
      res.status(502).json({ error: "qBittorrent authentication failed" });
      return;
    }
    if (err instanceof Error && err.message === "qb-no-session") {
      logger.warn({ baseUrl }, "qBittorrent login returned no session cookie");
      res.status(502).json({ error: "qBittorrent did not return a session" });
      return;
    }
    logger.error({ reason: normalizeHttpError(err) }, "qBittorrent widget error");
    res.status(502).json({ error: "Failed to fetch qBittorrent data" });
  }
});

// ────────────────────────────────────────────────
// Pi-hole Widget
// ────────────────────────────────────────────────
// Auto-detects the Pi-hole API version: it tries the v6 REST API (session login
// at `/api/auth`, stats at `/api/...`) first and falls back to the legacy v5
// `admin/api.php` endpoint, so one saved connection works for both. See
// lib/pihole.ts for the detection + mapping details.
router.get("/pihole", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "pihole", {
    url: process.env["PIHOLE_URL"],
    apiKey: process.env["PIHOLE_API_KEY"],
  });
  const baseUrl = normalizeBaseUrl(connection.url);
  const apiKey = connection.apiKey;

  // Unconfigured (no base URL): report not-configured so the tile shows its
  // placeholder rather than stale/sample numbers.
  if (!baseUrl) {
    res.status(503).json({ error: "Pi-hole is not configured" });
    return;
  }

  try {
    const data = await fetchPiholeData(baseUrl, apiKey);
    res.json(data);
  } catch (err) {
    const message = normalizeHttpError(err);
    logger.warn({ baseUrl, reason: message }, "Pi-hole widget error");
    res.status(502).json({ error: message });
  }
});

// ────────────────────────────────────────────────
// Nginx Proxy Manager Widget
// ────────────────────────────────────────────────
// NPM's v2 API is token-based: POST /api/tokens with {identity, secret} returns
// a short-lived bearer token (default ~1h). The tile polls every 60s, so cache
// the token per connection (keyed by baseUrl + email) and reuse it until it is
// near expiry, re-authenticating only when it has lapsed or is rejected (401).
interface NpmToken {
  token: string;
  // Epoch ms after which the cached token should be considered stale.
  expiresAt: number;
}

const npmTokenCache = new Map<string, NpmToken>();

function npmCacheKey(
  userId: number,
  baseUrl: string,
  email: string,
  password: string,
): string {
  return [
    userId,
    normalizeBaseUrl(baseUrl),
    email,
    credentialFingerprint(password),
  ].join("\u0000");
}

// Authenticate against NPM, cache the resulting token with its expiry, and
// return it. Throws a tagged error when credentials are rejected.
async function npmLogin(
  baseUrl: string,
  email: string,
  password: string,
  key: string,
): Promise<string> {
  const r = await httpClient.post(
    `${baseUrl}/api/tokens`,
    { identity: email, secret: password },
    { headers: { "Content-Type": "application/json" } },
  );
  const body = (r.data ?? {}) as { token?: string; expires?: string };
  if (!body.token) {
    throw new Error("npm-auth-failed");
  }

  // NPM returns an ISO `expires` timestamp; fall back to a 1h lifetime and
  // refresh 60s early so a request never rides an about-to-expire token.
  const parsed = body.expires ? new Date(body.expires).getTime() : NaN;
  const expiresAt = (Number.isNaN(parsed) ? Date.now() + 3600_000 : parsed) - 60_000;
  npmTokenCache.set(key, { token: body.token, expiresAt });
  return body.token;
}

// Return a valid cached token when one is present and unexpired; otherwise log
// in fresh.
async function npmGetToken(
  baseUrl: string,
  email: string,
  password: string,
  key: string,
): Promise<string> {
  const cached = npmTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  return npmLogin(baseUrl, email, password, key);
}

function isUnauthorized(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 401 || status === 403;
}

router.get("/nginx-proxy-manager", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "nginx-proxy-manager", {
    url: process.env["NPM_URL"],
    username: process.env["NPM_EMAIL"],
    password: process.env["NPM_PASSWORD"],
  });
  const baseUrl = normalizeBaseUrl(connection.url);
  // The NPM connection stores the login email in the `username` field.
  const email = connection.username?.trim();
  const password = connection.password;

  if (!baseUrl || !email || password == null) {
    // Realistic sample data so the tile/layout can be previewed unconfigured.
    res.json({
      total: 5,
      enabled: 4,
      offline: 1,
      deadHostsCount: 2,
      expiringCertsCount: 1,
      proxyHosts: [
        { id: 1, domainNames: ["jellyfin.example.com"], enabled: true, online: true, ssl: true, sslExpiring: false },
        { id: 2, domainNames: ["nextcloud.example.com"], enabled: true, online: true, ssl: true, sslExpiring: true },
        { id: 3, domainNames: ["grafana.example.com"], enabled: true, online: false, ssl: true, sslExpiring: false },
        { id: 4, domainNames: ["home.example.com"], enabled: true, online: true, ssl: false, sslExpiring: false },
      ],
    });
    return;
  }

  // Fetch proxy hosts (with their certificate expanded for SSL expiry) and the
  // 404/dead hosts in parallel. Lets 401s propagate so the caller can decide to
  // re-authenticate.
  const fetchData = (token: string) =>
    Promise.all([
      httpClient.get(`${baseUrl}/api/nginx/proxy-hosts`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { expand: "certificate" },
      }),
      httpClient.get(`${baseUrl}/api/nginx/dead-hosts`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

  const key = npmCacheKey(req.user!.userId, baseUrl, email, password);

  try {
    let token = await npmGetToken(baseUrl, email, password, key);

    let proxyRes;
    let deadRes;
    try {
      [proxyRes, deadRes] = await fetchData(token);
    } catch (err) {
      // A cached token can lapse server-side; on a 401/403 drop it, log in once
      // more, and retry the data fetch a single time.
      if (isUnauthorized(err)) {
        npmTokenCache.delete(key);
        token = await npmLogin(baseUrl, email, password, key);
        [proxyRes, deadRes] = await fetchData(token);
      } else {
        throw err;
      }
    }

    // A cert counts as a warning if it is expired or expires within 30 days.
    const EXPIRY_WINDOW_MS = 30 * 86400000;
    const now = Date.now();
    let expiringCertsCount = 0;

    const rawHosts = (proxyRes.data ?? []) as Array<{
      id: number;
      domain_names?: string[];
      enabled?: boolean | number;
      certificate_id?: number;
      certificate?: { expires_on?: string } | null;
      meta?: { nginx_online?: boolean };
    }>;

    const proxyHosts = rawHosts.map((h) => {
      const enabled = Boolean(h.enabled);
      // NPM records reachability in meta.nginx_online; treat a missing value as
      // online so hosts that have never been polled don't read as down.
      const online = h.meta?.nginx_online !== false;
      const ssl = Boolean(h.certificate_id);
      let sslExpiring = false;
      const expiresOn = h.certificate?.expires_on;
      if (ssl && expiresOn) {
        const exp = new Date(expiresOn).getTime();
        if (!Number.isNaN(exp) && exp - now < EXPIRY_WINDOW_MS) {
          sslExpiring = true;
          expiringCertsCount++;
        }
      }
      return {
        id: h.id,
        domainNames: h.domain_names ?? [],
        enabled,
        online,
        ssl,
        sslExpiring,
      };
    });

    const enabledHosts = proxyHosts.filter((h) => h.enabled);
    const offline = enabledHosts.filter((h) => !h.online).length;
    const deadHostsCount = ((deadRes.data ?? []) as unknown[]).length;

    res.json({
      total: proxyHosts.length,
      enabled: enabledHosts.length,
      offline,
      deadHostsCount,
      expiringCertsCount,
      proxyHosts,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "npm-auth-failed") {
      logger.warn({ baseUrl }, "Nginx Proxy Manager authentication failed (check saved email/password)");
      res.status(502).json({ error: "Nginx Proxy Manager authentication failed" });
      return;
    }
    logger.error({ reason: normalizeHttpError(err) }, "Nginx Proxy Manager widget error");
    res.status(502).json({ error: "Failed to fetch Nginx Proxy Manager data" });
  }
});

// ────────────────────────────────────────────────
// Prowlarr Widget
// ────────────────────────────────────────────────
// Prowlarr exposes its v1 API behind an X-Api-Key header. The tile wants three
// things: a per-indexer status list, a recent grab count, and the health
// warnings Prowlarr is currently reporting. We derive per-indexer "failing"
// state from the health feed: Prowlarr surfaces unreachable indexers as a
// health issue whose message names the affected indexers, so an enabled indexer
// counts as failing when its name appears in any health message.
router.get("/prowlarr", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "prowlarr", {
    url: process.env["PROWLARR_URL"],
    apiKey: process.env["PROWLARR_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;

  if (!baseUrl || !apiKey) {
    // Sample data only when the service is genuinely unconfigured.
    res.json({
      indexers: [
        { id: 1, name: "1337x", enabled: true, status: "ok" },
        { id: 2, name: "The Pirate Bay", enabled: true, status: "ok" },
        { id: 3, name: "Nyaa", enabled: true, status: "failing" },
        { id: 4, name: "RARBG", enabled: false, status: "ok" },
        { id: 5, name: "TorrentGalaxy", enabled: true, status: "ok" },
      ],
      grabCount24h: 7,
      healthIssues: [
        {
          source: "IndexerStatusCheck",
          type: "warning",
          message: "Indexers unavailable due to failures: Nyaa",
        },
      ],
    });
    return;
  }

  try {
    const headers = { "X-Api-Key": apiKey };

    const [indexerRes, historyRes, healthRes] = await Promise.all([
      httpClient.get(`${baseUrl}/api/v1/indexer`, { headers }),
      // eventType=1 is "releaseGrabbed"; the paged response carries rows under
      // `records` sorted newest-first, so a single page of 100 covers the most
      // recent grabs we need to count for the last 24h.
      httpClient.get(`${baseUrl}/api/v1/history`, {
        headers,
        params: { pageSize: 100, eventType: 1 },
      }),
      httpClient.get(`${baseUrl}/api/v1/health`, { headers }),
    ]);

    const healthIssues = ((healthRes.data ?? []) as Array<{
      source?: string;
      type?: string;
      message?: string;
    }>).map((h) => ({
      source: h.source ?? "",
      type: h.type ?? "",
      message: h.message ?? "",
    }));

    // Concatenate every health message once so we can cheaply test whether an
    // indexer's name is referenced as failing.
    const healthText = healthIssues.map((h) => h.message).join(" \u0000 ");

    const indexers = ((indexerRes.data ?? []) as Array<{
      id: number;
      name: string;
      enable?: boolean;
    }>).map((ix) => {
      const enabled = Boolean(ix.enable);
      // Only enabled indexers can be "failing"; a disabled one is intentionally
      // off and renders grey via the enabled flag.
      const failing = enabled && ix.name.length > 0 && healthText.includes(ix.name);
      return {
        id: ix.id,
        name: ix.name,
        enabled,
        status: failing ? "failing" : "ok",
      };
    });

    // Count grabs within the last 24h. Each history record carries a `date`
    // (ISO) timestamp; rows beyond the window (or without a parseable date) are
    // ignored.
    const cutoff = Date.now() - 24 * 3600_000;
    const records = (historyRes.data?.records ?? []) as Array<{ date?: string }>;
    const grabCount24h = records.filter((r) => {
      if (!r.date) return false;
      const t = new Date(r.date).getTime();
      return !Number.isNaN(t) && t >= cutoff;
    }).length;

    res.json({ indexers, grabCount24h, healthIssues });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Prowlarr widget error");
    res.status(502).json({ error: "Failed to fetch Prowlarr data" });
  }
});

// ────────────────────────────────────────────────
// Pterodactyl Widget
// ────────────────────────────────────────────────
// Pterodactyl's client API (Bearer client API key) lists the account's game
// servers; each server's live power state and resource usage comes from the
// per-server /resources endpoint. Resource calls are additive: a failing one
// leaves that server row with state "unknown" and null stats instead of
// failing the whole tile, since the list call already proved the panel is up.
// The subset of a Pterodactyl client-API server object the widget reads.
interface PteroServerAttrs {
  identifier?: string;
  name?: string;
  limits?: { memory?: number | null };
  invocation?: string | null;
  docker_image?: string | null;
  sftp_details?: { ip?: string | null };
  relationships?: {
    allocations?: {
      data?: Array<{
        attributes?: {
          ip?: string | null;
          ip_alias?: string | null;
          port?: number | null;
          is_default?: boolean;
        };
      }>;
    };
  };
}

// Plan the best-effort player query for one server: guess the game from panel
// metadata, then list candidate host:port targets in preference order (alias
// hostname first, then the routable raw IP, then the node's SFTP host — the
// panel API itself has no player information). For Minecraft the standard
// server port (25565) is also tried as a fallback, since panels often proxy
// the public address on the default port while allocating a different one.
// Returns a structured reason instead of candidates when planning fails.
function planPterodactylPlayerQuery(s: PteroServerAttrs):
  | { game: string; candidates: Array<{ host: string; port: number }>; reason: null }
  | { game: string | null; candidates: []; reason: "unknown-game" | "no-allocation" } {
  const game = guessGameType(`${s.name ?? ""} ${s.invocation ?? ""} ${s.docker_image ?? ""}`);
  if (!game) return { game: null, candidates: [], reason: "unknown-game" };

  const allocations = s.relationships?.allocations?.data ?? [];
  const def =
    allocations.find((a) => a.attributes?.is_default)?.attributes ??
    allocations[0]?.attributes;
  if (!def || typeof def.port !== "number") {
    return { game: game.type, candidates: [], reason: "no-allocation" };
  }
  const rawIp = def.ip ?? "";
  const routableIp = rawIp && !/^(0\.0\.0\.0|127\.|::)/.test(rawIp) ? rawIp : null;
  // Distinct hosts in preference order; try the next when the first fails.
  const hosts = [...new Set([def.ip_alias, routableIp, s.sftp_details?.ip].filter(
    (h): h is string => Boolean(h),
  ))];
  if (hosts.length === 0) return { game: game.type, candidates: [], reason: "no-allocation" };

  const port = def.port + game.portOffset;
  const candidates = hosts.map((host) => ({ host, port }));
  if (game.type === "minecraft" && port !== 25565) {
    // Standard Minecraft port as a last resort — one extra attempt on the
    // preferred host only, to bound total query time.
    candidates.push({ host: hosts[0]!, port: 25565 });
  }
  return { game: game.type, candidates, reason: null };
}

// Run the planned query attempts in order until one succeeds. Additive: never
// throws; failure yields the reason from the LAST attempt (with all attempt
// details for logging/diagnostics).
async function runPterodactylPlayerQuery(
  game: string,
  candidates: Array<{ host: string; port: number }>,
): Promise<{
  players: PlayerCount | null;
  reason: "timeout" | "unreachable" | null;
  attempts: Array<{ host: string; port: number; outcome: string }>;
}> {
  const attempts: Array<{ host: string; port: number; outcome: string }> = [];
  let lastReason: "timeout" | "unreachable" = "timeout";
  for (const c of candidates) {
    const r = await queryGamePlayersDetailed(game, c.host, c.port);
    if (r.players) {
      attempts.push({ host: c.host, port: c.port, outcome: "ok" });
      return { players: r.players, reason: null, attempts };
    }
    lastReason = r.reason;
    attempts.push({ host: c.host, port: c.port, outcome: `${r.reason}: ${r.detail}` });
  }
  return { players: null, reason: lastReason, attempts };
}

router.get("/pterodactyl", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "pterodactyl", {
    url: process.env["PTERODACTYL_URL"],
    apiKey: process.env["PTERODACTYL_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;

  if (!baseUrl || !apiKey) {
    // Sample data only when the service is genuinely unconfigured.
    res.json({
      servers: [
        { id: "a1b2c3d4", name: "Minecraft SMP", state: "running", cpuPercent: 42.5, memUsedMb: 3072, memLimitMb: 8192, players: { current: 3, max: 20 }, playersUnavailableReason: null },
        { id: "e5f6a7b8", name: "Valheim", state: "running", cpuPercent: 18.2, memUsedMb: 2048, memLimitMb: 4096, players: { current: 0, max: 10 }, playersUnavailableReason: null },
        { id: "c9d0e1f2", name: "Terraria", state: "starting", cpuPercent: 5.1, memUsedMb: 256, memLimitMb: 2048, players: null, playersUnavailableReason: null },
        { id: "b3c4d5e6", name: "Ark Survival", state: "offline", cpuPercent: 0, memUsedMb: 0, memLimitMb: 16384, players: null, playersUnavailableReason: null },
      ],
    });
    return;
  }

  try {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

    const listRes = await httpClient.get(`${baseUrl}/api/client`, {
      headers,
      // One page of 100 covers realistic homelab panels without paginating.
      params: { per_page: 100 },
    });

    const rawServers = ((listRes.data?.data ?? []) as Array<{ attributes?: PteroServerAttrs }>)
      .map((s) => s.attributes)
      .filter((a): a is NonNullable<typeof a> => Boolean(a?.identifier));

    const servers = await Promise.all(
      rawServers.map(async (s) => {
        const id = s.identifier!;
        // memory limit is configured in MiB; 0 means "unlimited" in the panel.
        const limit = s.limits?.memory;
        const memLimitMb = typeof limit === "number" && limit > 0 ? limit : null;
        try {
          const r = await httpClient.get(
            `${baseUrl}/api/client/servers/${encodeURIComponent(id)}/resources`,
            { headers },
          );
          const attrs = (r.data?.attributes ?? {}) as {
            current_state?: string;
            resources?: { memory_bytes?: number; cpu_absolute?: number };
          };
          const known = ["running", "starting", "stopping", "offline"];
          const state = known.includes(attrs.current_state ?? "")
            ? (attrs.current_state as string)
            : "unknown";
          const cpu = attrs.resources?.cpu_absolute;
          const memBytes = attrs.resources?.memory_bytes;

          // Player occupancy only makes sense for a running server; the game
          // query itself is additive and never fails the row — instead the
          // failure REASON is surfaced so the tile can explain the gap.
          let players: PlayerCount | null = null;
          let playersUnavailableReason:
            | "unknown-game"
            | "no-allocation"
            | "timeout"
            | "unreachable"
            | null = null;
          if (state === "running") {
            const plan = planPterodactylPlayerQuery(s);
            if (plan.reason) {
              playersUnavailableReason = plan.reason;
              logger.warn(
                { id, name: s.name, reason: plan.reason, game: plan.game },
                "Pterodactyl player query skipped",
              );
            } else {
              const result = await runPterodactylPlayerQuery(plan.game, plan.candidates);
              players = result.players;
              if (!players) {
                playersUnavailableReason = result.reason;
                logger.warn(
                  { id, name: s.name, game: plan.game, reason: result.reason, attempts: result.attempts },
                  "Pterodactyl player query failed",
                );
              }
            }
          }

          return {
            id,
            name: s.name ?? id,
            state,
            cpuPercent: typeof cpu === "number" ? Math.round(cpu * 10) / 10 : null,
            memUsedMb:
              typeof memBytes === "number" ? Math.round(memBytes / (1024 * 1024)) : null,
            memLimitMb,
            players,
            playersUnavailableReason,
          };
        } catch (err) {
          // Additive: keep the row so the tile still lists the server.
          logger.warn(
            { id, reason: normalizeHttpError(err) },
            "Pterodactyl per-server resources fetch failed",
          );
          return { id, name: s.name ?? id, state: "unknown", cpuPercent: null, memUsedMb: null, memLimitMb, players: null, playersUnavailableReason: null };
        }
      }),
    );

    res.json({ servers });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Pterodactyl widget error");
    res.status(502).json({ error: "Failed to fetch Pterodactyl data" });
  }
});

// Send a power signal (start/stop/restart) to one server on the panel. The
// panel replies 204 on success. When no connection is configured the tile is
// showing sample data, so the action is acknowledged as a demo no-op instead
// of failing — the buttons stay usable in demo mode without side effects.
router.post("/pterodactyl/power", requireAuth, async (req: AuthRequest, res) => {
  const { serverId, signal } = (req.body ?? {}) as { serverId?: unknown; signal?: unknown };
  if (typeof serverId !== "string" || serverId.trim() === "") {
    res.status(400).json({ error: "serverId is required" });
    return;
  }
  if (signal !== "start" && signal !== "stop" && signal !== "restart") {
    res.status(400).json({ error: "signal must be start, stop, or restart" });
    return;
  }

  const connection = savedOrEnvironmentConnection(req.user!.userId, "pterodactyl", {
    url: process.env["PTERODACTYL_URL"],
    apiKey: process.env["PTERODACTYL_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;
  if (!baseUrl || !apiKey) {
    res.json({ ok: true, demo: true });
    return;
  }

  try {
    await httpClient.post(
      `${baseUrl}/api/client/servers/${encodeURIComponent(serverId)}/power`,
      { signal },
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    );
    res.json({ ok: true, demo: false });
  } catch (err) {
    logger.error(
      { serverId, signal, reason: describeHttpError(err) },
      "Pterodactyl power signal failed",
    );
    res.status(502).json({ error: `Failed to ${signal} the server` });
  }
});

// Read-only diagnostic for the player-count pipeline (mirrors the TrueNAS
// diagnostics pattern). For every server it reports the metadata hints the
// game guess reads, the guessed game type, the candidate query targets, and a
// LIVE query attempt per candidate with its outcome — so a missing player
// count can be pinpointed (unrecognized game, no allocation, unreachable
// host, closed query port) without reading server logs. Never echoes the key.
router.get("/pterodactyl/diagnostics", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "pterodactyl", {
    url: process.env["PTERODACTYL_URL"],
    apiKey: process.env["PTERODACTYL_API_KEY"],
  });
  const { url: baseUrl, apiKey } = connection;

  if (!baseUrl || !apiKey) {
    // No sample data — diagnosing an unconfigured service is meaningless.
    res.status(409).json({
      configured: false,
      message:
        "Pterodactyl is not configured. Save a panel URL and client API key first, then run this diagnostic from a box that can reach the game servers.",
    });
    return;
  }

  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  try {
    const listRes = await httpClient.get(`${baseUrl}/api/client`, {
      headers,
      params: { per_page: 100 },
    });
    const rawServers = ((listRes.data?.data ?? []) as Array<{ attributes?: PteroServerAttrs }>)
      .map((s) => s.attributes)
      .filter((a): a is NonNullable<typeof a> => Boolean(a?.identifier));

    const servers = await Promise.all(
      rawServers.map(async (s) => {
        const id = s.identifier!;
        // Power state matters: a stopped server legitimately has no players.
        let state = "unknown";
        try {
          const r = await httpClient.get(
            `${baseUrl}/api/client/servers/${encodeURIComponent(id)}/resources`,
            { headers },
          );
          state = (r.data?.attributes?.current_state as string) ?? "unknown";
        } catch {
          // state stays "unknown" — the row still diagnoses the query plan.
        }

        const hints = {
          name: s.name ?? null,
          invocation: s.invocation ?? null,
          dockerImage: s.docker_image ?? null,
          allocations: (s.relationships?.allocations?.data ?? []).map((a) => ({
            ip: a.attributes?.ip ?? null,
            ipAlias: a.attributes?.ip_alias ?? null,
            port: a.attributes?.port ?? null,
            isDefault: a.attributes?.is_default ?? false,
          })),
          sftpHost: s.sftp_details?.ip ?? null,
        };

        const plan = planPterodactylPlayerQuery(s);
        if (plan.reason) {
          return {
            id,
            name: s.name ?? id,
            state,
            hints,
            guessedGame: plan.game,
            candidates: [],
            outcome: { players: null, reason: plan.reason },
          };
        }

        const result = await runPterodactylPlayerQuery(plan.game, plan.candidates);
        return {
          id,
          name: s.name ?? id,
          state,
          hints,
          guessedGame: plan.game,
          candidates: plan.candidates,
          outcome: {
            players: result.players,
            reason: result.reason,
            attempts: result.attempts,
          },
        };
      }),
    );

    res.json({ configured: true, panel: baseUrl, servers });
  } catch (err) {
    // Even the diagnostic reports the panel failure as data, not a 5xx — the
    // whole point is to surface WHY things fail.
    res.status(200).json({
      configured: true,
      panel: baseUrl,
      servers: [],
      panelError: describeHttpError(err),
    });
  }
});

// ────────────────────────────────────────────────
// Tailscale Widget
// ────────────────────────────────────────────────
// Unlike the LAN services, Tailscale data comes from its cloud API
// (api.tailscale.com), authed with an API access token. We reuse the saved
// connection's `url` field for the tailnet name and `apiKey` for the token.
// A device counts as "online" when it was last seen within this window — the
// devices endpoint has no direct online flag, so this is the standard heuristic.
const TAILSCALE_ONLINE_WINDOW_MS = 5 * 60 * 1000;

// A device's node key is flagged as "expiring soon" when it will lapse within
// this window (or has already lapsed). Tailscale node keys expire unless key
// expiry is disabled; a lapsed key silently drops the device off the tailnet.
const TAILSCALE_KEY_EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;

// A device is an approved exit node when its enabled routes include the default
// route in either address family. (advertisedRoutes are merely offered; the
// enabled ones are what the tailnet admin has actually approved.)
function isExitNode(routes: string[] | undefined): boolean {
  if (!Array.isArray(routes)) return false;
  return routes.includes("0.0.0.0/0") || routes.includes("::/0");
}

// Resolve a device's key-expiry state from the raw `expires`/`keyExpiryDisabled`
// fields. Tailscale uses the sentinel "0001-01-01T00:00:00Z" (which parses to a
// non-positive epoch) when a device has no expiry, so we treat any non-positive
// timestamp as "no expiry". `expiringSoon` is true when a real expiry falls
// inside the warning window — including keys that have already lapsed, since
// those still need the user's attention.
function keyExpiryStatus(
  expires: string | undefined,
  keyExpiryDisabled: boolean | undefined,
  nowMs: number,
): { expires: string | null; keyExpiryDisabled: boolean; keyExpiringSoon: boolean } {
  const disabled = keyExpiryDisabled === true;
  const expiresMs = expires ? new Date(expires).getTime() : NaN;
  const hasExpiry = !disabled && Number.isFinite(expiresMs) && expiresMs > 0;
  return {
    expires: hasExpiry ? new Date(expiresMs).toISOString() : null,
    keyExpiryDisabled: disabled,
    keyExpiringSoon: hasExpiry && expiresMs - nowMs <= TAILSCALE_KEY_EXPIRY_WARN_MS,
  };
}

router.get("/tailscale", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "tailscale", {
    url: process.env["TAILSCALE_TAILNET"],
    apiKey: process.env["TAILSCALE_API_KEY"],
  });
  const tailnet = connection.url;
  const apiKey = connection.apiKey;

  if (!tailnet || !apiKey) {
    // Sample data only when the service is genuinely unconfigured.
    const now = Date.now();
    res.json({
      tailnet: "example.ts.net",
      deviceCount: 4,
      onlineCount: 3,
      offlineCount: 1,
      exitNodeCount: 1,
      expiringSoonCount: 1,
      devices: [
        { id: "1", name: "homelab-nas", os: "linux", online: true, lastSeen: new Date(now).toISOString(), exitNode: true, addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"], expires: null, keyExpiryDisabled: true, keyExpiringSoon: false },
        { id: "2", name: "macbook-pro", os: "macOS", online: true, lastSeen: new Date(now - 60_000).toISOString(), exitNode: false, addresses: ["100.64.0.2", "fd7a:115c:a1e0::2"], expires: new Date(now + 3 * 86400_000).toISOString(), keyExpiryDisabled: false, keyExpiringSoon: true },
        { id: "3", name: "pixel-phone", os: "android", online: true, lastSeen: new Date(now - 120_000).toISOString(), exitNode: false, addresses: ["100.64.0.3", "fd7a:115c:a1e0::3"], expires: new Date(now + 90 * 86400_000).toISOString(), keyExpiryDisabled: false, keyExpiringSoon: false },
        { id: "4", name: "old-laptop", os: "windows", online: false, lastSeen: new Date(now - 3 * 86400_000).toISOString(), exitNode: false, addresses: ["100.64.0.4", "fd7a:115c:a1e0::4"], expires: new Date(now + 45 * 86400_000).toISOString(), keyExpiryDisabled: false, keyExpiringSoon: false },
      ],
    });
    return;
  }

  try {
    // `fields=all` so each device carries enabledRoutes (for exit-node detection)
    // and lastSeen (for the online heuristic). Uses the secure (TLS-verifying)
    // client since this is a public cloud API carrying a bearer token.
    const r = await cloudHttpClient.get(
      `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/devices`,
      { headers: { Authorization: `Bearer ${apiKey}` }, params: { fields: "all" } },
    );

    const now = Date.now();
    const rawDevices = (r.data?.devices ?? []) as Array<{
      id?: string;
      nodeId?: string;
      name?: string;
      hostname?: string;
      os?: string;
      lastSeen?: string;
      enabledRoutes?: string[];
      advertisedRoutes?: string[];
      addresses?: string[];
      expires?: string;
      keyExpiryDisabled?: boolean;
    }>;

    const devices = rawDevices.map((d, i) => {
      const lastSeenMs = d.lastSeen ? new Date(d.lastSeen).getTime() : NaN;
      const online = !Number.isNaN(lastSeenMs) && now - lastSeenMs <= TAILSCALE_ONLINE_WINDOW_MS;
      // Prefer the short hostname; fall back to the first label of the full DNS
      // name, then the raw name.
      const fullName = d.name ?? "";
      const name = d.hostname?.trim() || fullName.split(".")[0] || fullName || `device-${i + 1}`;
      const exitNode = isExitNode(d.enabledRoutes);
      const keyExpiry = keyExpiryStatus(d.expires, d.keyExpiryDisabled, now);
      return {
        id: d.id ?? d.nodeId ?? String(i + 1),
        name,
        os: d.os ?? "unknown",
        online,
        lastSeen: !Number.isNaN(lastSeenMs) ? new Date(lastSeenMs).toISOString() : null,
        exitNode,
        addresses: Array.isArray(d.addresses) ? d.addresses : [],
        ...keyExpiry,
      };
    });

    const onlineCount = devices.filter((d) => d.online).length;
    const exitNodeCount = devices.filter((d) => d.exitNode && d.online).length;
    const expiringSoonCount = devices.filter((d) => d.keyExpiringSoon).length;

    res.json({
      tailnet,
      deviceCount: devices.length,
      onlineCount,
      offlineCount: devices.length - onlineCount,
      exitNodeCount,
      expiringSoonCount,
      devices,
    });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Tailscale widget error");
    res.status(502).json({ error: "Failed to fetch Tailscale data" });
  }
});

// ────────────────────────────────────────────────
// ErsatzTV Widget
// ────────────────────────────────────────────────
// ErsatzTV is a homelab live/linear TV server that runs without auth here, so
// every call needs only the base URL. It publishes its channel list as an M3U
// playlist (/iptv/channels.m3u) and its guide as XMLTV (/iptv/xmltv.xml). We
// derive the channel list (number + name) from the M3U and each channel's
// "now playing" by matching the currently-airing programme (start ≤ now < stop)
// from the XMLTV guide, keyed by the M3U tvg-id ↔ XMLTV channel id.

interface ErsatzChannel {
  number: string;
  name: string;
  tvgId: string;
}

// Decode the XML/HTML entities that appear in ErsatzTV's M3U and XMLTV feeds.
// Handles the five named entities plus numeric character references in both
// decimal (`&#39;`) and hex (`&#x27;`) forms so titles like "Limmy's Show!"
// render correctly instead of showing the raw `&#39;`. The numeric pass runs
// first so a literal "&amp;#39;" still resolves to "&" rather than "'".
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Parse the channel rows out of an ErsatzTV M3U playlist. Each channel is a
// `#EXTINF:` line carrying tvg-* attributes followed by the stream URL; we only
// need the attributes (number, name, id) for the tile.
function parseM3uChannels(m3u: string): ErsatzChannel[] {
  const channels: ErsatzChannel[] = [];
  const lines = m3u.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("#EXTINF")) continue;
    const attr = (name: string): string => {
      const m = line.match(new RegExp(`${name}="([^"]*)"`));
      return m?.[1]?.trim() ?? "";
    };
    const tvgId = attr("tvg-id");
    const number = attr("tvg-chno") || tvgId;
    // The display name is the text after the trailing comma; fall back to
    // tvg-name when the comma form is absent.
    const commaName = line.slice(line.indexOf(",") + 1).trim();
    const name = decodeXmlEntities(commaName || attr("tvg-name") || number);
    if (!number && !name) continue;
    channels.push({ number, name, tvgId });
  }
  return channels;
}

// Parse an XMLTV timestamp like "20260616120000 +0000" (offset optional) into
// epoch ms. Returns NaN when unparseable so callers can skip the programme.
function parseXmltvTime(value: string): number {
  const m = value
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, off] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${
    off ? `${off.slice(0, 3)}:${off.slice(3)}` : "Z"
  }`;
  return new Date(iso).getTime();
}

// Per-channel guide info parsed from an XMLTV document: what's airing right
// now plus the next upcoming programme (title + ISO start time), plus the
// full schedule window (current + upcoming programmes for the next few
// hours) for the guide grid.
interface ErsatzGuideProgram {
  title: string;
  start: number;
  stop: number;
}

interface ErsatzGuideEntry {
  nowPlaying?: string;
  nowPlayingStart?: number;
  nowPlayingStop?: number;
  upNextTitle?: string;
  upNextStart?: number;
  programs?: ErsatzGuideProgram[];
}

// How far ahead the guide grid schedule extends. Programmes starting beyond
// this horizon are dropped to keep payloads small.
const ERSATZ_GUIDE_HORIZON_MS = 3 * 60 * 60_000;

// Build a map of channelId → guide entry from an XMLTV document. A programme
// is "now playing" when start ≤ now < stop; "up next" is the future programme
// with the earliest start time (programmes need not be ordered in the feed).
// Every programme overlapping [now, now + horizon) is also collected into
// `programs` (sorted by start) so the guide grid can lay out a timeline.
function parseXmltvGuide(xml: string, nowMs: number): Map<string, ErsatzGuideEntry> {
  const guide = new Map<string, ErsatzGuideEntry>();
  const programmeRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let match: RegExpExecArray | null;
  while ((match = programmeRe.exec(xml)) !== null) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const channel = attrs.match(/channel="([^"]*)"/)?.[1]?.trim();
    const startRaw = attrs.match(/start="([^"]*)"/)?.[1];
    const stopRaw = attrs.match(/stop="([^"]*)"/)?.[1];
    if (!channel || !startRaw || !stopRaw) continue;
    const start = parseXmltvTime(startRaw);
    const stop = parseXmltvTime(stopRaw);
    if (Number.isNaN(start) || Number.isNaN(stop)) continue;
    const rawTitle = body
      .match(/<title\b[^>]*>([\s\S]*?)<\/title>/)?.[1]
      ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1");
    const title = rawTitle ? decodeXmlEntities(rawTitle).trim() : undefined;
    if (!title) continue;
    const entry = guide.get(channel) ?? {};
    if (nowMs >= start && nowMs < stop) {
      if (entry.nowPlaying === undefined) {
        entry.nowPlaying = title;
        entry.nowPlayingStart = start;
        entry.nowPlayingStop = stop;
      }
    } else if (start > nowMs) {
      if (entry.upNextStart === undefined || start < entry.upNextStart) {
        entry.upNextTitle = title;
        entry.upNextStart = start;
      }
    }
    // Collect the schedule window for the guide grid: anything overlapping
    // [now, now + horizon). The feed need not be ordered, so sort below.
    if (stop > nowMs && start < nowMs + ERSATZ_GUIDE_HORIZON_MS) {
      (entry.programs ??= []).push({ title, start, stop });
    }
    guide.set(channel, entry);
  }
  for (const entry of guide.values()) {
    entry.programs?.sort((a, b) => a.start - b.start);
  }
  return guide;
}

// Serialize a guide entry's schedule window as ISO strings for the API.
function serializeErsatzPrograms(
  entry: ErsatzGuideEntry | undefined,
): { title: string; start: string; stop: string }[] {
  return (entry?.programs ?? []).map((p) => ({
    title: p.title,
    start: new Date(p.start).toISOString(),
    stop: new Date(p.stop).toISOString(),
  }));
}

// Demo schedule for the sample lineup: back-to-back blocks so the guide grid
// looks real without an ErsatzTV connection.
function sampleErsatzPrograms(
  startOffsetMin: number,
  titles: string[],
  blockMin: number,
): { title: string; start: string; stop: string }[] {
  const now = Date.now();
  let cursor = now + startOffsetMin * 60_000;
  return titles.map((title) => {
    const start = cursor;
    cursor += blockMin * 60_000;
    return {
      title,
      start: new Date(start).toISOString(),
      stop: new Date(cursor).toISOString(),
    };
  });
}

// Fetch the live active-stream count from ErsatzTV's /api/sessions endpoint,
// which returns a JSON array with one entry per active transcode session
// (MPEG-TS and HLS Segmenter). Returns the array length, or null when the
// endpoint is unavailable (older instance, network error, or unexpected shape)
// so the tile omits the metric instead of failing.
async function fetchErsatzActiveStreams(base: string): Promise<number | null> {
  try {
    const res = await httpClient.get(`${base}/api/sessions`, { responseType: "json" });
    const data = res.data;
    if (Array.isArray(data)) return data.length;
    return null;
  } catch (err) {
    logger.warn(
      { reason: normalizeHttpError(err) },
      "ErsatzTV active-stream count unavailable",
    );
    return null;
  }
}

router.get("/ersatztv", requireAuth, async (req: AuthRequest, res) => {
  const connection = savedOrEnvironmentConnection(req.user!.userId, "ersatztv", {
    url: process.env["ERSATZTV_URL"],
  });
  const baseUrl = connection.url;

  if (!baseUrl) {
    // Sample data only when the service is genuinely unconfigured.
    res.json({
      reachable: true,
      activeStreams: 2,
      channels: [
        { number: "1", name: "Movies 24/7", nowPlaying: "The Maltese Falcon", upNextTitle: "Casablanca", upNextStart: new Date(Date.now() + 45 * 60_000).toISOString() },
        { number: "2", name: "Retro Cartoons", nowPlaying: "Looney Tunes", upNextTitle: "Tom and Jerry", upNextStart: new Date(Date.now() + 20 * 60_000).toISOString() },
        { number: "3", name: "Nature Documentaries", nowPlaying: "Planet Earth: Jungles", upNextTitle: "Blue Planet: Coasts", upNextStart: new Date(Date.now() + 30 * 60_000).toISOString() },
        { number: "4", name: "Sci-Fi Marathon", nowPlaying: "Blade Runner", upNextTitle: "The Matrix", upNextStart: new Date(Date.now() + 70 * 60_000).toISOString() },
        { number: "5", name: "News Loop", nowPlaying: null, upNextTitle: null, upNextStart: null },
      ],
    });
    return;
  }

  try {
    const base = trimSlash(baseUrl);

    // Active streams come from ErsatzTV's /api/sessions endpoint, which returns
    // a JSON array (one entry per active MPEG-TS / HLS transcode session). It is
    // fetched alongside the M3U/XMLTV but with its own catch so a failure or an
    // older instance without the endpoint degrades to null (omit the metric)
    // rather than failing the whole tile.
    const [channelsRes, guideRes, activeStreams] = await Promise.all([
      httpClient.get(`${base}/iptv/channels.m3u`, { responseType: "text" }),
      httpClient.get(`${base}/iptv/xmltv.xml`, { responseType: "text" }),
      fetchErsatzActiveStreams(base),
    ]);

    const channelList = parseM3uChannels(String(channelsRes.data ?? ""));
    const guide = parseXmltvGuide(String(guideRes.data ?? ""), Date.now());

    const channels = channelList.map((c) => {
      // Match the guide by tvg-id, falling back to channel number (ErsatzTV
      // keys XMLTV channels by their number when no explicit id is set).
      const entry = guide.get(c.tvgId) ?? guide.get(c.number);
      return {
        number: c.number,
        name: c.name,
        nowPlaying: entry?.nowPlaying ?? null,
        upNextTitle: entry?.upNextTitle ?? null,
        upNextStart:
          entry?.upNextStart != null
            ? new Date(entry.upNextStart).toISOString()
            : null,
      };
    });

    res.json({ reachable: true, activeStreams, channels });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "ErsatzTV widget error");
    res.status(502).json({ error: "Failed to fetch ErsatzTV data" });
  }
});

// ── ErsatzTV live-TV playback (Video Player tile) ────────────────────────────
// The Video Player tile can tune ErsatzTV channels. Two extra routes back it:
//  - GET /ersatztv/channels: the channel lineup (number, name, now airing)
//    plus a per-channel stream URL. The stream URL points at the proxy below
//    rather than the ErsatzTV host directly, because the browser often can't
//    reach the LAN address the api-server uses.
//  - GET /ersatztv/stream/*: a transparent proxy for ErsatzTV's /iptv/ HLS
//    tree. Playlists (.m3u8) are rewritten so every URI they reference flows
//    back through this proxy; media segments stream through untouched.
// Convention holds: unconfigured → sample lineup (tile keeps its demo
// behavior); configured-but-failing → 502 (explicit error, no fallback).

// Path prefix (mounted under /api/widgets) the stream proxy lives at; baked
// into rewritten playlist URIs and the lineup's streamUrls.
const ERSATZ_STREAM_PREFIX = "/api/widgets/ersatztv/stream";

function resolveErsatzBase(userId: number): string | null {
  const connection = savedOrEnvironmentConnection(userId, "ersatztv", {
    url: process.env["ERSATZTV_URL"],
  });
  const baseUrl = connection.url;
  return baseUrl ? trimSlash(baseUrl) : null;
}

// Auth for the stream proxy. <video>/hls.js media requests can't reliably
// carry an Authorization header (native HLS playback sends plain GETs), so
// this accepts the JWT either as a Bearer header or as a ?token= query
// parameter. The token only ever travels to this server, never to ErsatzTV.
function ersatzStreamAuth(req: AuthRequest, res: import("express").Response, next: import("express").NextFunction): void {
  const header = req.headers.authorization;
  const raw = header?.startsWith("Bearer ")
    ? header.slice(7)
    : typeof req.query["token"] === "string"
      ? req.query["token"]
      : "";
  if (!raw) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    req.user = verifyToken(raw);
    runAsOutboundUser(req.user.userId, next);
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Rewrite an HLS playlist so every URI it references is served through the
// stream proxy (keeping the viewer's token on each rewritten URL). Handles
// plain URI lines and URI="..." attributes (#EXT-X-MEDIA, #EXT-X-KEY, …).
// URIs pointing at other hosts are left alone.
export function rewriteErsatzPlaylist(
  playlist: string,
  upstreamUrl: string,
  token: string,
): string {
  const upstreamOrigin = new URL(upstreamUrl).origin;
  const rewriteUri = (uri: string): string => {
    let resolved: URL;
    try {
      resolved = new URL(uri, upstreamUrl);
    } catch {
      return uri;
    }
    if (resolved.origin !== upstreamOrigin) return uri;
    resolved.searchParams.set("token", token);
    return `${ERSATZ_STREAM_PREFIX}${resolved.pathname}${resolved.search}`;
  };
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]*)"/g, (_, uri) => `URI="${rewriteUri(uri)}"`);
      }
      return rewriteUri(trimmed);
    })
    .join("\n");
}

// GET /api/widgets/ersatztv/channels — the tunable channel lineup for the
// Video Player tile, reusing the same M3U + XMLTV parsing as the monitoring
// widget above.
router.get("/ersatztv/channels", requireAuth, async (req: AuthRequest, res) => {
  const base = resolveErsatzBase(req.user!.userId);
  if (!base) {
    // Sample lineup only when ErsatzTV is genuinely unconfigured; the tile
    // keeps its demo (yule log) behavior and no stream URLs exist.
    res.json({
      sample: true,
      channels: [
        { number: "1", name: "Movies 24/7", nowPlaying: "The Maltese Falcon", nowPlayingStart: new Date(Date.now() - 55 * 60_000).toISOString(), nowPlayingStop: new Date(Date.now() + 45 * 60_000).toISOString(), upNextTitle: "Casablanca", upNextStart: new Date(Date.now() + 45 * 60_000).toISOString(), streamUrl: null, programs: sampleErsatzPrograms(-55, ["The Maltese Falcon", "Casablanca", "The Big Sleep"], 100) },
        { number: "2", name: "Retro Cartoons", nowPlaying: "Looney Tunes", nowPlayingStart: new Date(Date.now() - 10 * 60_000).toISOString(), nowPlayingStop: new Date(Date.now() + 20 * 60_000).toISOString(), upNextTitle: "Tom and Jerry", upNextStart: new Date(Date.now() + 20 * 60_000).toISOString(), streamUrl: null, programs: sampleErsatzPrograms(-10, ["Looney Tunes", "Tom and Jerry", "Popeye", "Betty Boop", "Woody Woodpecker", "Felix the Cat", "Mighty Mouse"], 30) },
        { number: "3", name: "Nature Documentaries", nowPlaying: "Planet Earth: Jungles", nowPlayingStart: new Date(Date.now() - 30 * 60_000).toISOString(), nowPlayingStop: new Date(Date.now() + 30 * 60_000).toISOString(), upNextTitle: "Blue Planet: Coasts", upNextStart: new Date(Date.now() + 30 * 60_000).toISOString(), streamUrl: null, programs: sampleErsatzPrograms(-30, ["Planet Earth: Jungles", "Blue Planet: Coasts", "Frozen Planet: Ice Worlds", "Life: Reptiles"], 60) },
      ],
    });
    return;
  }
  try {
    // The guide is additive: an XMLTV failure must not take down the channel
    // list (the tile can still tune without programme info), so it gets its
    // own catch that degrades to an empty guide with a warning.
    const [channelsRes, guide] = await Promise.all([
      httpClient.get(`${base}/iptv/channels.m3u`, { responseType: "text" }),
      httpClient
        .get(`${base}/iptv/xmltv.xml`, { responseType: "text" })
        .then((r) => parseXmltvGuide(String(r.data ?? ""), Date.now()))
        .catch((err: unknown) => {
          logger.warn(
            { reason: normalizeHttpError(err) },
            "ErsatzTV XMLTV guide unavailable; returning channels without guide data",
          );
          return new Map<string, ErsatzGuideEntry>();
        }),
    ]);
    const channelList = parseM3uChannels(String(channelsRes.data ?? ""));
    const channels = channelList.map((c) => {
      const entry = guide.get(c.tvgId) ?? guide.get(c.number);
      return {
        number: c.number,
        name: c.name,
        nowPlaying: entry?.nowPlaying ?? null,
        nowPlayingStart:
          entry?.nowPlayingStart != null
            ? new Date(entry.nowPlayingStart).toISOString()
            : null,
        nowPlayingStop:
          entry?.nowPlayingStop != null
            ? new Date(entry.nowPlayingStop).toISOString()
            : null,
        upNextTitle: entry?.upNextTitle ?? null,
        upNextStart:
          entry?.upNextStart != null
            ? new Date(entry.upNextStart).toISOString()
            : null,
        programs: serializeErsatzPrograms(entry),
        streamUrl: `${ERSATZ_STREAM_PREFIX}/iptv/channel/${encodeURIComponent(c.number)}.m3u8`,
      };
    });
    res.json({ sample: false, channels });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "ErsatzTV channel lineup error");
    res.status(502).json({ error: "Failed to fetch ErsatzTV channels" });
  }
});

// GET /api/widgets/ersatztv/stream/* — proxy one path of ErsatzTV's IPTV
// tree (playlists and media segments). Only /iptv/ paths are allowed so the
// proxy can't be used to reach arbitrary ErsatzTV endpoints.
router.get("/ersatztv/stream/*splat", ersatzStreamAuth, async (req: AuthRequest, res) => {
  const base = resolveErsatzBase(req.user!.userId);
  if (!base) {
    res.status(404).json({ error: "ErsatzTV is not configured" });
    return;
  }
  const splat = req.params["splat"];
  const path = (Array.isArray(splat) ? splat.join("/") : String(splat ?? "")).replace(/^\/+/, "");
  if (!path.startsWith("iptv/") || path.includes("..")) {
    res.status(400).json({ error: "Only ErsatzTV /iptv/ paths can be streamed" });
    return;
  }
  // Forward the upstream query string (minus our own token param).
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "token") continue;
    if (typeof value === "string") params.set(key, value);
  }
  const search = params.toString();
  const upstreamUrl = `${base}/${path}${search ? `?${search}` : ""}`;
  const token =
    typeof req.query["token"] === "string"
      ? req.query["token"]
      : (req.headers.authorization ?? "").slice(7);
  try {
    const upstream = await httpClient.get(upstreamUrl, {
      responseType: "arraybuffer",
      // Live segment fetches can be chunky; give them a bit more headroom
      // than the default widget timeout.
      timeout: 15000,
    });
    const contentType = String(upstream.headers?.["content-type"] ?? "");
    // The redirect-followed final URL (ErsatzTV redirects channel playlists
    // into per-session paths); relative segment URIs must resolve against it.
    const finalUrl: string =
      (upstream.request?.res?.responseUrl as string | undefined) || upstreamUrl;
    const isPlaylist =
      contentType.includes("mpegurl") || new URL(finalUrl).pathname.endsWith(".m3u8");
    if (isPlaylist) {
      const body = Buffer.from(upstream.data as ArrayBuffer).toString("utf8");
      res
        .status(200)
        .set("Content-Type", "application/vnd.apple.mpegurl")
        .set("Cache-Control", "no-store")
        .send(rewriteErsatzPlaylist(body, finalUrl, token));
      return;
    }
    res
      .status(200)
      .set("Content-Type", contentType || "video/mp2t")
      .set("Cache-Control", "no-store")
      .send(Buffer.from(upstream.data as ArrayBuffer));
  } catch (err) {
    logger.error(
      { reason: normalizeHttpError(err), path },
      "ErsatzTV stream proxy error",
    );
    res.status(502).json({ error: "Failed to stream from ErsatzTV" });
  }
});

// ────────────────────────────────────────────────
// Picture Frame (Photos) Widget
// ────────────────────────────────────────────────
// Two server-backed photo sources: a Google Photos album (via the linked
// Google account, Photos read-only scope) and an Immich album (via a saved
// per-user "immich" connection: base URL + API key). Both list albums and
// return a normalized photo list whose URLs are authenticated API proxy paths:
// Google baseUrls expire (~60 min) so bytes are re-resolved server-side per
// request, and Immich asset downloads need the API key which must never reach
// the browser. The tile fetches those proxy paths with its bearer token and
// renders object URLs. Convention: sample data only when the source is
// genuinely unconfigured; a configured source that fails → 502.

const GOOGLE_PHOTOS_BASE = "https://photoslibrary.googleapis.com/v1";

const SAMPLE_PHOTO_ALBUMS = [
  { id: "sample-family", title: "Family Moments", count: 42 },
  { id: "sample-vacation", title: "Summer Vacation", count: 118 },
  { id: "sample-pets", title: "Pets", count: 27 },
];

// The first linked Google account, or null when Google isn't configured/linked.
function firstGoogleAccountId(userId: number): string | null {
  if (!isGoogleConfigured(userId) || !isGoogleLinked(userId)) return null;
  return listGoogleAccounts(userId)[0]?.id ?? null;
}

// GET /api/widgets/photos/albums?source=google|immich — list albums.
router.get("/photos/albums", requireAuth, async (req: AuthRequest, res) => {
  const source = req.query["source"];
  const userId = req.user!.userId;

  if (source === "google") {
    const accountId = firstGoogleAccountId(userId);
    if (!accountId) {
      res.json({ sample: true, albums: SAMPLE_PHOTO_ALBUMS });
      return;
    }
    try {
      const token = await getGoogleAccessToken(userId, accountId);
      const albums: { id: string; title: string; count: number | null }[] = [];
      let pageToken: string | undefined;
      do {
        const r = await cloudHttpClient.get(`${GOOGLE_PHOTOS_BASE}/albums`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { pageSize: 50, ...(pageToken ? { pageToken } : {}) },
        });
        const data = r.data as {
          albums?: { id: string; title?: string; mediaItemsCount?: string }[];
          nextPageToken?: string;
        };
        for (const a of data.albums ?? []) {
          if (!a?.id) continue;
          const count = a.mediaItemsCount ? parseInt(a.mediaItemsCount, 10) : NaN;
          albums.push({
            id: a.id,
            title: a.title || "Untitled album",
            count: Number.isFinite(count) ? count : null,
          });
        }
        pageToken = data.nextPageToken;
      } while (pageToken && albums.length < 500);
      res.json({ albums });
    } catch (err) {
      const detail = describeHttpError(err);
      logger.error({ detail }, "Google Photos album list error");
      res.status(502).json({
        error:
          detail.status === 403
            ? "Google Photos access denied — re-link your Google account to grant the Photos permission"
            : "Failed to fetch Google Photos albums",
      });
    }
    return;
  }

  if (source === "immich") {
    const saved = getSavedConnection(userId, "immich");
    if (!saved.url || !saved.apiKey) {
      res.json({ sample: true, albums: SAMPLE_PHOTO_ALBUMS });
      return;
    }
    try {
      const r = await httpClient.get(`${saved.url}/api/albums`, {
        headers: { "x-api-key": saved.apiKey },
      });
      const list = Array.isArray(r.data) ? r.data : [];
      res.json({
        albums: list
          .filter((a: { id?: string }) => typeof a?.id === "string")
          .map((a: { id: string; albumName?: string; assetCount?: number }) => ({
            id: a.id,
            title: a.albumName || "Untitled album",
            count: typeof a.assetCount === "number" ? a.assetCount : null,
          })),
      });
    } catch (err) {
      logger.error({ detail: describeHttpError(err) }, "Immich album list error");
      res.status(502).json({ error: "Failed to fetch Immich albums" });
    }
    return;
  }

  res.status(400).json({ error: "Unknown photo source" });
});

// GET /api/widgets/photos?source=google|immich&albumId=… — normalized photo list.
router.get("/photos", requireAuth, async (req: AuthRequest, res) => {
  const source = req.query["source"];
  const albumId = typeof req.query["albumId"] === "string" ? req.query["albumId"] : "";
  const userId = req.user!.userId;

  if (source === "google") {
    const accountId = firstGoogleAccountId(userId);
    // Unconfigured (no linked account, or no album chosen yet): sample mode —
    // the tile shows its built-in demo slideshow.
    if (!accountId || !albumId || albumId.startsWith("sample-")) {
      res.json({ sample: true, photos: [] });
      return;
    }
    try {
      const token = await getGoogleAccessToken(userId, accountId);
      const r = await cloudHttpClient.post(
        `${GOOGLE_PHOTOS_BASE}/mediaItems:search`,
        { albumId, pageSize: 100 },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const items = (r.data as {
        mediaItems?: { id: string; mimeType?: string }[];
      }).mediaItems ?? [];
      res.json({
        photos: items
          .filter((m) => typeof m?.id === "string" && (m.mimeType ?? "").startsWith("image/"))
          .map((m) => ({
            id: m.id,
            url: `/api/widgets/photos/google/media/${encodeURIComponent(m.id)}`,
          })),
      });
    } catch (err) {
      const detail = describeHttpError(err);
      logger.error({ detail }, "Google Photos album listing error");
      res.status(502).json({
        error:
          detail.status === 403
            ? "Google Photos access denied — re-link your Google account to grant the Photos permission"
            : "Failed to fetch Google Photos",
      });
    }
    return;
  }

  if (source === "immich") {
    const saved = getSavedConnection(userId, "immich");
    if (!saved.url || !saved.apiKey || !albumId || albumId.startsWith("sample-")) {
      res.json({ sample: true, photos: [] });
      return;
    }
    try {
      const r = await httpClient.get(
        `${saved.url}/api/albums/${encodeURIComponent(albumId)}`,
        { headers: { "x-api-key": saved.apiKey } },
      );
      const assets = (r.data as { assets?: { id: string; type?: string }[] }).assets ?? [];
      res.json({
        photos: assets
          .filter((a) => typeof a?.id === "string" && (a.type ?? "IMAGE") === "IMAGE")
          .map((a) => ({
            id: a.id,
            url: `/api/widgets/photos/immich/asset/${encodeURIComponent(a.id)}`,
          })),
      });
    } catch (err) {
      logger.error({ detail: describeHttpError(err) }, "Immich album listing error");
      res.status(502).json({ error: "Failed to fetch Immich album" });
    }
    return;
  }

  res.status(400).json({ error: "Unknown photo source" });
});

// GET /api/widgets/photos/google/media/:id — proxy one Google photo's bytes.
// baseUrls expire, so the media item is re-fetched for a fresh baseUrl before
// downloading a display-sized rendition.
router.get("/photos/google/media/:id", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const accountId = firstGoogleAccountId(userId);
  if (!accountId) {
    res.status(400).json({ error: "Google Photos is not linked" });
    return;
  }
  try {
    const token = await getGoogleAccessToken(userId, accountId);
    const meta = await cloudHttpClient.get(
      `${GOOGLE_PHOTOS_BASE}/mediaItems/${encodeURIComponent(String(req.params["id"]))}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const { baseUrl, mimeType } = meta.data as { baseUrl?: string; mimeType?: string };
    if (!baseUrl) {
      res.status(502).json({ error: "Google Photos item has no download URL" });
      return;
    }
    const img = await cloudHttpClient.get(`${baseUrl}=w2048-h2048`, {
      responseType: "arraybuffer",
    });
    res.setHeader("Content-Type", mimeType || "image/jpeg");
    // Renditions are immutable for a given item; let the browser cache them.
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(img.data as ArrayBuffer));
  } catch (err) {
    logger.error({ detail: describeHttpError(err) }, "Google Photos media proxy error");
    res.status(502).json({ error: "Failed to fetch Google photo" });
  }
});

// GET /api/widgets/photos/immich/asset/:id — proxy one Immich asset's preview
// bytes (the API key stays server-side).
router.get("/photos/immich/asset/:id", requireAuth, async (req: AuthRequest, res) => {
  const saved = getSavedConnection(req.user!.userId, "immich");
  if (!saved.url || !saved.apiKey) {
    res.status(400).json({ error: "Immich is not configured" });
    return;
  }
  try {
    const r = await httpClient.get(
      `${saved.url}/api/assets/${encodeURIComponent(String(req.params["id"]))}/thumbnail`,
      {
        headers: { "x-api-key": saved.apiKey },
        params: { size: "preview" },
        responseType: "arraybuffer",
      },
    );
    const contentType =
      typeof r.headers?.["content-type"] === "string"
        ? r.headers["content-type"]
        : "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(r.data as ArrayBuffer));
  } catch (err) {
    logger.error({ detail: describeHttpError(err) }, "Immich asset proxy error");
    res.status(502).json({ error: "Failed to fetch Immich photo" });
  }
});

// ────────────────────────────────────────────────
// News (RSS / Atom) Widget
// ────────────────────────────────────────────────
// Unlike the homelab service tiles, this widget is configured entirely per-tile
// (no saved Settings connection): the tile passes the feed URL + item limit as
// query params. With no URL we return demo headlines (the "mock when
// unconfigured" convention); a configured-but-unfetchable/unparsable feed 502s
// so the tile renders its error state.

const NEWS_DEFAULT_LIMIT = 8;
const NEWS_MAX_LIMIT = 30;
const NEWS_MAX_FEED_BYTES = 2 * 1024 * 1024;

// Single shared parser. We fetch the feed ourselves via the shared httpClient so
// the request honors our timeout and self-signed-TLS handling, then hand the raw
// XML to rss-parser's parseString (it handles both RSS 2.0 and Atom).
const rssParser = new Parser();

interface NewsItemOut {
  title: string;
  link: string | null;
  source: string | null;
  published: string | null;
}

const DEMO_NEWS: { feedTitle: string; items: NewsItemOut[] } = {
  feedTitle: "Demo Feed",
  items: [
    {
      title: "Add a feed URL in this tile's settings to see real headlines",
      link: null,
      source: "Demo Feed",
      published: new Date().toISOString(),
    },
    {
      title: "Self-hosted homelab dashboards keep gaining momentum",
      link: null,
      source: "Demo Feed",
      published: new Date(Date.now() - 3600_000).toISOString(),
    },
    {
      title: "RSS is still the simplest way to follow any site",
      link: null,
      source: "Demo Feed",
      published: new Date(Date.now() - 2 * 3600_000).toISOString(),
    },
    {
      title: "Works with BBC, Hacker News, subreddits, and most blogs",
      link: null,
      source: "Demo Feed",
      published: new Date(Date.now() - 5 * 3600_000).toISOString(),
    },
    {
      title: "No API key or signup required — just paste a feed link",
      link: null,
      source: "Demo Feed",
      published: new Date(Date.now() - 8 * 3600_000).toISOString(),
    },
  ],
};

function clampNewsLimit(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return NEWS_DEFAULT_LIMIT;
  return Math.min(NEWS_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

router.get("/news", requireAuth, async (req, res) => {
  const rawUrl = typeof req.query["url"] === "string" ? req.query["url"].trim() : "";
  const limit = clampNewsLimit(req.query["limit"]);
  const feedUrl = rawUrl ? normalizeFeedUrl(rawUrl) : undefined;

  // Unconfigured (no feed URL): show representative demo headlines.
  if (!feedUrl) {
    res.json({ feedTitle: DEMO_NEWS.feedTitle, items: DEMO_NEWS.items.slice(0, limit) });
    return;
  }

  try {
    const r = await httpClient.get(feedUrl, {
      responseType: "text",
      // Axios counts bytes as they arrive (after decompression) and aborts
      // before buffering/parsing an oversized or endless feed.
      maxContentLength: NEWS_MAX_FEED_BYTES,
      // Some feeds gate on a browser-y UA and reject the default axios one.
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      // This proxies arbitrary user-supplied URLs to fetch public RSS/Atom
      // feeds, not a homelab device — refuse private/loopback/link-local
      // destinations so it can't be used to probe the internal network.
      ssrfPublicOnly: true,
    });
    const feed = await rssParser.parseString(String(r.data ?? ""));
    const feedTitle = feed.title?.trim() || null;

    const items: NewsItemOut[] = (feed.items ?? []).slice(0, limit).map((it) => {
      const title = (it.title ?? "").trim() || "(untitled)";
      const link = it.link?.trim() || null;
      // rss-parser exposes the per-item <source> as `it.source` when present.
      const source =
        (typeof it.source === "string" ? it.source.trim() : "") || null;
      const isoRaw = it.isoDate || it.pubDate || null;
      let published: string | null = null;
      if (isoRaw) {
        const d = new Date(isoRaw);
        published = Number.isNaN(d.getTime()) ? null : d.toISOString();
      }
      return { title, link, source, published };
    });

    res.json({ feedTitle, items });
  } catch (err) {
    logger.warn({ feedUrl, reason: normalizeHttpError(err) }, "News widget error");
    res.status(502).json({ error: "Could not fetch or parse that feed." });
  }
});

// ────────────────────────────────────────────────
// Stocks Widget
// ────────────────────────────────────────────────
// Per-tile watchlist of US equity/ETF symbols. Quotes (price + daily change)
// come from a free stock-quote provider (Finnhub) proxied here so the API key
// stays server-side. Following the widget-data convention: with NO key
// configured the route returns clearly-labeled sample quotes (sample: true) so
// the tile still renders; with a key configured but the upstream failing it
// returns 502 so the tile shows its error state.

const STOCKS_MAX_SYMBOLS = 25;
const FINNHUB_BASE = "https://finnhub.io/api/v1";

// The provider key comes from the saved "stocks" connection first (set via the
// Settings page), falling back to the server secrets so existing deployments
// keep working. Finnhub is the chosen free provider (simple per-symbol /quote
// endpoint + /search on the free tier).
function getStocksApiKey(userId: number): string | undefined {
  const connection = savedOrEnvironmentConnection(userId, "stocks", {
    apiKey:
      process.env["FINNHUB_API_KEY"]?.trim() ||
      process.env["STOCKS_API_KEY"]?.trim() ||
      undefined,
  });
  return connection.apiKey;
}

// A small static catalog used both for sample quotes (unconfigured) and as a
// fallback symbol-search source. Prices are representative, not live.
const SAMPLE_STOCKS: Record<string, { name: string; price: number; changePercent: number }> = {
  AAPL: { name: "Apple Inc", price: 229.87, changePercent: 0.82 },
  MSFT: { name: "Microsoft Corp", price: 432.15, changePercent: -0.45 },
  GOOGL: { name: "Alphabet Inc Class A", price: 178.34, changePercent: 1.21 },
  AMZN: { name: "Amazon.com Inc", price: 201.55, changePercent: -1.08 },
  NVDA: { name: "NVIDIA Corp", price: 138.92, changePercent: 2.34 },
  TSLA: { name: "Tesla Inc", price: 352.41, changePercent: -2.11 },
  META: { name: "Meta Platforms Inc", price: 602.78, changePercent: 0.56 },
  VOO: { name: "Vanguard S&P 500 ETF", price: 545.6, changePercent: 0.34 },
  SPY: { name: "SPDR S&P 500 ETF Trust", price: 593.12, changePercent: 0.31 },
  QQQ: { name: "Invesco QQQ Trust", price: 511.47, changePercent: 0.62 },
};

const DEFAULT_SAMPLE_SYMBOLS = ["AAPL", "MSFT", "NVDA", "VOO"];

interface StockQuoteOut {
  symbol: string;
  name: string | null;
  price: number;
  change: number;
  changePercent: number;
}

// Build a sample quote for a symbol. Falls back to a deterministic pseudo-price
// for symbols not in the static catalog so an arbitrary watchlist still renders
// representative (clearly non-live) data.
function sampleQuote(symbol: string): StockQuoteOut {
  const known = SAMPLE_STOCKS[symbol];
  if (known) {
    const price = known.price;
    const change = (price * known.changePercent) / 100;
    return { symbol, name: known.name, price, change, changePercent: known.changePercent };
  }
  // Deterministic fallback from the symbol's characters.
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) % 100000;
  const price = 20 + (seed % 480) + (seed % 100) / 100;
  const changePercent = ((seed % 800) - 400) / 100; // -4% .. +4%
  const change = (price * changePercent) / 100;
  return { symbol, name: null, price, change, changePercent };
}

function parseSymbols(raw: unknown): string[] {
  const text = typeof raw === "string" ? raw : "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(",")) {
    const sym = part.trim().toUpperCase();
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
      if (out.length >= STOCKS_MAX_SYMBOLS) break;
    }
  }
  return out;
}

router.get("/stocks", requireAuth, async (req: AuthRequest, res) => {
  const symbols = parseSymbols(req.query["symbols"]);
  const apiKey = getStocksApiKey(req.user!.userId);

  // Unconfigured (no provider key): return clearly-labeled sample quotes. When
  // no symbols were requested either, seed with a representative default set so
  // a brand-new tile still shows content.
  if (!apiKey) {
    const list = symbols.length > 0 ? symbols : DEFAULT_SAMPLE_SYMBOLS;
    res.json({ quotes: list.map(sampleQuote), sample: true });
    return;
  }

  // Configured but nothing to quote yet — return an empty (non-sample) result.
  if (symbols.length === 0) {
    res.json({ quotes: [], sample: false });
    return;
  }

  try {
    // Finnhub has a per-symbol quote endpoint; fetch them in parallel. Profile
    // lookups (for the company name) are best-effort and must not fail the row.
    const quotes = await Promise.all(
      symbols.map(async (symbol): Promise<StockQuoteOut | null> => {
        const quoteRes = await cloudHttpClient.get(`${FINNHUB_BASE}/quote`, {
          params: { symbol, token: apiKey },
        });
        const q = (quoteRes.data ?? {}) as {
          c?: number; // current price
          d?: number; // change
          dp?: number; // percent change
        };
        // Finnhub returns all-zeros for an unknown symbol; treat that as "no
        // data" and drop the row rather than showing a $0 quote.
        if (!q.c || q.c === 0) return null;

        let name: string | null = null;
        try {
          const profRes = await cloudHttpClient.get(`${FINNHUB_BASE}/stock/profile2`, {
            params: { symbol, token: apiKey },
          });
          const prof = (profRes.data ?? {}) as { name?: string };
          name = prof.name?.trim() || null;
        } catch {
          // Name is a nicety; ignore lookup failures.
        }

        return {
          symbol,
          name,
          price: q.c,
          change: q.d ?? 0,
          changePercent: q.dp ?? 0,
        };
      }),
    );

    res.json({ quotes: quotes.filter((q): q is StockQuoteOut => q !== null), sample: false });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Stocks widget error");
    res.status(502).json({ error: "Failed to fetch stock quotes" });
  }
});

// Number of recent daily closes a sparkline shows (~30 trading days).
const STOCKS_CANDLE_DAYS = 30;

interface StockCandleSeriesOut {
  symbol: string;
  closes: number[];
}

// Build a deterministic sample closing-price series for a symbol. The walk ends
// near the symbol's sample price and drifts in the direction of its sample
// daily change, so the sparkline visibly matches the row's up/down tone.
function sampleCandleSeries(symbol: string): StockCandleSeriesOut {
  const quote = sampleQuote(symbol);
  const end = quote.price;
  // Slope across the window scaled loosely off the daily-change direction.
  const drift = (quote.changePercent / 100) * end * 6;
  const start = Math.max(1, end - drift);
  // Seed a small pseudo-random wiggle from the symbol so it is stable per render.
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) % 100000;
  const closes: number[] = [];
  for (let i = 0; i < STOCKS_CANDLE_DAYS; i++) {
    const t = i / (STOCKS_CANDLE_DAYS - 1);
    const base = start + (end - start) * t;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const wiggle = ((seed / 2147483648) * 2 - 1) * end * 0.012;
    closes.push(Math.max(0.01, Number((base + wiggle).toFixed(2))));
  }
  // Pin the last point exactly to the sample price for visual consistency.
  closes[closes.length - 1] = Number(end.toFixed(2));
  return { symbol, closes };
}

router.get("/stocks/candles", requireAuth, async (req: AuthRequest, res) => {
  const symbols = parseSymbols(req.query["symbols"]);
  const apiKey = getStocksApiKey(req.user!.userId);

  // Unconfigured: return clearly-labeled sample series so the tile still renders.
  if (!apiKey) {
    const list = symbols.length > 0 ? symbols : DEFAULT_SAMPLE_SYMBOLS;
    res.json({ series: list.map(sampleCandleSeries), sample: true });
    return;
  }

  if (symbols.length === 0) {
    res.json({ series: [], sample: false });
    return;
  }

  try {
    // Finnhub's daily-candle endpoint takes a UNIX-second window. Fetch ~6 weeks
    // back to comfortably cover STOCKS_CANDLE_DAYS trading days, then keep the
    // most recent closes. Per-symbol fetches run in parallel; a symbol with no
    // usable data is dropped rather than failing the whole request.
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 24 * 45;
    const series = await Promise.all(
      symbols.map(async (symbol): Promise<StockCandleSeriesOut | null> => {
        const candleRes = await cloudHttpClient.get(`${FINNHUB_BASE}/stock/candle`, {
          params: { symbol, resolution: "D", from, to, token: apiKey },
        });
        const data = (candleRes.data ?? {}) as { c?: number[]; s?: string };
        // Finnhub signals "no data" with s:"no_data" and/or an empty close array.
        if (data.s !== "ok" || !Array.isArray(data.c) || data.c.length === 0) {
          return null;
        }
        const closes = data.c
          .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
          .slice(-STOCKS_CANDLE_DAYS);
        if (closes.length === 0) return null;
        return { symbol, closes };
      }),
    );

    res.json({ series: series.filter((s): s is StockCandleSeriesOut => s !== null), sample: false });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Stock candles widget error");
    res.status(502).json({ error: "Failed to fetch stock candles" });
  }
});

router.get("/stocks/search", requireAuth, async (req: AuthRequest, res) => {
  const q = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
  const apiKey = getStocksApiKey(req.user!.userId);

  if (!q) {
    res.json({ results: [], sample: !apiKey });
    return;
  }

  // Unconfigured: match against the built-in sample catalog so the editor can
  // still add symbols (clearly sample data).
  if (!apiKey) {
    const upper = q.toUpperCase();
    const results = Object.entries(SAMPLE_STOCKS)
      .filter(([sym, info]) => sym.includes(upper) || info.name.toUpperCase().includes(upper))
      .map(([sym, info]) => ({ symbol: sym, description: info.name }));
    res.json({ results, sample: true });
    return;
  }

  try {
    const searchRes = await cloudHttpClient.get(`${FINNHUB_BASE}/search`, {
      params: { q, token: apiKey },
    });
    const data = (searchRes.data ?? {}) as {
      result?: Array<{ symbol?: string; description?: string; type?: string }>;
    };
    const results = (data.result ?? [])
      // Common stocks/ETFs only — skip symbols with exchange suffixes (foreign
      // listings) to keep the free-tier US-equity focus.
      .filter((r) => r.symbol && !r.symbol.includes("."))
      .slice(0, 20)
      .map((r) => ({
        symbol: (r.symbol ?? "").toUpperCase(),
        description: r.description?.trim() || (r.symbol ?? "").toUpperCase(),
      }));
    res.json({ results, sample: false });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Stocks search error");
    res.status(502).json({ error: "Failed to search stock symbols" });
  }
});

// ── Weather (Open-Meteo, no saved connection needed) ─────────────────────────

interface WeatherDailyOut {
  date: string;
  code: number;
  high: number | null;
  low: number | null;
}

// Every browser polls this endpoint every ~10 minutes, and several users/tabs
// often share a location, so upstream calls are cached (promise-cached, which
// also dedupes concurrent requests). Coordinates are rounded so nearby
// requests share an entry (~1 km at 2 decimals). Failures are never cached —
// see lib/fetchCache.ts.
const WEATHER_FORECAST_TTL_MS = 5 * 60_000; // conditions change slowly
const WEATHER_GEO_TTL_MS = 24 * 60 * 60_000; // place names/coords don't change

function weatherCoordKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

// Best-effort reverse geocode via Open-Meteo-adjacent BigDataCloud. The name is
// a nicety — any failure just yields a generic label rather than an error.
// The inner fetch throws on failure so only successful lookups get cached;
// the generic fallback is applied outside the cache.
async function reverseGeocodeName(lat: number, lon: number): Promise<string> {
  try {
    return await cachedFetch(
      `weather:revgeo:${weatherCoordKey(lat, lon)}`,
      async () => {
        const res = await cloudHttpClient.get(
          "https://api.bigdatacloud.net/data/reverse-geocode-client",
          { params: { latitude: lat, longitude: lon, localityLanguage: "en" } },
        );
        const j = (res.data ?? {}) as {
          city?: string;
          locality?: string;
          principalSubdivision?: string;
        };
        return j.city || j.locality || j.principalSubdivision || "Current location";
      },
      WEATHER_GEO_TTL_MS,
    );
  } catch (err) {
    logger.warn({ reason: normalizeHttpError(err) }, "Weather reverse geocode failed");
    return "Current location";
  }
}

router.get("/weather", requireAuth, async (req, res) => {
  const latRaw = typeof req.query["lat"] === "string" ? Number(req.query["lat"]) : NaN;
  const lonRaw = typeof req.query["lon"] === "string" ? Number(req.query["lon"]) : NaN;
  const city = typeof req.query["city"] === "string" ? req.query["city"].trim() : "";
  const units = req.query["units"] === "f" ? "f" : "c";
  const hasCoords = Number.isFinite(latRaw) && Number.isFinite(lonRaw);

  // Bound user-controlled cache keys and reject meaningless coordinates
  // before making any upstream request.
  if (city.length > 200) {
    res.status(400).json({ error: "City name must be 200 characters or fewer" });
    return;
  }
  if (hasCoords && (Math.abs(latRaw) > 90 || Math.abs(lonRaw) > 180)) {
    res.status(400).json({ error: "Coordinates must be within latitude ±90 and longitude ±180" });
    return;
  }

  if (!hasCoords && !city) {
    res.status(400).json({ error: "Provide either lat/lon coordinates or a city name" });
    return;
  }

  let lat: number;
  let lon: number;
  let name: string;

  if (hasCoords) {
    lat = latRaw;
    lon = lonRaw;
    name = await reverseGeocodeName(lat, lon);
  } else {
    // Geocode the typed city name via Open-Meteo's geocoding API.
    let first:
      | { latitude: number; longitude: number; name: string; country?: string }
      | undefined;
    try {
      first = await cachedFetch(
        `weather:geo:${city.toLowerCase()}`,
        async () => {
          const geoRes = await cloudHttpClient.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            { params: { name: city, count: 1, language: "en", format: "json" } },
          );
          const j = (geoRes.data ?? {}) as {
            results?: Array<{
              latitude: number;
              longitude: number;
              name: string;
              country?: string;
            }>;
          };
          return j.results?.[0];
        },
        WEATHER_GEO_TTL_MS,
      );
    } catch (err) {
      logger.error({ reason: normalizeHttpError(err) }, "Weather geocoding error");
      res.status(502).json({ error: "Weather service unreachable — could not look up that city" });
      return;
    }
    if (!first) {
      res.status(404).json({ error: `Couldn't find "${city}" — check the city name in this tile's settings` });
      return;
    }
    lat = first.latitude;
    lon = first.longitude;
    name = [first.name, first.country].filter(Boolean).join(", ");
  }

  try {
    const j = await cachedFetch(
      `weather:fc:${weatherCoordKey(lat, lon)}:${units}`,
      async () => {
        const fcRes = await cloudHttpClient.get("https://api.open-meteo.com/v1/forecast", {
          params: {
            latitude: lat,
            longitude: lon,
            current: "temperature_2m,apparent_temperature,weather_code,is_day",
            daily: "weather_code,temperature_2m_max,temperature_2m_min",
            forecast_days: 7,
            temperature_unit: units === "f" ? "fahrenheit" : "celsius",
            timezone: "auto",
          },
        });
        return (fcRes.data ?? {}) as {
          current?: {
            temperature_2m: number;
            apparent_temperature: number;
            weather_code: number;
            is_day: number;
          };
          daily?: {
            time?: string[];
            weather_code?: number[];
            temperature_2m_max?: number[];
            temperature_2m_min?: number[];
          };
        };
      },
      WEATHER_FORECAST_TTL_MS,
    );
    if (!j.current) {
      res.status(502).json({ error: "Weather service returned no current conditions" });
      return;
    }

    const days = j.daily?.time ?? [];
    const forecast: WeatherDailyOut[] = days.map((date, i) => ({
      date,
      code: j.daily?.weather_code?.[i] ?? 0,
      high: j.daily?.temperature_2m_max?.[i] ?? null,
      low: j.daily?.temperature_2m_min?.[i] ?? null,
    }));

    res.json({
      name,
      temp: j.current.temperature_2m,
      feels: j.current.apparent_temperature,
      code: j.current.weather_code,
      isDay: j.current.is_day === 1,
      high: j.daily?.temperature_2m_max?.[0] ?? null,
      low: j.daily?.temperature_2m_min?.[0] ?? null,
      forecast,
    });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Weather forecast error");
    res.status(502).json({ error: "Weather service unreachable — could not load the forecast" });
  }
});

// ── Email + Calendar (Gmail / IMAP / Google Calendar / CalDAV) ────────────────

// Derive the browser-facing origin from the (proxied) request so the OAuth
// redirect URI matches what Google will actually call back.
function originFromRequest(req: {
  headers: Record<string, unknown>;
  protocol: string;
  get: (h: string) => string | undefined;
}): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ||
    req.protocol;
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ||
    req.get("host") ||
    "";
  return `${proto}://${host}`;
}

// GET /api/widgets/gmail/auth — begin the Google OAuth flow. This is a
// top-level browser navigation (opened in a popup by Settings), so it cannot
// carry the bearer token; instead it must present a short-lived single-use
// `intent` token minted by the authenticated
// POST /connections/google/auth-intent. Without this, any unauthenticated
// visitor could bind their own Google account to the app-wide link. `origin`
// is the dashboard's base URL (host + SPA base path) used to build the
// post-auth return URL.
router.get("/gmail/auth", (req, res) => {
  const intent = typeof req.query["intent"] === "string" ? req.query["intent"] : "";
  const userId = intent ? consumeGoogleAuthIntent(intent, readBrowserBinding(req, intent)) : null;
  if (!userId) {
    res.status(403).send("Missing or expired authorization. Start the flow from Settings.");
    return;
  }
  clearBrowserBinding(req, res, intent);
  if (!isGoogleConfigured(userId)) {
    res
      .status(400)
      .send("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    return;
  }
  const base =
    (typeof req.query["origin"] === "string" && req.query["origin"].trim()) ||
    originFromRequest(req);
  let hostOrigin: string;
  try {
    hostOrigin = new URL(base).origin;
  } catch {
    hostOrigin = originFromRequest(req);
  }
  const redirectUri = `${hostOrigin.replace(/\/+$/, "")}${GMAIL_CALLBACK_PATH}`;
  const returnTo = `${base.replace(/\/+$/, "")}/settings`;
  logger.info({ redirectUri }, "Google OAuth start");
  const binding = newBrowserBinding();
  const state = createGooglePendingAuth(userId, redirectUri, returnTo, binding);
  setBrowserBinding(req, res, state, binding);
  res.redirect(buildGoogleAuthUrl(userId, redirectUri, state));
});

// GET /api/widgets/gmail/callback — Google redirects the browser here.
// Unauthenticated by necessity (top-level navigation can't carry the bearer
// token); protected by single-use state AND an initiating-browser cookie.
router.get("/gmail/callback", async (req, res) => {
  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  const state = typeof req.query["state"] === "string" ? req.query["state"] : null;
  const error = typeof req.query["error"] === "string" ? req.query["error"] : null;

  const pending = state ? consumeGooglePendingAuth(state, readBrowserBinding(req, state)) : null;
  if (pending) clearBrowserBinding(req, res, state!);
  const fallbackReturn = `${originFromRequest(req).replace(/\/+$/, "")}/settings`;
  const returnTo = pending?.returnTo || fallbackReturn;
  // `reason` gives Settings enough context for targeted help instead of a
  // generic failure toast: "denied" (user declined consent), "expired" (state
  // lost/timed out), "redirect" (Google rejected the redirect URI at token
  // exchange), "exchange" (any other token-exchange failure), "provider"
  // (Google sent some other error param).
  const settingsUrl = (status: string, reason?: string) =>
    `${returnTo}?google=${status}${reason ? `&google_reason=${encodeURIComponent(reason)}` : ""}`;

  if (error || !code || !pending) {
    logger.warn(
      { error, hasCode: Boolean(code), hasPending: Boolean(pending) },
      "Google callback rejected",
    );
    const reason = error
      ? error === "access_denied"
        ? "denied"
        : "provider"
      : !pending
        ? "expired"
        : "provider";
    res.redirect(settingsUrl("error", reason));
    return;
  }

  try {
    await exchangeGoogleCode(pending.userId, code, pending.redirectUri);
    res.redirect(settingsUrl("connected"));
  } catch (err) {
    const detail = describeHttpError(err);
    logger.error({ reason: normalizeHttpError(err), detail }, "Google token exchange failed");
    const bodyText = typeof detail.body === "string" ? detail.body : JSON.stringify(detail.body ?? "");
    const reason = bodyText.includes("redirect_uri_mismatch") ? "redirect" : "exchange";
    res.redirect(settingsUrl("error", reason));
  }
});

const EMAIL_MAX_DEFAULT = 15;
const EMAIL_MAX_CAP = 50;
const CALENDAR_DAYS_DEFAULT = 14;
const CALENDAR_DAYS_CAP = 60;
const CALENDAR_MAX_DEFAULT = 20;
const CALENDAR_MAX_CAP = 50;

function clampInt(raw: unknown, def: number, cap: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, cap);
}

interface AccountError {
  account: string;
  message: string;
}

function errMessage(err: unknown): string {
  const norm = normalizeHttpError(err);
  return typeof norm === "string" ? norm : err instanceof Error ? err.message : String(err);
}

// Shared aggregation for /email/inbox (and the per-provider variants). Returns
// mock data only when NO mail account is configured; when accounts are
// configured but every one of them fails, the caller answers 502.
async function collectEmail(
  userId: number,
  opts: {
    accountsFilter: string[] | null;
    max: number;
    unreadOnly: boolean;
    include: "all" | "gmail" | "imap";
    fresh: boolean;
  },
): Promise<
  | { kind: "sample"; messages: EmailMessage[] }
  | { kind: "data"; messages: EmailMessage[]; unreadTotal: number | null; errors: AccountError[] }
  | { kind: "all-failed"; errors: AccountError[] }
> {
  const googleAccounts = isGoogleLinked(userId) ? listGoogleAccounts(userId) : [];
  const imapAccounts = listImapAccounts(userId);

  // Filter matches a specific Google account id; the legacy "gmail" key (from
  // tiles saved before multi-account support) selects every Google account.
  const wantGmail =
    opts.include !== "imap"
      ? googleAccounts.filter(
          (a) =>
            !opts.accountsFilter ||
            opts.accountsFilter.includes(a.id) ||
            opts.accountsFilter.includes("gmail"),
        )
      : [];
  const wantImap =
    opts.include !== "gmail"
      ? imapAccounts.filter((a) => !opts.accountsFilter || opts.accountsFilter.includes(a.id))
      : [];

  if (wantGmail.length === 0 && wantImap.length === 0) {
    // Nothing configured (or the filter matched nothing that exists).
    const configuredAtAll = googleAccounts.length > 0 || imapAccounts.length > 0;
    if (!configuredAtAll) {
      let demo = demoEmailMessages();
      if (opts.unreadOnly) demo = demo.filter((m) => m.unread);
      return { kind: "sample", messages: demo.slice(0, opts.max) };
    }
    return { kind: "data", messages: [], unreadTotal: null, errors: [] };
  }

  const errors: AccountError[] = [];
  const all: EmailMessage[] = [];
  let unreadTotal: number | null = null;
  let successes = 0;

  const tasks: Promise<void>[] = [];
  for (const account of wantGmail) {
    const label = account.email ?? "Gmail";
    tasks.push(
      fetchGmailMessages(userId, {
        accountId: account.id,
        accountLabel: label,
        max: opts.max,
        unreadOnly: opts.unreadOnly,
        fresh: opts.fresh,
      })
        .then((r) => {
          successes += 1;
          all.push(...r.messages);
          if (r.unread !== null) unreadTotal = (unreadTotal ?? 0) + r.unread;
        })
        .catch((err) => {
          logger.warn({ reason: normalizeHttpError(err), account: label }, "Gmail fetch failed");
          errors.push({ account: label, message: errMessage(err) });
        }),
    );
  }
  for (const account of wantImap) {
    tasks.push(
      fetchImapMessages(account, { max: opts.max, unreadOnly: opts.unreadOnly, fresh: opts.fresh })
        .then((r) => {
          successes += 1;
          all.push(...r.messages);
          if (r.unread !== null) unreadTotal = (unreadTotal ?? 0) + r.unread;
        })
        .catch((err) => {
          logger.warn(
            { reason: normalizeHttpError(err), account: account.label },
            "IMAP fetch failed",
          );
          errors.push({ account: account.label, message: errMessage(err) });
        }),
    );
  }
  await Promise.all(tasks);

  if (successes === 0) return { kind: "all-failed", errors };

  all.sort((a, b) => (a.date < b.date ? 1 : -1));
  const messages = (opts.unreadOnly ? all.filter((m) => m.unread) : all).slice(0, opts.max);
  return { kind: "data", messages, unreadTotal, errors };
}

async function handleEmailRequest(
  userId: number,
  req: { query: Record<string, unknown> },
  res: { json: (b: unknown) => void; status: (c: number) => { json: (b: unknown) => void } },
  include: "all" | "gmail" | "imap",
): Promise<void> {
  const accountsRaw = typeof req.query["accounts"] === "string" ? req.query["accounts"] : "";
  const accountsFilter = accountsRaw
    ? accountsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const max = clampInt(req.query["max"], EMAIL_MAX_DEFAULT, EMAIL_MAX_CAP);
  const unreadOnly = req.query["unreadOnly"] === "true";
  // fresh=true bypasses the short server-side fetch cache (manual tile
  // refresh); background polling omits it and keeps hitting the cache.
  const fresh = req.query["fresh"] === "true";

  try {
    const result = await collectEmail(userId, { accountsFilter, max, unreadOnly, include, fresh });
    if (result.kind === "sample") {
      res.json({ messages: result.messages, unreadTotal: 2, errors: null, sample: true });
      return;
    }
    if (result.kind === "all-failed") {
      res.status(502).json({ error: "All configured mail accounts failed to respond" });
      return;
    }
    res.json({
      messages: result.messages,
      unreadTotal: result.unreadTotal,
      errors: result.errors.length > 0 ? result.errors : null,
      sample: false,
    });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Email widget error");
    res.status(502).json({ error: "Failed to fetch mail" });
  }
}

// GET /api/widgets/email/inbox — aggregated recent messages across accounts.
router.get("/email/inbox", requireAuth, async (req: AuthRequest, res) => {
  await handleEmailRequest(req.user!.userId, req, res, "all");
});

// Per-provider variants (same shape, narrowed to one provider).
router.get("/email/gmail", requireAuth, async (req: AuthRequest, res) => {
  await handleEmailRequest(req.user!.userId, req, res, "gmail");
});
router.get("/email/imap", requireAuth, async (req: AuthRequest, res) => {
  await handleEmailRequest(req.user!.userId, req, res, "imap");
});

// POST /api/widgets/email/archive — archive one message. The body carries the
// EmailMessage.id, whose prefix encodes the provider: "gmail:<acct>:<msgId>"
// removes the INBOX label via the Gmail API; "<imapAcct>:<uid>" moves the
// message to the server's Archive mailbox. Demo rows are rejected up front.
router.post("/email/archive", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const body = req.body as { id?: unknown } | undefined;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) {
    res.status(400).json({ error: "Message id is required" });
    return;
  }
  if (id.startsWith("demo:")) {
    res.status(400).json({ error: "Demo messages can't be archived" });
    return;
  }

  try {
    if (id.startsWith("gmail:")) {
      const rest = id.slice("gmail:".length);
      const sep = rest.lastIndexOf(":");
      if (sep <= 0 || sep === rest.length - 1) {
        res.status(400).json({ error: "Malformed message id" });
        return;
      }
      const accountId = rest.slice(0, sep);
      if (!listGoogleAccounts(userId).some((a) => a.id === accountId)) {
        res.status(404).json({ error: "Unknown Google account" });
        return;
      }
      await archiveGmailMessage(userId, accountId, rest.slice(sep + 1));
    } else {
      const sep = id.lastIndexOf(":");
      const uid = sep > 0 ? Number(id.slice(sep + 1)) : NaN;
      if (!Number.isInteger(uid) || uid <= 0) {
        res.status(400).json({ error: "Malformed message id" });
        return;
      }
      const account = listImapAccounts(userId).find((a) => a.id === id.slice(0, sep));
      if (!account) {
        res.status(404).json({ error: "Unknown mail account" });
        return;
      }
      await archiveImapMessage(account, uid);
    }
    res.json({ ok: true });
  } catch (err) {
    const detail = describeHttpError(err);
    // Gmail returns 403 when the token predates the gmail.modify scope.
    if (id.startsWith("gmail:") && detail.status === 403) {
      res.status(403).json({
        error:
          "This Google account was linked with read-only access. Disconnect and re-link it in Settings to allow archiving.",
      });
      return;
    }
    logger.error({ reason: detail, id }, "Email archive error");
    res.status(502).json({ error: normalizeHttpError(err) });
  }
});

// POST /api/widgets/email/mark-read — mark one message as read. The body
// carries the EmailMessage.id, whose prefix encodes the provider (same
// convention as /email/archive): "gmail:<acct>:<msgId>" removes the UNREAD
// label via the Gmail API; "<imapAcct>:<uid>" adds the \Seen flag over IMAP.
// Demo rows are rejected up front.
router.post("/email/mark-read", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const body = req.body as { id?: unknown } | undefined;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) {
    res.status(400).json({ error: "Message id is required" });
    return;
  }
  if (id.startsWith("demo:")) {
    res.status(400).json({ error: "Demo messages can't be marked read" });
    return;
  }

  try {
    if (id.startsWith("gmail:")) {
      const rest = id.slice("gmail:".length);
      const sep = rest.lastIndexOf(":");
      if (sep <= 0 || sep === rest.length - 1) {
        res.status(400).json({ error: "Malformed message id" });
        return;
      }
      const accountId = rest.slice(0, sep);
      if (!listGoogleAccounts(userId).some((a) => a.id === accountId)) {
        res.status(404).json({ error: "Unknown Google account" });
        return;
      }
      await markGmailMessageRead(userId, accountId, rest.slice(sep + 1));
    } else {
      const sep = id.lastIndexOf(":");
      const uid = sep > 0 ? Number(id.slice(sep + 1)) : NaN;
      if (!Number.isInteger(uid) || uid <= 0) {
        res.status(400).json({ error: "Malformed message id" });
        return;
      }
      const account = listImapAccounts(userId).find((a) => a.id === id.slice(0, sep));
      if (!account) {
        res.status(404).json({ error: "Unknown mail account" });
        return;
      }
      await markImapMessageRead(account, uid);
    }
    res.json({ ok: true });
  } catch (err) {
    const detail = describeHttpError(err);
    // Gmail returns 403 when the token predates the gmail.modify scope.
    if (id.startsWith("gmail:") && detail.status === 403) {
      res.status(403).json({
        error:
          "This Google account was linked with read-only access. Disconnect and re-link it in Settings to allow marking messages read.",
      });
      return;
    }
    logger.error({ reason: detail, id }, "Email mark-read error");
    res.status(502).json({ error: normalizeHttpError(err) });
  }
});

// GET /api/widgets/email/message — fetch one message's plain-text body on
// demand for the detail pop-out. The id query param carries the EmailMessage
// id, whose prefix encodes the provider (same convention as /email/archive):
// "gmail:<acct>:<msgId>" pulls format=full from the Gmail API, "<imapAcct>:<uid>"
// fetches the text body part over IMAP. Demo rows are rejected up front.
router.get("/email/message", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const id = typeof req.query["id"] === "string" ? req.query["id"] : "";
  if (!id) {
    res.status(400).json({ error: "Message id is required" });
    return;
  }
  if (id.startsWith("demo:")) {
    res.status(400).json({ error: "Demo messages have no body to fetch" });
    return;
  }

  try {
    let body: string | null;
    if (id.startsWith("gmail:")) {
      const rest = id.slice("gmail:".length);
      const sep = rest.lastIndexOf(":");
      if (sep <= 0 || sep === rest.length - 1) {
        res.status(400).json({ error: "Malformed message id" });
        return;
      }
      const accountId = rest.slice(0, sep);
      if (!listGoogleAccounts(userId).some((a) => a.id === accountId)) {
        res.status(404).json({ error: "Unknown Google account" });
        return;
      }
      body = await fetchGmailMessageBody(userId, accountId, rest.slice(sep + 1));
    } else {
      const sep = id.lastIndexOf(":");
      const uid = sep > 0 ? Number(id.slice(sep + 1)) : NaN;
      if (!Number.isInteger(uid) || uid <= 0) {
        res.status(400).json({ error: "Malformed message id" });
        return;
      }
      const account = listImapAccounts(userId).find((a) => a.id === id.slice(0, sep));
      if (!account) {
        res.status(404).json({ error: "Unknown mail account" });
        return;
      }
      body = await fetchImapMessageBody(account, uid);
    }
    res.json({ body });
  } catch (err) {
    logger.error({ reason: describeHttpError(err), id }, "Email message body error");
    res.status(502).json({ error: "Failed to fetch the message body" });
  }
});

// Shared aggregation for /calendar/events (and the per-provider variants).
async function collectCalendar(
  userId: number,
  opts: {
    accountsFilter: string[] | null;
    days: number;
    max: number;
    include: "all" | "google" | "caldav";
    fresh: boolean;
  },
): Promise<
  | { kind: "sample"; events: CalendarEvent[] }
  | { kind: "data"; events: CalendarEvent[]; errors: AccountError[] }
  | { kind: "all-failed"; errors: AccountError[] }
> {
  const googleAccounts = isGoogleLinked(userId) ? listGoogleAccounts(userId) : [];
  const caldavAccounts = listCalDavAccounts(userId);

  // Filter matches a specific Google account id; the legacy "google" key (from
  // tiles saved before multi-account support) selects every Google account.
  const wantGoogle =
    opts.include !== "caldav"
      ? googleAccounts.filter(
          (a) =>
            !opts.accountsFilter ||
            opts.accountsFilter.includes(a.id) ||
            opts.accountsFilter.includes("google"),
        )
      : [];
  const wantCalDav =
    opts.include !== "google"
      ? caldavAccounts.filter((a) => !opts.accountsFilter || opts.accountsFilter.includes(a.id))
      : [];

  if (wantGoogle.length === 0 && wantCalDav.length === 0) {
    const configuredAtAll = googleAccounts.length > 0 || caldavAccounts.length > 0;
    if (!configuredAtAll) {
      return { kind: "sample", events: demoCalendarEvents().slice(0, opts.max) };
    }
    return { kind: "data", events: [], errors: [] };
  }

  const errors: AccountError[] = [];
  const all: CalendarEvent[] = [];
  let successes = 0;

  const tasks: Promise<void>[] = [];
  for (const account of wantGoogle) {
    const label = account.email ?? "Google Calendar";
    tasks.push(
      fetchGoogleCalendarEvents(userId, {
        accountId: account.id,
        accountLabel: label,
        daysAhead: opts.days,
        max: opts.max,
        fresh: opts.fresh,
      })
        .then((events) => {
          successes += 1;
          all.push(...events);
        })
        .catch((err) => {
          logger.warn(
            { reason: normalizeHttpError(err), account: label },
            "Google Calendar fetch failed",
          );
          errors.push({ account: label, message: errMessage(err) });
        }),
    );
  }
  for (const account of wantCalDav) {
    tasks.push(
      fetchCalDavEvents(account, { daysAhead: opts.days, max: opts.max, fresh: opts.fresh })
        .then((events) => {
          successes += 1;
          all.push(...events);
        })
        .catch((err) => {
          logger.warn(
            { reason: normalizeHttpError(err), account: account.label },
            "CalDAV fetch failed",
          );
          errors.push({ account: account.label, message: errMessage(err) });
        }),
    );
  }
  await Promise.all(tasks);

  if (successes === 0) return { kind: "all-failed", errors };

  all.sort((a, b) => (a.start < b.start ? -1 : 1));
  return { kind: "data", events: all.slice(0, opts.max), errors };
}

async function handleCalendarRequest(
  userId: number,
  req: { query: Record<string, unknown> },
  res: { json: (b: unknown) => void; status: (c: number) => { json: (b: unknown) => void } },
  include: "all" | "google" | "caldav",
): Promise<void> {
  const accountsRaw = typeof req.query["accounts"] === "string" ? req.query["accounts"] : "";
  const accountsFilter = accountsRaw
    ? accountsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const days = clampInt(req.query["days"], CALENDAR_DAYS_DEFAULT, CALENDAR_DAYS_CAP);
  const max = clampInt(req.query["max"], CALENDAR_MAX_DEFAULT, CALENDAR_MAX_CAP);
  // fresh=true bypasses the short server-side fetch cache (manual tile
  // refresh); background polling omits it and keeps hitting the cache.
  const fresh = req.query["fresh"] === "true";

  try {
    const result = await collectCalendar(userId, { accountsFilter, days, max, include, fresh });
    if (result.kind === "sample") {
      res.json({ events: result.events, errors: null, sample: true });
      return;
    }
    if (result.kind === "all-failed") {
      res.status(502).json({ error: "All configured calendar accounts failed to respond" });
      return;
    }
    res.json({
      events: result.events,
      errors: result.errors.length > 0 ? result.errors : null,
      sample: false,
    });
  } catch (err) {
    logger.error({ reason: normalizeHttpError(err) }, "Calendar widget error");
    res.status(502).json({ error: "Failed to fetch calendar events" });
  }
}

// GET /api/widgets/calendar/events — aggregated upcoming events across accounts.
router.get("/calendar/events", requireAuth, async (req: AuthRequest, res) => {
  await handleCalendarRequest(req.user!.userId, req, res, "all");
});

// Per-provider variants (same shape, narrowed to one provider).
router.get("/calendar/google", requireAuth, async (req: AuthRequest, res) => {
  await handleCalendarRequest(req.user!.userId, req, res, "google");
});
router.get("/calendar/caldav", requireAuth, async (req: AuthRequest, res) => {
  await handleCalendarRequest(req.user!.userId, req, res, "caldav");
});

// ── AI Chat widget ───────────────────────────────────────────────────────────
// Proxies chat requests from an AI Chat tile to the provider that backs the
// tile's selected account. All provider calls happen server-side (the API key
// never reaches the browser) over the TLS-verifying cloud client. Following
// the widget convention: demo/sample data only when nothing is configured; a
// configured account that fails answers 502 with an explicit error.

const AI_MAX_MESSAGES = 40;
const AI_MAX_CONTENT = 8000;

// Streaming responses are NDJSON over a chunked HTTP response: one JSON
// object per line — {"delta":"…"} for each piece of reply text, then a final
// {"done":true,"model":"…","sample":…} (or {"error":"…"} if the provider
// fails, since the 200 status is already committed by then).
function beginNdjsonStream(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  // Defeat proxy buffering so tokens reach the browser as they're produced.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function writeNdjson(res: Response, obj: unknown): void {
  res.write(JSON.stringify(obj) + "\n");
}

// POST /api/widgets/ai/chat — { accountId, model?, messages: [{role, content}], stream? }
router.post("/ai/chat", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const body = (req.body ?? {}) as {
    accountId?: unknown;
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
  };
  const wantStream = body.stream === true;

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMessage[] = rawMessages
    .filter(
      (m): m is { role: string; content: string } =>
        !!m &&
        typeof m === "object" &&
        ((m as { role?: unknown }).role === "user" ||
          (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string" &&
        ((m as { content: string }).content.trim().length > 0),
    )
    .slice(-AI_MAX_MESSAGES)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content.slice(0, AI_MAX_CONTENT),
    }));
  if (messages.length === 0) {
    res.status(400).json({ error: "messages must contain at least one user message" });
    return;
  }

  // No accounts configured at all → demo reply so the tile can show its
  // sample conversation without a key (sample:true tells the tile).
  if (listAiAccounts(userId).length === 0) {
    const demoReply =
      "This is a demo reply — add an AI account (OpenAI, Gemini, Claude, or a local server like Ollama) in Settings, then pick it in this tile's settings to chat for real.";
    if (wantStream) {
      beginNdjsonStream(res);
      writeNdjson(res, { delta: demoReply });
      writeNdjson(res, { done: true, sample: true, model: "demo" });
      res.end();
      return;
    }
    res.json({ sample: true, reply: demoReply, model: "demo" });
    return;
  }

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const account = accountId ? getAiAccount(userId, accountId) : null;
  if (!account) {
    res.status(404).json({ error: "Unknown AI account — pick one in the tile settings" });
    return;
  }

  const model = resolveModel(account, typeof body.model === "string" ? body.model : null);
  // Local servers (Ollama, LM Studio…) have no universal default model — the
  // user must pick one in the account or tile settings.
  if (!model) {
    res.status(400).json({
      error:
        "No model selected — set a default model on this AI account in Settings or pick one in the tile options.",
    });
    return;
  }
  try {
    if (wantStream) {
      // The 200 + headers are committed as soon as the first delta arrives,
      // so provider failures after that point are reported in-band as a
      // final {"error"} line instead of a 502.
      let started = false;
      // If the browser disconnects (user hit Stop or navigated away), tear
      // down the upstream provider request so tokens stop being generated.
      // (Watch res "close", not req "close" — req fires once the request
      // body is consumed. res "close" fires when the connection goes away;
      // the writableEnded guard skips the normal end-of-response case.)
      const upstream = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) upstream.abort();
      });
      try {
        await aiChatStream(
          account,
          model,
          messages,
          (delta) => {
            if (!started) {
              beginNdjsonStream(res);
              started = true;
            }
            writeNdjson(res, { delta });
          },
          upstream.signal,
        );
        if (!started) beginNdjsonStream(res);
        writeNdjson(res, { done: true, sample: false, model });
        res.end();
      } catch (err) {
        // Client-initiated abort: nobody is listening, just clean up quietly.
        if (upstream.signal.aborted) {
          logger.debug(
            { provider: account.provider, model },
            "AI chat stream aborted by client disconnect",
          );
          res.end();
          return;
        }
        if (!started) throw err; // headers not sent yet → normal 502 below
        const detail = describeHttpError(err);
        logger.error(
          { reason: detail, provider: account.provider, model },
          "AI chat stream error (mid-stream)",
        );
        writeNdjson(res, { error: `AI request failed: ${aiErrorHint(detail.status, model, account.provider)}` });
        res.end();
      }
      return;
    }
    const reply = await aiChat(account, model, messages);
    res.json({ sample: false, reply, model });
  } catch (err) {
    const detail = describeHttpError(err);
    logger.error(
      { reason: detail, provider: account.provider, model },
      "AI chat widget error",
    );
    res
      .status(502)
      .json({ error: `AI request failed: ${aiErrorHint(detail.status, model, account.provider)}` });
  }
});

function aiErrorHint(status: number | null, model: string, provider: string): string {
  return status === 401 || status === 403
    ? "The API key was rejected — check it in Settings."
    : status === 429
      ? "Rate limit or quota exceeded for this account."
      : status === 404 || status === 400
        ? `The model "${model}" was rejected by ${provider}.`
        : "The provider did not respond.";
}

// GET /api/widgets/ai/models?accountId=… — model options for the tile editor's
// override picker. Falls back to a static per-provider list when the live
// endpoint fails, so this never 502s.
router.get("/ai/models", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const accountId = typeof req.query["accountId"] === "string" ? req.query["accountId"] : "";
  const account = accountId ? getAiAccount(userId, accountId) : null;
  if (!account) {
    res.status(404).json({ error: "Unknown AI account" });
    return;
  }
  const { models, live } = await aiListModels(account);
  res.json({ provider: account.provider, models, live, default: account.model ?? null });
});

// Helpers may reject legacy stored/env configuration before a handler's
// upstream try/catch. Return a safe JSON error, not Express's HTML stack page.
const serviceUrlErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof InvalidServiceBaseUrlError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
};
router.use(serviceUrlErrorHandler);

export default router;
