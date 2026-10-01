// Live player-count lookups for game servers.
//
// Pterodactyl's client API exposes power state and resource usage but NOT how
// many players are connected — that information only exists inside each game's
// own query protocol (Minecraft server-list ping, Steam A2S, etc.). Gamedig
// speaks those protocols, so we guess which game a server runs from the panel
// metadata (name, startup invocation, docker image) and query the server's
// public allocation directly. Everything here is best-effort and additive: any
// failure yields a structured reason (never a throw) so the widget can tell
// the user WHY a player count is missing instead of silently hiding it.
import { GameDig } from "gamedig";
import { logger } from "./logger.js";
import { resolvePublicHost, validateOutboundPort } from "./outboundTargets.js";
import { UnsafeUrlError } from "./http.js";
import { queryHttpGamePlayers } from "./httpGameQuery.js";

export interface PlayerCount {
  current: number;
  max: number | null;
}

// Why a player count could not be produced for a running server.
// - unknown-game: panel metadata didn't match any known game keyword
// - no-allocation: the server has no usable public host/port allocation
// - timeout: the query got no response before the deadline (closed/filtered
//   query port, or the game doesn't answer that protocol)
// - unreachable: the host could not be resolved or the connection was refused
export type PlayerQueryFailure =
  | "unknown-game"
  | "no-allocation"
  | "timeout"
  | "unreachable";

export type PlayerQueryResult =
  | { players: PlayerCount; reason: null; detail?: undefined }
  | { players: null; reason: Exclude<PlayerQueryFailure, "unknown-game" | "no-allocation">; detail: string };

