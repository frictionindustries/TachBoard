import { Router } from "express";
import { db, tileStmts, pageStmts, deviceModeStmts, defaultDeviceModeId, type DbTile } from "../lib/db.js";
import { requireAuth, type AuthRequest } from "../lib/auth.js";

const router = Router();

// Parse the stored metrics JSON blob into a string[] (or null = "show all").
// Tolerates legacy/garbage values by falling back to null.
function parseMetrics(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    return null;
  } catch {
    return null;
  }
}

// Serialize an incoming metrics value to a JSON blob (or null). Anything that
// isn't an array of strings is stored as null ("show all").
function serializeMetrics(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const keys = value.filter((x): x is string => typeof x === "string");
  return JSON.stringify(keys);
}

// Per-integration extra config. Currently only carries the qBittorrent
// category filter, but the column is a generic JSON object so future
// integrations can stash their own keys here.
interface TileSettings {
  categoryFilter?: string[] | null;
  groupByCategory?: boolean | null;
  clockFormat?: "12" | "24" | null;
  clockShowSeconds?: boolean | null;
  clockShowDate?: boolean | null;
  weatherAutoLocate?: boolean | null;
  weatherLocation?: string | null;
  weatherUnits?: "c" | "f" | null;
  sportsLeagues?: string[] | null;
  sportsTeams?: string[] | null;
  sportsShowScores?: boolean | null;
  sportsShowNews?: boolean | null;
  newsFeedUrl?: string | null;
  newsMaxItems?: number | null;
  newsShowTimestamp?: boolean | null;
  stockWatchlist?: StockWatchEntry[] | null;
  sleeperUsername?: string | null;
  sleeperLeagueId?: string | null;
  sleeperSport?: string | null;
  sleeperSeason?: string | null;
  sleeperShowMatchup?: boolean | null;
  sleeperShowStandings?: boolean | null;
  sleeperShowTransactions?: boolean | null;
  emailAccounts?: string[] | null;
  emailMaxMessages?: number | null;
  emailUnreadOnly?: boolean | null;
  calendarAccounts?: string[] | null;
  calendarDaysAhead?: number | null;
  calendarMaxEvents?: number | null;
  aiAccountId?: string | null;
  aiModel?: string | null;
  audioSource?: string | null;
  audioFindMusic?: boolean | null;
  audioSearch?: boolean | null;
  audioBrowse?: boolean | null;
  audioPlaylists?: boolean | null;
  openExpanded?: boolean | null;
  scrollable?: boolean | null;
  hideStatusDot?: boolean | null;
  noteBody?: string | null;
  noteItems?: NoteChecklistItem[] | null;
  noteColor?: string | null;
  noteFontSize?: "sm" | "md" | "lg" | null;
  noteTextColor?: string | null;
  timerMode?: "countup" | "countdown" | "pomodoro" | null;
  timerDuration?: number | null;
  timerRunning?: boolean | null;
  timerStartedAt?: number | null;
  timerAccumulatedMs?: number | null;
  pomodoroFocusMinutes?: number | null;
  pomodoroShortBreakMinutes?: number | null;
  pomodoroLongBreakMinutes?: number | null;
  pomodoroSessionsBeforeLongBreak?: number | null;
  pomodoroPhase?: "focus" | "shortBreak" | "longBreak" | null;
  pomodoroCompletedSessions?: number | null;
  timerAlertEnabled?: boolean | null;
  timerAlertSound?: "chime" | "bell" | "beep" | "digital" | "none" | null;
  diceType?: string | null;
  diceCount?: number | null;
  petHunger?: number | null;
  petHappiness?: number | null;
  petEnergy?: number | null;
  petUpdatedAt?: number | null;
  petBodyColor?: string | null;
  petEyes?: string | null;
  petNose?: string | null;
  petMouth?: string | null;
  bonsaiHydration?: number | null;
  bonsaiOvergrowth?: number | null;
  bonsaiGrowth?: number | null;
  bonsaiUpdatedAt?: number | null;
  bonsaiPotColor?: string | null;
  bonsaiLeafColor?: string | null;
  bonsaiBlossom?: string | null;
  bonsaiStyle?: string | null;
  aquariumFishTypes?: string[] | null;
  aquariumSandColor?: string | null;
  aquariumProps?: string[] | null;
  visualizerStyle?: string | null;
  visualizerPrimary?: string | null;
  visualizerBackground?: string | null;
  photoSource?: "uploads" | "urls" | "google" | "immich" | null;
  photoUploadUrls?: string[] | null;
  photoUrls?: string[] | null;
  photoAlbumId?: string | null;
  photoInterval?: number | null;
  photoFit?: "cover" | "contain" | null;
  frameStyle?: "none" | "wood" | "thin" | "gold" | "polaroid" | "custom" | null;
  frameColor?: string | null;
  frameWidth?: number | null;
  videoSource?: string | null;
  videoUploadUrls?: string[] | null;
  videoUrls?: string[] | null;
  videoYoutubeUrl?: string | null;
  videoLibraryId?: string | null;
  videoErsatzChannel?: string | null;
  videoPlayMode?: "single" | "playlist" | null;
  videoPlaylistLoop?: boolean | null;
  videoShuffle?: boolean | null;
  videoMuted?: boolean | null;
  videoPageSwitchMute?: boolean | null;
  videoFit?: "cover" | "contain" | null;
  truenasMetric?: "cpuram" | "network" | "arc" | "pools" | "disks" | "cputemp" | null;
  truenasShowCpuCores?: boolean | null;
  truenasPools?: string[] | null;
  pterodactylServers?: string[] | null;
  truenasPoolOrder?: string[] | null;
}

// A single checklist/to-do item on a Note (post-it) tile: its label text and
// whether it has been ticked off (rendered with a strike-through).
interface NoteChecklistItem {
  text: string;
  done: boolean;
}

// Validate/clean a single checklist item. Returns null when there is no usable
// text so callers can drop garbage rows.
function pickNoteChecklistItem(raw: unknown): NoteChecklistItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["text"] !== "string") return null;
  return { text: obj["text"], done: obj["done"] === true };
}

// A single watchlist entry for the Stocks tile: a ticker symbol plus optional
// share quantity and average cost basis (which turn the watchlist into a
// lightweight portfolio).
interface StockWatchEntry {
  symbol: string;
  shares?: number | null;
  costBasis?: number | null;
}

// Validate/clean a single watchlist entry. Returns null when there is no usable
// symbol so callers can drop garbage rows.
function pickStockWatchEntry(raw: unknown): StockWatchEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const symbol = typeof obj["symbol"] === "string" ? obj["symbol"].trim().toUpperCase() : "";
  if (!symbol) return null;
  const entry: StockWatchEntry = { symbol };
  if (typeof obj["shares"] === "number" && Number.isFinite(obj["shares"])) {
    entry.shares = obj["shares"];
  } else if (obj["shares"] === null) {
    entry.shares = null;
  }
  if (typeof obj["costBasis"] === "number" && Number.isFinite(obj["costBasis"])) {
    entry.costBasis = obj["costBasis"];
  } else if (obj["costBasis"] === null) {
    entry.costBasis = null;
  }
  return entry;
}