// Ordered keyword → gamedig type table. First match wins, so more specific
// patterns (cs2) must precede broader ones (counter-strike). The port offset
// covers games whose query port differs from the game port by convention
// (Valheim answers Steam queries on game port + 1).
const GAME_KEYWORDS: Array<{ re: RegExp; type: string; portOffset: number }> = [
  { re: /minecraft|paper|spigot|purpur|fabric|forge|bukkit|bedrock|velocity|waterfall|bungee/, type: "minecraft", portOffset: 0 },
  { re: /valheim/, type: "valheim", portOffset: 1 },
  { re: /palworld/, type: "palworld", portOffset: 0 },
  { re: /\brust\b/, type: "rust", portOffset: 0 },
  { re: /\bark\b|survival evolved|survival ascended/, type: "arkse", portOffset: 0 },
  { re: /counter.?strike ?2|\bcs2\b/, type: "counterstrike2", portOffset: 0 },
  { re: /csgo|counter.?strike/, type: "csgo", portOffset: 0 },
  { re: /7 ?days? to die|7d2d/, type: "sdtd", portOffset: 0 },
  { re: /zomboid/, type: "projectzomboid", portOffset: 0 },
  { re: /satisfactory/, type: "satisfactory", portOffset: 0 },
  { re: /factorio/, type: "factorio", portOffset: 0 },
  { re: /garry'?s ?mod|\bgmod\b/, type: "garrysmod", portOffset: 0 },
  { re: /enshrouded/, type: "enshrouded", portOffset: 0 },
  { re: /v ?rising/, type: "vrising", portOffset: 0 },
  { re: /team ?fortress|\btf2\b/, type: "teamfortress2", portOffset: 0 },
  { re: /unturned/, type: "unturned", portOffset: 0 },
  { re: /\bdayz\b/, type: "dayz", portOffset: 0 },
  { re: /conan ?exiles/, type: "conanexiles", portOffset: 0 },
  { re: /\bsquad\b/, type: "squad", portOffset: 0 },
  { re: /mordhau/, type: "mordhau", portOffset: 0 },
  { re: /barotrauma/, type: "barotrauma", portOffset: 0 },
  { re: /starbound/, type: "starbound", portOffset: 0 },
  { re: /don'?t ?starve|\bdst\b/, type: "dontstarve", portOffset: 0 },
  { re: /sons ?of ?the ?forest/, type: "sonsoftheforest", portOffset: 0 },
  { re: /the ?forest/, type: "theforest", portOffset: 0 },
  { re: /arma ?3/, type: "arma3", portOffset: 1 },
  { re: /insurgency/, type: "insurgencysandstorm", portOffset: 0 },
  { re: /killing ?floor ?2|\bkf2\b/, type: "killingfloor2", portOffset: 0 },
  { re: /left ?4 ?dead ?2|\bl4d2\b/, type: "left4dead2", portOffset: 0 },
  { re: /quake ?3|q3a/, type: "quake3", portOffset: 0 },
  { re: /\beco\b/, type: "eco", portOffset: 0 },
];

// Guess the gamedig game type from free-form panel metadata. Returns null when
// nothing matches — the caller then reports "unknown-game".
export function guessGameType(hints: string): { type: string; portOffset: number } | null {
  const h = hints.toLowerCase();
  for (const g of GAME_KEYWORDS) if (g.re.test(h)) return { type: g.type, portOffset: g.portOffset };
  // A java + .jar startup command is almost always a Minecraft-family server
  // even when the server name doesn't say so ("SMP", "Lobby", …).
  if (h.includes("java") && h.includes(".jar")) return { type: "minecraft", portOffset: 0 };
  return null;
}

// Classify a gamedig failure into a compact reason. Gamedig wraps most
// failures into "Failed all N attempts" with the underlying cause appended,
// so we look for the usual network-error markers anywhere in the message.
function classifyQueryError(message: string): "timeout" | "unreachable" {
  const m = message.toLowerCase();
  if (/enotfound|eai_again|econnrefused|ehostunreach|enetunreach|eaddrnotavail/.test(m)) {
    return "unreachable";
  }
  // Timeouts (and "no response" style failures) are the default: the packet
  // went out but nothing came back — closed query port or wrong protocol.
  return "timeout";
}

// Query one game server for its player count. Never throws; failures come
// back as a structured reason + the raw error detail for diagnostics.
export async function queryGamePlayersDetailed(
  type: string,
  host: string,
  port: number,
): Promise<PlayerQueryResult> {
  try {
    // Do not expose arbitrary GameDig protocols with their own network paths.
    if (!GAME_KEYWORDS.some((game) => game.type === type)) {
      throw new UnsafeUrlError("Unsupported game query protocol.");
    }
    validateOutboundPort(port);
    const target = await resolvePublicHost(host);
    const state = ["eco", "factorio", "satisfactory", "palworld"].includes(type)
      ? await queryHttpGamePlayers(type, type === "factorio" ? target.address : target.host, port)
      : await GameDig.query({
      type,
      host: target.host,
      // Explicit address bypasses GameDig DNS and Minecraft SRV discovery.
      // Every protocol's socket uses this pinned, already-validated IP.
      address: target.address,
      port,
      // Query-port offsets/fallbacks stay on this same validated address.
      givenPortOnly: false,
      socketTimeout: 2000,
      attemptTimeout: 4000,
      maxRetries: 1,
      // Accept legacy gamedig type ids too, in case of renames across versions.
      checkOldIDs: true,
    });
    const current =
      typeof state.numplayers === "number"
        ? state.numplayers
        : "players" in state && Array.isArray(state.players)
          ? state.players.length
          : null;
    if (current == null) {
      return { players: null, reason: "timeout", detail: "query succeeded but reported no player count" };
    }
    const max =
      typeof state.maxplayers === "number" && state.maxplayers > 0 ? state.maxplayers : null;
    return { players: { current, max }, reason: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.debug({ type, host, port, reason: detail }, "Game server player query failed");
    return { players: null, reason: err instanceof UnsafeUrlError ? "unreachable" : classifyQueryError(detail), detail };
  }
}

// Back-compat convenience wrapper: player count or null.
export async function queryGamePlayers(
  type: string,
  host: string,
  port: number,
): Promise<PlayerCount | null> {
  return (await queryGamePlayersDetailed(type, host, port)).players;
}