// Copy the known keys of a tile-settings object into a clean TileSettings,
// dropping anything unrecognized. Shared by parse (from DB) and serialize (from
// request body) so both honor exactly the same allow-list.
function pickTileSettings(obj: Record<string, unknown>): TileSettings {
  const result: TileSettings = {};
  if (Array.isArray(obj["categoryFilter"])) {
    result.categoryFilter = obj["categoryFilter"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["categoryFilter"] === null) {
    result.categoryFilter = null;
  }
  if (typeof obj["groupByCategory"] === "boolean") {
    result.groupByCategory = obj["groupByCategory"];
  } else if (obj["groupByCategory"] === null) {
    result.groupByCategory = null;
  }
  if (obj["clockFormat"] === "12" || obj["clockFormat"] === "24") {
    result.clockFormat = obj["clockFormat"];
  } else if (obj["clockFormat"] === null) {
    result.clockFormat = null;
  }
  if (typeof obj["clockShowSeconds"] === "boolean") {
    result.clockShowSeconds = obj["clockShowSeconds"];
  } else if (obj["clockShowSeconds"] === null) {
    result.clockShowSeconds = null;
  }
  if (typeof obj["clockShowDate"] === "boolean") {
    result.clockShowDate = obj["clockShowDate"];
  } else if (obj["clockShowDate"] === null) {
    result.clockShowDate = null;
  }
  if (typeof obj["weatherAutoLocate"] === "boolean") {
    result.weatherAutoLocate = obj["weatherAutoLocate"];
  } else if (obj["weatherAutoLocate"] === null) {
    result.weatherAutoLocate = null;
  }
  if (typeof obj["weatherLocation"] === "string") {
    result.weatherLocation = obj["weatherLocation"];
  } else if (obj["weatherLocation"] === null) {
    result.weatherLocation = null;
  }
  if (obj["weatherUnits"] === "c" || obj["weatherUnits"] === "f") {
    result.weatherUnits = obj["weatherUnits"];
  } else if (obj["weatherUnits"] === null) {
    result.weatherUnits = null;
  }
  if (Array.isArray(obj["sportsLeagues"])) {
    result.sportsLeagues = obj["sportsLeagues"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["sportsLeagues"] === null) {
    result.sportsLeagues = null;
  }
  if (Array.isArray(obj["sportsTeams"])) {
    result.sportsTeams = obj["sportsTeams"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["sportsTeams"] === null) {
    result.sportsTeams = null;
  }
  if (typeof obj["sportsShowScores"] === "boolean") {
    result.sportsShowScores = obj["sportsShowScores"];
  } else if (obj["sportsShowScores"] === null) {
    result.sportsShowScores = null;
  }
  if (typeof obj["sportsShowNews"] === "boolean") {
    result.sportsShowNews = obj["sportsShowNews"];
  } else if (obj["sportsShowNews"] === null) {
    result.sportsShowNews = null;
  }
  if (typeof obj["newsFeedUrl"] === "string") {
    result.newsFeedUrl = obj["newsFeedUrl"];
  } else if (obj["newsFeedUrl"] === null) {
    result.newsFeedUrl = null;
  }
  if (typeof obj["newsMaxItems"] === "number") {
    result.newsMaxItems = obj["newsMaxItems"];
  } else if (obj["newsMaxItems"] === null) {
    result.newsMaxItems = null;
  }
  if (typeof obj["newsShowTimestamp"] === "boolean") {
    result.newsShowTimestamp = obj["newsShowTimestamp"];
  } else if (obj["newsShowTimestamp"] === null) {
    result.newsShowTimestamp = null;
  }
  if (Array.isArray(obj["stockWatchlist"])) {
    result.stockWatchlist = obj["stockWatchlist"]
      .map(pickStockWatchEntry)
      .filter((e): e is StockWatchEntry => e !== null);
  } else if (obj["stockWatchlist"] === null) {
    result.stockWatchlist = null;
  }
  if (typeof obj["sleeperUsername"] === "string") {
    result.sleeperUsername = obj["sleeperUsername"];
  } else if (obj["sleeperUsername"] === null) {
    result.sleeperUsername = null;
  }
  if (typeof obj["sleeperLeagueId"] === "string") {
    result.sleeperLeagueId = obj["sleeperLeagueId"];
  } else if (obj["sleeperLeagueId"] === null) {
    result.sleeperLeagueId = null;
  }
  if (typeof obj["sleeperSport"] === "string") {
    result.sleeperSport = obj["sleeperSport"];
  } else if (obj["sleeperSport"] === null) {
    result.sleeperSport = null;
  }
  if (typeof obj["sleeperSeason"] === "string") {
    result.sleeperSeason = obj["sleeperSeason"];
  } else if (obj["sleeperSeason"] === null) {
    result.sleeperSeason = null;
  }
  if (typeof obj["sleeperShowMatchup"] === "boolean") {
    result.sleeperShowMatchup = obj["sleeperShowMatchup"];
  } else if (obj["sleeperShowMatchup"] === null) {
    result.sleeperShowMatchup = null;
  }
  if (typeof obj["sleeperShowStandings"] === "boolean") {
    result.sleeperShowStandings = obj["sleeperShowStandings"];
  } else if (obj["sleeperShowStandings"] === null) {
    result.sleeperShowStandings = null;
  }
  if (typeof obj["sleeperShowTransactions"] === "boolean") {
    result.sleeperShowTransactions = obj["sleeperShowTransactions"];
  } else if (obj["sleeperShowTransactions"] === null) {
    result.sleeperShowTransactions = null;
  }
  if (Array.isArray(obj["emailAccounts"])) {
    result.emailAccounts = obj["emailAccounts"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["emailAccounts"] === null) {
    result.emailAccounts = null;
  }
  if (typeof obj["emailMaxMessages"] === "number") {
    result.emailMaxMessages = obj["emailMaxMessages"];
  } else if (obj["emailMaxMessages"] === null) {
    result.emailMaxMessages = null;
  }
  if (typeof obj["emailUnreadOnly"] === "boolean") {
    result.emailUnreadOnly = obj["emailUnreadOnly"];
  } else if (obj["emailUnreadOnly"] === null) {
    result.emailUnreadOnly = null;
  }
  if (Array.isArray(obj["calendarAccounts"])) {
    result.calendarAccounts = obj["calendarAccounts"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["calendarAccounts"] === null) {
    result.calendarAccounts = null;
  }
  if (typeof obj["calendarDaysAhead"] === "number") {
    result.calendarDaysAhead = obj["calendarDaysAhead"];
  } else if (obj["calendarDaysAhead"] === null) {
    result.calendarDaysAhead = null;
  }
  if (typeof obj["calendarMaxEvents"] === "number") {
    result.calendarMaxEvents = obj["calendarMaxEvents"];
  } else if (obj["calendarMaxEvents"] === null) {
    result.calendarMaxEvents = null;
  }
  if (typeof obj["aiAccountId"] === "string") {
    result.aiAccountId = obj["aiAccountId"];
  } else if (obj["aiAccountId"] === null) {
    result.aiAccountId = null;
  }
  if (typeof obj["aiModel"] === "string") {
    result.aiModel = obj["aiModel"];
  } else if (obj["aiModel"] === null) {
    result.aiModel = null;
  }
  if (typeof obj["audioSource"] === "string") {
    result.audioSource = obj["audioSource"];
  } else if (obj["audioSource"] === null) {
    result.audioSource = null;
  }
  if (typeof obj["audioFindMusic"] === "boolean") {
    result.audioFindMusic = obj["audioFindMusic"];
  } else if (obj["audioFindMusic"] === null) {
    result.audioFindMusic = null;
  }
  if (typeof obj["audioSearch"] === "boolean") {
    result.audioSearch = obj["audioSearch"];
  } else if (obj["audioSearch"] === null) {
    result.audioSearch = null;
  }
  if (typeof obj["audioBrowse"] === "boolean") {
    result.audioBrowse = obj["audioBrowse"];
  } else if (obj["audioBrowse"] === null) {
    result.audioBrowse = null;
  }
  if (typeof obj["audioPlaylists"] === "boolean") {
    result.audioPlaylists = obj["audioPlaylists"];
  } else if (obj["audioPlaylists"] === null) {
    result.audioPlaylists = null;
  }
  if (typeof obj["openExpanded"] === "boolean") {
    result.openExpanded = obj["openExpanded"];
  } else if (obj["openExpanded"] === null) {
    result.openExpanded = null;
  }
  if (typeof obj["scrollable"] === "boolean") {
    result.scrollable = obj["scrollable"];
  } else if (obj["scrollable"] === null) {
    result.scrollable = null;
  }
  if (typeof obj["hideStatusDot"] === "boolean") {
    result.hideStatusDot = obj["hideStatusDot"];
  } else if (obj["hideStatusDot"] === null) {
    result.hideStatusDot = null;
  }
  if (
    obj["truenasMetric"] === "cpuram" ||
    obj["truenasMetric"] === "network" ||
    obj["truenasMetric"] === "arc" ||
    obj["truenasMetric"] === "pools" ||
    obj["truenasMetric"] === "disks" ||
    obj["truenasMetric"] === "cputemp"
  ) {
    result.truenasMetric = obj["truenasMetric"];
  } else if (obj["truenasMetric"] === null) {
    result.truenasMetric = null;
  }
  if (typeof obj["truenasShowCpuCores"] === "boolean") {
    result.truenasShowCpuCores = obj["truenasShowCpuCores"];
  } else if (obj["truenasShowCpuCores"] === null) {
    result.truenasShowCpuCores = null;
  }
  if (Array.isArray(obj["truenasPools"])) {
    result.truenasPools = obj["truenasPools"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["truenasPools"] === null) {
    result.truenasPools = null;
  }
  if (Array.isArray(obj["pterodactylServers"])) {
    result.pterodactylServers = obj["pterodactylServers"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["pterodactylServers"] === null) {
    result.pterodactylServers = null;
  }
  if (Array.isArray(obj["truenasPoolOrder"])) {
    result.truenasPoolOrder = obj["truenasPoolOrder"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["truenasPoolOrder"] === null) {
    result.truenasPoolOrder = null;
  }
  if (typeof obj["noteBody"] === "string") {
    result.noteBody = obj["noteBody"];
  } else if (obj["noteBody"] === null) {
    result.noteBody = null;
  }
  if (Array.isArray(obj["noteItems"])) {
    result.noteItems = obj["noteItems"]
      .map(pickNoteChecklistItem)
      .filter((e): e is NoteChecklistItem => e !== null);
  } else if (obj["noteItems"] === null) {
    result.noteItems = null;
  }
  if (typeof obj["noteColor"] === "string") {
    result.noteColor = obj["noteColor"];
  } else if (obj["noteColor"] === null) {
    result.noteColor = null;
  }
  if (obj["noteFontSize"] === "sm" || obj["noteFontSize"] === "md" || obj["noteFontSize"] === "lg") {
    result.noteFontSize = obj["noteFontSize"];
  } else if (obj["noteFontSize"] === null) {
    result.noteFontSize = null;
  }
  if (typeof obj["noteTextColor"] === "string") {
    result.noteTextColor = obj["noteTextColor"];
  } else if (obj["noteTextColor"] === null) {
    result.noteTextColor = null;
  }
  if (
    obj["timerMode"] === "countup" ||
    obj["timerMode"] === "countdown" ||
    obj["timerMode"] === "pomodoro"
  ) {
    result.timerMode = obj["timerMode"];
  } else if (obj["timerMode"] === null) {
    result.timerMode = null;
  }
  if (typeof obj["timerDuration"] === "number") {
    result.timerDuration = obj["timerDuration"];
  } else if (obj["timerDuration"] === null) {
    result.timerDuration = null;
  }
  if (typeof obj["timerRunning"] === "boolean") {
    result.timerRunning = obj["timerRunning"];
  } else if (obj["timerRunning"] === null) {
    result.timerRunning = null;
  }
  if (typeof obj["timerStartedAt"] === "number") {
    result.timerStartedAt = obj["timerStartedAt"];
  } else if (obj["timerStartedAt"] === null) {
    result.timerStartedAt = null;
  }
  if (typeof obj["timerAccumulatedMs"] === "number") {
    result.timerAccumulatedMs = obj["timerAccumulatedMs"];
  } else if (obj["timerAccumulatedMs"] === null) {
    result.timerAccumulatedMs = null;
  }
  if (typeof obj["pomodoroFocusMinutes"] === "number") {
    result.pomodoroFocusMinutes = obj["pomodoroFocusMinutes"];
  } else if (obj["pomodoroFocusMinutes"] === null) {
    result.pomodoroFocusMinutes = null;
  }
  if (typeof obj["pomodoroShortBreakMinutes"] === "number") {
    result.pomodoroShortBreakMinutes = obj["pomodoroShortBreakMinutes"];
  } else if (obj["pomodoroShortBreakMinutes"] === null) {
    result.pomodoroShortBreakMinutes = null;
  }
  if (typeof obj["pomodoroLongBreakMinutes"] === "number") {
    result.pomodoroLongBreakMinutes = obj["pomodoroLongBreakMinutes"];
  } else if (obj["pomodoroLongBreakMinutes"] === null) {
    result.pomodoroLongBreakMinutes = null;
  }
  if (typeof obj["pomodoroSessionsBeforeLongBreak"] === "number") {
    result.pomodoroSessionsBeforeLongBreak = obj["pomodoroSessionsBeforeLongBreak"];
  } else if (obj["pomodoroSessionsBeforeLongBreak"] === null) {
    result.pomodoroSessionsBeforeLongBreak = null;
  }
  if (
    obj["pomodoroPhase"] === "focus" ||
    obj["pomodoroPhase"] === "shortBreak" ||
    obj["pomodoroPhase"] === "longBreak"
  ) {
    result.pomodoroPhase = obj["pomodoroPhase"];
  } else if (obj["pomodoroPhase"] === null) {
    result.pomodoroPhase = null;
  }
  if (typeof obj["pomodoroCompletedSessions"] === "number") {
    result.pomodoroCompletedSessions = obj["pomodoroCompletedSessions"];
  } else if (obj["pomodoroCompletedSessions"] === null) {
    result.pomodoroCompletedSessions = null;
  }
  if (typeof obj["timerAlertEnabled"] === "boolean") {
    result.timerAlertEnabled = obj["timerAlertEnabled"];
  } else if (obj["timerAlertEnabled"] === null) {
    result.timerAlertEnabled = null;
  }
  if (
    obj["timerAlertSound"] === "chime" ||
    obj["timerAlertSound"] === "bell" ||
    obj["timerAlertSound"] === "beep" ||
    obj["timerAlertSound"] === "digital" ||
    obj["timerAlertSound"] === "none"
  ) {
    result.timerAlertSound = obj["timerAlertSound"];
  } else if (obj["timerAlertSound"] === null) {
    result.timerAlertSound = null;
  }
  if (typeof obj["diceType"] === "string") {
    result.diceType = obj["diceType"];
  } else if (obj["diceType"] === null) {
    result.diceType = null;
  }
  if (typeof obj["diceCount"] === "number") {
    result.diceCount = obj["diceCount"];
  } else if (obj["diceCount"] === null) {
    result.diceCount = null;
  }
  if (typeof obj["petHunger"] === "number") {
    result.petHunger = obj["petHunger"];
  } else if (obj["petHunger"] === null) {
    result.petHunger = null;
  }
  if (typeof obj["petHappiness"] === "number") {
    result.petHappiness = obj["petHappiness"];
  } else if (obj["petHappiness"] === null) {
    result.petHappiness = null;
  }
  if (typeof obj["petEnergy"] === "number") {
    result.petEnergy = obj["petEnergy"];
  } else if (obj["petEnergy"] === null) {
    result.petEnergy = null;
  }
  if (typeof obj["petUpdatedAt"] === "number") {
    result.petUpdatedAt = obj["petUpdatedAt"];
  } else if (obj["petUpdatedAt"] === null) {
    result.petUpdatedAt = null;
  }
  if (typeof obj["petBodyColor"] === "string") {
    result.petBodyColor = obj["petBodyColor"];
  } else if (obj["petBodyColor"] === null) {
    result.petBodyColor = null;
  }
  if (typeof obj["petEyes"] === "string") {
    result.petEyes = obj["petEyes"];
  } else if (obj["petEyes"] === null) {
    result.petEyes = null;
  }
  if (typeof obj["petNose"] === "string") {
    result.petNose = obj["petNose"];
  } else if (obj["petNose"] === null) {
    result.petNose = null;
  }
  if (typeof obj["petMouth"] === "string") {
    result.petMouth = obj["petMouth"];
  } else if (obj["petMouth"] === null) {
    result.petMouth = null;
  }
  if (typeof obj["bonsaiHydration"] === "number") {
    result.bonsaiHydration = obj["bonsaiHydration"];
  } else if (obj["bonsaiHydration"] === null) {
    result.bonsaiHydration = null;
  }
  if (typeof obj["bonsaiOvergrowth"] === "number") {
    result.bonsaiOvergrowth = obj["bonsaiOvergrowth"];
  } else if (obj["bonsaiOvergrowth"] === null) {
    result.bonsaiOvergrowth = null;
  }
  if (typeof obj["bonsaiGrowth"] === "number") {
    result.bonsaiGrowth = obj["bonsaiGrowth"];
  } else if (obj["bonsaiGrowth"] === null) {
    result.bonsaiGrowth = null;
  }
  if (typeof obj["bonsaiUpdatedAt"] === "number") {
    result.bonsaiUpdatedAt = obj["bonsaiUpdatedAt"];
  } else if (obj["bonsaiUpdatedAt"] === null) {
    result.bonsaiUpdatedAt = null;
  }
  if (typeof obj["bonsaiPotColor"] === "string") {
    result.bonsaiPotColor = obj["bonsaiPotColor"];
  } else if (obj["bonsaiPotColor"] === null) {
    result.bonsaiPotColor = null;
  }
  if (typeof obj["bonsaiLeafColor"] === "string") {
    result.bonsaiLeafColor = obj["bonsaiLeafColor"];
  } else if (obj["bonsaiLeafColor"] === null) {
    result.bonsaiLeafColor = null;
  }
  if (typeof obj["bonsaiBlossom"] === "string") {
    result.bonsaiBlossom = obj["bonsaiBlossom"];
  } else if (obj["bonsaiBlossom"] === null) {
    result.bonsaiBlossom = null;
  }
  if (typeof obj["bonsaiStyle"] === "string") {
    result.bonsaiStyle = obj["bonsaiStyle"];
  } else if (obj["bonsaiStyle"] === null) {
    result.bonsaiStyle = null;
  }
  if (Array.isArray(obj["aquariumFishTypes"])) {
    result.aquariumFishTypes = obj["aquariumFishTypes"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["aquariumFishTypes"] === null) {
    result.aquariumFishTypes = null;
  }
  if (typeof obj["aquariumSandColor"] === "string") {
    result.aquariumSandColor = obj["aquariumSandColor"];
  } else if (obj["aquariumSandColor"] === null) {
    result.aquariumSandColor = null;
  }
  if (Array.isArray(obj["aquariumProps"])) {
    result.aquariumProps = obj["aquariumProps"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["aquariumProps"] === null) {
    result.aquariumProps = null;
  }
  if (typeof obj["visualizerStyle"] === "string") {
    result.visualizerStyle = obj["visualizerStyle"];
  } else if (obj["visualizerStyle"] === null) {
    result.visualizerStyle = null;
  }
  if (typeof obj["visualizerPrimary"] === "string") {
    result.visualizerPrimary = obj["visualizerPrimary"];
  } else if (obj["visualizerPrimary"] === null) {
    result.visualizerPrimary = null;
  }
  if (typeof obj["visualizerBackground"] === "string") {
    result.visualizerBackground = obj["visualizerBackground"];
  } else if (obj["visualizerBackground"] === null) {
    result.visualizerBackground = null;
  }
  // Picture Frame tile settings.
  if (
    obj["photoSource"] === "uploads" ||
    obj["photoSource"] === "urls" ||
    obj["photoSource"] === "google" ||
    obj["photoSource"] === "immich"
  ) {
    result.photoSource = obj["photoSource"];
  } else if (obj["photoSource"] === null) {
    result.photoSource = null;
  }
  if (Array.isArray(obj["photoUploadUrls"])) {
    result.photoUploadUrls = obj["photoUploadUrls"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["photoUploadUrls"] === null) {
    result.photoUploadUrls = null;
  }
  if (Array.isArray(obj["photoUrls"])) {
    result.photoUrls = obj["photoUrls"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["photoUrls"] === null) {
    result.photoUrls = null;
  }
  if (typeof obj["photoAlbumId"] === "string") {
    result.photoAlbumId = obj["photoAlbumId"];
  } else if (obj["photoAlbumId"] === null) {
    result.photoAlbumId = null;
  }
  if (typeof obj["photoInterval"] === "number" && Number.isFinite(obj["photoInterval"])) {
    result.photoInterval = obj["photoInterval"];
  } else if (obj["photoInterval"] === null) {
    result.photoInterval = null;
  }
  if (obj["photoFit"] === "cover" || obj["photoFit"] === "contain") {
    result.photoFit = obj["photoFit"];
  } else if (obj["photoFit"] === null) {
    result.photoFit = null;
  }
  if (
    obj["frameStyle"] === "none" ||
    obj["frameStyle"] === "wood" ||
    obj["frameStyle"] === "thin" ||
    obj["frameStyle"] === "gold" ||
    obj["frameStyle"] === "polaroid" ||
    obj["frameStyle"] === "custom"
  ) {
    result.frameStyle = obj["frameStyle"];
  } else if (obj["frameStyle"] === null) {
    result.frameStyle = null;
  }
  if (typeof obj["frameColor"] === "string") {
    result.frameColor = obj["frameColor"];
  } else if (obj["frameColor"] === null) {
    result.frameColor = null;
  }
  if (typeof obj["frameWidth"] === "number" && Number.isFinite(obj["frameWidth"])) {
    result.frameWidth = obj["frameWidth"];
  } else if (obj["frameWidth"] === null) {
    result.frameWidth = null;
  }
  // Video Player tile settings.
  if (
    obj["videoSource"] === "uploads" ||
    obj["videoSource"] === "urls" ||
    obj["videoSource"] === "youtube" ||
    obj["videoSource"] === "plex" ||
    obj["videoSource"] === "jellyfin" ||
    obj["videoSource"] === "ersatztv"
  ) {
    result.videoSource = obj["videoSource"];
  } else if (obj["videoSource"] === null) {
    result.videoSource = null;
  }
  if (Array.isArray(obj["videoUploadUrls"])) {
    result.videoUploadUrls = obj["videoUploadUrls"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["videoUploadUrls"] === null) {
    result.videoUploadUrls = null;
  }
  if (Array.isArray(obj["videoUrls"])) {
    result.videoUrls = obj["videoUrls"].filter(
      (x): x is string => typeof x === "string",
    );
  } else if (obj["videoUrls"] === null) {
    result.videoUrls = null;
  }
  if (typeof obj["videoYoutubeUrl"] === "string") {
    result.videoYoutubeUrl = obj["videoYoutubeUrl"];
  } else if (obj["videoYoutubeUrl"] === null) {
    result.videoYoutubeUrl = null;
  }
  if (typeof obj["videoLibraryId"] === "string") {
    result.videoLibraryId = obj["videoLibraryId"];
  } else if (obj["videoLibraryId"] === null) {
    result.videoLibraryId = null;
  }
  if (typeof obj["videoErsatzChannel"] === "string") {
    result.videoErsatzChannel = obj["videoErsatzChannel"];
  } else if (obj["videoErsatzChannel"] === null) {
    result.videoErsatzChannel = null;
  }
  if (obj["videoPlayMode"] === "single" || obj["videoPlayMode"] === "playlist") {
    result.videoPlayMode = obj["videoPlayMode"];
  } else if (obj["videoPlayMode"] === null) {
    result.videoPlayMode = null;
  }
  if (typeof obj["videoPlaylistLoop"] === "boolean") {
    result.videoPlaylistLoop = obj["videoPlaylistLoop"];
  } else if (obj["videoPlaylistLoop"] === null) {
    result.videoPlaylistLoop = null;
  }
  if (typeof obj["videoShuffle"] === "boolean") {
    result.videoShuffle = obj["videoShuffle"];
  } else if (obj["videoShuffle"] === null) {
    result.videoShuffle = null;
  }
  if (typeof obj["videoMuted"] === "boolean") {
    result.videoMuted = obj["videoMuted"];
  } else if (obj["videoMuted"] === null) {
    result.videoMuted = null;
  }
  if (typeof obj["videoPageSwitchMute"] === "boolean") {
    result.videoPageSwitchMute = obj["videoPageSwitchMute"];
  } else if (obj["videoPageSwitchMute"] === null) {
    result.videoPageSwitchMute = null;
  }
  if (obj["videoFit"] === "cover" || obj["videoFit"] === "contain") {
    result.videoFit = obj["videoFit"];
  } else if (obj["videoFit"] === null) {
    result.videoFit = null;
  }
  return result;
}

// Parse the stored tile_settings JSON blob into an object (or null = "no extra
// settings"). Tolerates legacy/garbage values by falling back to null.
function parseTileSettings(raw: string | null): TileSettings | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return pickTileSettings(parsed as Record<string, unknown>);
    }
    return null;
  } catch {
    return null;
  }
}

// Serialize an incoming tile settings value to a JSON blob (or null). Anything
// that isn't a plain object is stored as null ("no extra settings").
function serializeTileSettings(value: unknown): string | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.stringify(pickTileSettings(value as Record<string, unknown>));
}

export function formatTile(t: DbTile) {
  return {
    id: t.id,
    userId: t.user_id,
    pageId: t.page_id,
    deviceModeId: t.device_mode_id,
    variant: t.variant,
    type: t.type,
    integration: t.integration,
    gridX: t.grid_x,
    gridY: t.grid_y,
    gridW: t.grid_w,
    gridH: t.grid_h,
    name: t.name,
    url: t.url,
    bgColor: t.bg_color,
    imageUrl: t.image_url,
    imageFit: t.image_fit,
    imagePosition: t.image_position,
    imageScale: t.image_scale,
    titleSize: t.title_size,
    titlePosition: t.title_position,
    titleColor: t.title_color,
    hideTitle: Boolean(t.hide_title),
    metrics: parseMetrics(t.metrics),
    tileSettings: parseTileSettings(t.tile_settings),
    createdAt: t.created_at,
  };
}

// Serialize a tile for inclusion in a page export. This is `formatTile` minus
// every identity/ownership field (id, userId, pageId, createdAt) so the result
// is safe to share and to re-import under a different user/page. No credential
// data lives on tiles — integrations are referenced by type only — so the
// allow-listed visual/settings fields are all that travel.
export function exportTile(t: DbTile) {
  const { id, userId, pageId, deviceModeId, variant, createdAt, ...rest } = formatTile(t);
  void id;
  void userId;
  void pageId;
  void deviceModeId;
  void variant;
  void createdAt;
  return rest;
}

// Shared INSERT for new tiles, reused by the create route and the page-import
// flow so both honor exactly the same columns and the same settings allow-list.
const insertTileStmt = db.prepare<
  [number, number | null, number | null, string | null, string, string | null, number, number, number, number, string | null, string | null, string | null, string | null, string | null, string | null, number | null, string | null, string | null, string | null, number, string | null, string | null],
  { id: number }
>(
  `INSERT INTO tiles (user_id, page_id, device_mode_id, variant, type, integration, grid_x, grid_y, grid_w, grid_h, name, url, bg_color, image_url, image_fit, image_position, image_scale, title_size, title_position, title_color, hide_title, metrics, tile_settings)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
);

// Helpers that coerce an untrusted import value to the right column type,
// falling back to a default when the value is missing or the wrong shape.
function importString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function importNumber(v: unknown, fallback: number | null): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// Create a single tile from an (untrusted) exported-tile object on the given
// page. Unknown/garbage fields are dropped, tileSettings is run through the
// pickTileSettings allow-list, and any credential-like field simply has no
// column to land in — so nothing unexpected can be imported.
export function createImportedTile(
  userId: number,
  pageId: number,
  raw: unknown,
  deviceModeId: number | null = null,
  variant: string | null = null,
): void {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  insertTileStmt.run(
    userId,
    pageId,
    deviceModeId,
    variant,
    importString(obj["type"]) ?? "app",
    importString(obj["integration"]),
    importNumber(obj["gridX"], 0)!,
    importNumber(obj["gridY"], 0)!,
    importNumber(obj["gridW"], 4)!,
    importNumber(obj["gridH"], 4)!,
    importString(obj["name"]),
    importString(obj["url"]),
    importString(obj["bgColor"]),
    importString(obj["imageUrl"]),
    importString(obj["imageFit"]),
    importString(obj["imagePosition"]),
    importNumber(obj["imageScale"], null),
    importString(obj["titleSize"]),
    importString(obj["titlePosition"]),
    importString(obj["titleColor"]),
    obj["hideTitle"] === true ? 1 : 0,
    serializeMetrics(obj["metrics"]),
    serializeTileSettings(obj["tileSettings"]),
  );
}

// Portrait variants were simplified from four tiers to two: compact/fhd/qhd
// portrait (near-identical real screen widths) collapsed into "fhd-portrait"
// (the Standard vertical tier); "uhd-portrait" stays the dense 4K tier. Legacy
// keys are aliased here so any read or write naming an old portrait scope
// lands on its canonical tier (stored rows were migrated the same way in db.ts).
const LEGACY_PORTRAIT_VARIANTS: Record<string, string> = {
  "compact-portrait": "fhd-portrait",
  "qhd-portrait": "fhd-portrait",
};

// Normalize an incoming variant value: a non-empty string is kept (trimmed,
// capped, legacy portrait keys canonicalized), anything else means "the base
// layout" (NULL).
export function cleanVariant(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const capped = trimmed.slice(0, 40);
  return LEGACY_PORTRAIT_VARIANTS[capped] ?? capped;
}

// GET /api/tiles?pageId=&deviceModeId=&variant= — when a pageId is supplied,
// return only that page's tiles (after verifying the page belongs to the
// caller). A deviceModeId narrows further to that mode's layout, and variant
// selects an adaptive scale/orientation layout (omitted = the base layout).
// Omitting pageId returns every tile the user owns; omitting deviceModeId
// returns all of the page's tiles across modes, preserving legacy behavior.
router.get("/", requireAuth, (req: AuthRequest, res) => {
  const pageIdRaw = req.query["pageId"];
  if (pageIdRaw !== undefined) {
    const pageId = parseInt(String(pageIdRaw));
    if (Number.isNaN(pageId) || !pageStmts.findById.get(pageId, req.user!.userId)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const modeIdRaw = req.query["deviceModeId"];
    if (modeIdRaw !== undefined) {
      const modeId = parseInt(String(modeIdRaw));
      if (Number.isNaN(modeId) || !deviceModeStmts.findById.get(modeId, req.user!.userId)) {
        res.status(404).json({ error: "Device mode not found" });
        return;
      }
      const variant = cleanVariant(req.query["variant"]);
      const tiles = tileStmts.findAllByPageScope.all(
        req.user!.userId,
        pageId,
        modeId,
        variant,
      );
      res.json(tiles.map(formatTile));
      return;
    }
    const tiles = tileStmts.findAllByPage.all(req.user!.userId, pageId);
    res.json(tiles.map(formatTile));
    return;
  }
  const tiles = tileStmts.findAllByUser.all(req.user!.userId);
  res.json(tiles.map(formatTile));
});

// POST /api/tiles
router.post("/", requireAuth, (req: AuthRequest, res) => {
  const body = req.body as {
    pageId?: number | null;
    deviceModeId?: number | null;
    variant?: string | null;
    type?: string;
    integration?: string | null;
    gridX?: number;
    gridY?: number;
    gridW?: number;
    gridH?: number;
    name?: string;
    url?: string;
    bgColor?: string;
    imageUrl?: string;
    imageFit?: string;
    imagePosition?: string;
    imageScale?: number;
    titleSize?: string;
    titlePosition?: string;
    titleColor?: string;
    hideTitle?: boolean;
    metrics?: string[] | null;
    tileSettings?: TileSettings | null;
  };

  // Resolve which page this tile belongs to. An explicit pageId must belong to
  // the caller; otherwise default to the user's first page. (A user always has
  // at least one page after migration/registration, but tolerate its absence
  // by storing NULL rather than rejecting.)
  let pageId: number | null = null;
  if (body.pageId != null) {
    const page = pageStmts.findById.get(body.pageId, req.user!.userId);
    if (!page) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    pageId = page.id;
  } else {
    const pages = pageStmts.findAllByUser.all(req.user!.userId);
    pageId = pages[0]?.id ?? null;
  }

  // Resolve which device mode the tile belongs to. An explicit deviceModeId
  // must belong to the caller; otherwise fall back to the user's default mode
  // so legacy clients keep working unchanged.
  let deviceModeId: number;
  if (body.deviceModeId != null) {
    const mode = deviceModeStmts.findById.get(body.deviceModeId, req.user!.userId);
    if (!mode) {
      res.status(404).json({ error: "Device mode not found" });
      return;
    }
    deviceModeId = mode.id;
  } else {
    deviceModeId = defaultDeviceModeId(req.user!.userId);
  }

  const row = insertTileStmt.get(
    req.user!.userId,
    pageId,
    deviceModeId,
    cleanVariant(body.variant),
    body.type ?? "app",
    body.integration ?? null,
    body.gridX ?? 0,
    body.gridY ?? 0,
    body.gridW ?? 4,
    body.gridH ?? 4,
    body.name ?? null,
    body.url ?? null,
    body.bgColor ?? null,
    body.imageUrl ?? null,
    body.imageFit ?? null,
    body.imagePosition ?? null,
    body.imageScale ?? null,
    body.titleSize ?? null,
    body.titlePosition ?? null,
    body.titleColor ?? null,
    body.hideTitle ? 1 : 0,
    body.metrics === undefined ? null : serializeMetrics(body.metrics),
    body.tileSettings === undefined ? null : serializeTileSettings(body.tileSettings)
  )!;

  const tile = db.prepare<[number], DbTile>("SELECT * FROM tiles WHERE id = ?").get(row.id)!;
  res.status(201).json(formatTile(tile));
});

// GET /api/tiles/:id
router.get("/:id", requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(String(req.params["id"]));
  const tile = tileStmts.findById.get(id, req.user!.userId);
  if (!tile) {
    res.status(404).json({ error: "Tile not found" });
    return;
  }
  res.json(formatTile(tile));
});

// PUT /api/tiles/:id
router.put("/:id", requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(String(req.params["id"]));
  const existing = tileStmts.findById.get(id, req.user!.userId);
  if (!existing) {
    res.status(404).json({ error: "Tile not found" });
    return;
  }

  const body = req.body as {
    integration?: string | null;
    gridX?: number;
    gridY?: number;
    gridW?: number;
    gridH?: number;
    name?: string;
    url?: string;
    bgColor?: string | null;
    imageUrl?: string;
    imageFit?: string;
    imagePosition?: string | null;
    imageScale?: number | null;
    titleSize?: string | null;
    titlePosition?: string | null;
    titleColor?: string | null;
    hideTitle?: boolean;
    metrics?: string[] | null;
    tileSettings?: TileSettings | null;
  };

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.integration !== undefined) { updates.push("integration = ?"); params.push(body.integration); }
  if (body.gridX !== undefined) { updates.push("grid_x = ?"); params.push(body.gridX); }
  if (body.gridY !== undefined) { updates.push("grid_y = ?"); params.push(body.gridY); }
  if (body.gridW !== undefined) { updates.push("grid_w = ?"); params.push(body.gridW); }
  if (body.gridH !== undefined) { updates.push("grid_h = ?"); params.push(body.gridH); }
  if (body.name !== undefined) { updates.push("name = ?"); params.push(body.name); }
  if (body.url !== undefined) { updates.push("url = ?"); params.push(body.url); }
  if (body.bgColor !== undefined) { updates.push("bg_color = ?"); params.push(body.bgColor); }
  if (body.imageUrl !== undefined) { updates.push("image_url = ?"); params.push(body.imageUrl); }
  if (body.imageFit !== undefined) { updates.push("image_fit = ?"); params.push(body.imageFit); }
  if (body.imagePosition !== undefined) { updates.push("image_position = ?"); params.push(body.imagePosition); }
  if (body.imageScale !== undefined) { updates.push("image_scale = ?"); params.push(body.imageScale); }
  if (body.titleSize !== undefined) { updates.push("title_size = ?"); params.push(body.titleSize); }
  if (body.titlePosition !== undefined) { updates.push("title_position = ?"); params.push(body.titlePosition); }
  if (body.titleColor !== undefined) { updates.push("title_color = ?"); params.push(body.titleColor); }
  if (body.hideTitle !== undefined) { updates.push("hide_title = ?"); params.push(body.hideTitle ? 1 : 0); }
  if (body.metrics !== undefined) { updates.push("metrics = ?"); params.push(body.metrics === null ? null : serializeMetrics(body.metrics)); }
  if (body.tileSettings !== undefined) { updates.push("tile_settings = ?"); params.push(body.tileSettings === null ? null : serializeTileSettings(body.tileSettings)); }

  if (updates.length > 0) {
    params.push(id);
    db.prepare(`UPDATE tiles SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare<[number], DbTile>("SELECT * FROM tiles WHERE id = ?").get(id)!;
  res.json(formatTile(updated));
});

// DELETE /api/tiles/:id
router.delete("/:id", requireAuth, (req: AuthRequest, res) => {
  const id = parseInt(String(req.params["id"]));
  const existing = tileStmts.findById.get(id, req.user!.userId);
  if (!existing) {
    res.status(404).json({ error: "Tile not found" });
    return;
  }
  tileStmts.delete.run(id, req.user!.userId);
  res.status(204).send();
});

export default router;
