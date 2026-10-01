import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dataDir = process.env["DATA_DIR"] || "./data";

// Ensure data and uploads directories exist
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });

const dbPath = path.join(dataDir, "db.sqlite");

export const db = new Database(dbPath);

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'app',
    grid_x INTEGER NOT NULL DEFAULT 0,
    grid_y INTEGER NOT NULL DEFAULT 0,
    grid_w INTEGER NOT NULL DEFAULT 4,
    grid_h INTEGER NOT NULL DEFAULT 4,
    name TEXT,
    url TEXT,
    bg_color TEXT,
    image_url TEXT,
    image_fit TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Home',
    position INTEGER NOT NULL DEFAULT 0,
    layout_preset TEXT,
    layout_orientation TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS device_modes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Default',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uploaded_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS service_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    url TEXT,
    api_key TEXT,
    username TEXT,
    password TEXT,
    extra TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, service)
  );

  CREATE TABLE IF NOT EXISTS service_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    ok INTEGER NOT NULL,
    message TEXT NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, service)
  );
`);

// ── One-time structural migration: service_connections / service_health used
// to be instance-global (keyed only by `service`, no owner). Any authenticated
// user could read/tamper with every other user's saved credentials and linked
// mail/calendar/Spotify accounts through these shared rows. Both tables are
// now scoped per-user (composite UNIQUE(user_id, service)); this block
// rebuilds pre-existing tables that still have the old single-column PK,
// assigning any orphaned global rows to the lowest-id ("first"/owner) user so
// existing self-hosted instances keep their configured connections instead of
// losing them outright. Guarded so it runs exactly once per table.
function migrateGlobalTableToPerUser(table: "service_connections" | "service_health"): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
  const hasUserId = cols.some((c) => c.name === "user_id");
  if (hasUserId) return;

  const firstUser = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get() as
    | { id: number }
    | undefined;

  const legacyRows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];

  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);

  if (table === "service_connections") {
    db.exec(`
      CREATE TABLE service_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        url TEXT,
        api_key TEXT,
        username TEXT,
        password TEXT,
        extra TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, service)
      )
    `);
  } else {
    db.exec(`
      CREATE TABLE service_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        ok INTEGER NOT NULL,
        message TEXT NOT NULL,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, service)
      )
    `);
  }

  if (firstUser) {
    if (table === "service_connections") {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO service_connections (user_id, service, url, api_key, username, password, extra, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of legacyRows) {
        insert.run(
          firstUser.id,
          row["service"],
          row["url"] ?? null,
          row["api_key"] ?? null,
          row["username"] ?? null,
          row["password"] ?? null,
          row["extra"] ?? null,
          row["updated_at"] ?? new Date().toISOString(),
        );
      }
    } else {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO service_health (user_id, service, ok, message, checked_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const row of legacyRows) {
        insert.run(firstUser.id, row["service"], row["ok"], row["message"], row["checked_at"]);
      }
    }
  }

  db.exec(`DROP TABLE ${table}_legacy`);
}
migrateGlobalTableToPerUser("service_connections");
migrateGlobalTableToPerUser("service_health");

// ── Migrations ────────────────────────────────────────────────────────────────
// Every tile is now stored as an app/link with an optional `integration`.
// 1. Add the nullable `integration` column (guarded so it is idempotent —
//    SQLite has no "ADD COLUMN IF NOT EXISTS").
const tileColumns = db.prepare("PRAGMA table_info(tiles)").all() as { name: string }[];
if (!tileColumns.some((c) => c.name === "integration")) {
  db.exec("ALTER TABLE tiles ADD COLUMN integration TEXT");
}

// 1b. Per-tile metric selection. Stored as a JSON array of enabled metric keys.
//     NULL means "show all" so tiles created before this column behave as before.
if (!tileColumns.some((c) => c.name === "metrics")) {
  db.exec("ALTER TABLE tiles ADD COLUMN metrics TEXT");
}

// 1c. Flexible image placement. `image_position` is an anchor key (e.g.
//     "center", "top-left"); `image_scale` is a zoom percentage (100 = native).
//     Both NULL means "use the legacy image_fit behavior" so existing tiles
//     keep rendering exactly as before.
if (!tileColumns.some((c) => c.name === "image_position")) {
  db.exec("ALTER TABLE tiles ADD COLUMN image_position TEXT");
}
if (!tileColumns.some((c) => c.name === "image_scale")) {
  db.exec("ALTER TABLE tiles ADD COLUMN image_scale INTEGER");
}

// 1d. Tile title styling for plain app/link tiles. `title_size` is a size key
//     (e.g. "sm", "md", "lg", "xl"); `title_position` is an anchor key (e.g.
//     "center", "top-left"). Both NULL means "use the default" so existing
//     tiles keep rendering exactly as before. These do NOT affect integration
//     (widget) tiles, whose header layout is fixed.
if (!tileColumns.some((c) => c.name === "title_size")) {
  db.exec("ALTER TABLE tiles ADD COLUMN title_size TEXT");
}
if (!tileColumns.some((c) => c.name === "title_position")) {
  db.exec("ALTER TABLE tiles ADD COLUMN title_position TEXT");
}
// `title_color` is an optional CSS color for the title text. NULL means "use the
// default" (white over an image, theme color otherwise).
if (!tileColumns.some((c) => c.name === "title_color")) {
  db.exec("ALTER TABLE tiles ADD COLUMN title_color TEXT");
}

// 1e. Per-tile "hide title text" toggle. Stored as 0/1; defaults to 0 (title
//     shown) so existing tiles keep rendering their title. Applies to both
//     plain app/link tiles and integration (widget) tiles.
if (!tileColumns.some((c) => c.name === "hide_title")) {
  db.exec("ALTER TABLE tiles ADD COLUMN hide_title INTEGER NOT NULL DEFAULT 0");
}

// 1f. Generic per-integration extra config, stored as a JSON object. NULL means
//     "no extra settings" so existing tiles behave as before. Currently carries
//     the qBittorrent category filter ({ categoryFilter: string[] | null }).
if (!tileColumns.some((c) => c.name === "tile_settings")) {
  db.exec("ALTER TABLE tiles ADD COLUMN tile_settings TEXT");
}

// 1g. Grid resolution doubling. The dashboard grid went from 12 cols × 80px
//     rows to 24 cols × 40px rows, halving the smallest tile step. To keep every
//     existing tile at its current visual size and position, scale all four grid
//     coordinates ×2. Guarded by PRAGMA user_version so it runs exactly once.
const gridSchemaVersion = db.pragma("user_version", { simple: true }) as number;
if (gridSchemaVersion < 1) {
  db.exec(
    "UPDATE tiles SET grid_x = grid_x * 2, grid_y = grid_y * 2, grid_w = grid_w * 2, grid_h = grid_h * 2"
  );
  db.pragma("user_version = 1");
}

// 1h. Multi-page dashboards. Tiles now belong to a `page`; add the nullable
//     `page_id` column (guarded so it is idempotent). NULL means "not yet
//     assigned" and is backfilled below.
if (!tileColumns.some((c) => c.name === "page_id")) {
  db.exec("ALTER TABLE tiles ADD COLUMN page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE");
}

// 1i. One-time backfill so every existing user ends up with at least one page
//     and all their tiles are attached to it. For each user that has no page
//     yet, create a default "Home" page; then assign every still-unassigned
//     tile to its owner's first page. Idempotent: re-running creates no new
//     pages (users already have one) and finds no NULL-page tiles to move.
const usersWithoutPage = db
  .prepare("SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM pages)")
  .all() as { id: number }[];
const insertDefaultPage = db.prepare(
  "INSERT INTO pages (user_id, name, position) VALUES (?, 'Home', 0)"
);
const backfillPages = db.transaction(() => {
  for (const u of usersWithoutPage) {
    insertDefaultPage.run(u.id);
  }
  // Attach any tile without a page to its owner's first (lowest position) page.
  db.exec(`
    UPDATE tiles
    SET page_id = (
      SELECT p.id FROM pages p
      WHERE p.user_id = tiles.user_id
      ORDER BY p.position ASC, p.id ASC
      LIMIT 1
    )
    WHERE page_id IS NULL
  `);
});
backfillPages();

// 1j. Per-page fixed scale lock. Pages can be pinned to a fixed column count
//     (a resolution-style preset) and an orientation so tiles never reflow when
//     the window resizes. Both columns are nullable; NULL means "auto"
//     (responsive) / "landscape", preserving today's behavior for existing rows.
const pageColumns = db.prepare("PRAGMA table_info(pages)").all() as { name: string }[];
if (!pageColumns.some((c) => c.name === "layout_preset")) {
  db.exec("ALTER TABLE pages ADD COLUMN layout_preset TEXT");
}
if (!pageColumns.some((c) => c.name === "layout_orientation")) {
  db.exec("ALTER TABLE pages ADD COLUMN layout_orientation TEXT");
}

// 1k. Device modes. Each user can define multiple named layout profiles (e.g.
//     "PC", "Phone"); every tile belongs to exactly one. Adaptive pages
//     additionally split layouts per scale+orientation via `variant` (e.g.
//     "fhd-landscape"); NULL variant is the base layout used by auto/fixed
//     pages. Both columns are added guarded, then backfilled: every user gets
//     a "Default" mode and all their existing tiles are attached to it — so a
//     pre-device-modes dashboard migrates losslessly into the default mode.
if (!tileColumns.some((c) => c.name === "device_mode_id")) {
  db.exec(
    "ALTER TABLE tiles ADD COLUMN device_mode_id INTEGER REFERENCES device_modes(id) ON DELETE CASCADE"
  );
}
if (!tileColumns.some((c) => c.name === "variant")) {
  db.exec("ALTER TABLE tiles ADD COLUMN variant TEXT");
}
const usersWithoutMode = db
  .prepare("SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM device_modes)")
  .all() as { id: number }[];
const insertDefaultMode = db.prepare(
  "INSERT INTO device_modes (user_id, name, position) VALUES (?, 'Default', 0)"
);
const backfillModes = db.transaction(() => {
  for (const u of usersWithoutMode) {
    insertDefaultMode.run(u.id);
  }
  // Attach any tile without a mode to its owner's first device mode.
  db.exec(`
    UPDATE tiles
    SET device_mode_id = (
      SELECT m.id FROM device_modes m
      WHERE m.user_id = tiles.user_id
      ORDER BY m.position ASC, m.id ASC
      LIMIT 1
    )
    WHERE device_mode_id IS NULL
  `);
});
backfillModes();

// 1l. Simplified portrait variants. Vertical layouts used to mirror all four
//     landscape tiers ("compact-portrait" … "uhd-portrait") even though most
//     portrait screens are ~1080–1440px wide; the client now uses only two
//     canonical vertical tiers: "fhd-portrait" (Standard) and "uhd-portrait"
//     (4K). Migrate stored tile rows so no saved vertical layout is silently
//     lost: within each (user, page, device mode) scope, legacy
//     "qhd-portrait" (preferred, denser/likelier hand-tuned) then
//     "compact-portrait" rows are renamed to "fhd-portrait" — but only when
//     that scope has no "fhd-portrait" tiles yet, so an existing canonical
//     layout is never merged into or overwritten. Any legacy rows left behind
//     (because a canonical layout already existed) are kept in the DB
//     untouched. Guarded by PRAGMA user_version so it runs exactly once.
const portraitVariantVersion = db.pragma("user_version", { simple: true }) as number;
if (portraitVariantVersion < 2) {
  // Precompute the promotion plan first (a correlated NOT EXISTS inside the
  // UPDATE could observe rows renamed earlier by the same statement and stop
  // promoting a scope halfway through, splitting one saved layout in two).
  const legacyScopes = db
    .prepare(
      `SELECT DISTINCT user_id, page_id, device_mode_id, variant FROM tiles
       WHERE variant IN ('qhd-portrait', 'compact-portrait')`
    )
    .all() as {
    user_id: number;
    page_id: number | null;
    device_mode_id: number | null;
    variant: string;
  }[];
  const hasCanonical = db.prepare(
    `SELECT 1 FROM tiles
     WHERE user_id = ? AND page_id IS ? AND device_mode_id IS ?
       AND variant = 'fhd-portrait' LIMIT 1`
  );
  const renameScope = db.prepare(
    `UPDATE tiles SET variant = 'fhd-portrait'
     WHERE user_id = ? AND page_id IS ? AND device_mode_id IS ? AND variant = ?`
  );
  const promoteLegacyPortrait = db.transaction(() => {
    // qhd before compact so the denser legacy layout wins when both exist.
    const ordered = [...legacyScopes].sort((a, b) =>
      a.variant === b.variant ? 0 : a.variant === "qhd-portrait" ? -1 : 1
    );
    for (const s of ordered) {
      if (hasCanonical.get(s.user_id, s.page_id, s.device_mode_id)) continue;
      renameScope.run(s.user_id, s.page_id, s.device_mode_id, s.variant);
    }
  });
  promoteLegacyPortrait();
  db.pragma("user_version = 2");
}

// 2. One-time data migration: existing integration-typed tiles become app/link
//    tiles whose `integration` carries the old type. Styling fields are left
//    untouched. After this runs `type` is 'app' so it never matches again.
db.exec(`
  UPDATE tiles
  SET integration = type, type = 'app'
  WHERE type IN ('media', 'sonarr', 'radarr', 'qbittorrent', 'truenas')
    AND integration IS NULL
`);

// Per-user connection settings for the supported services. Seed an empty row
// for each on registration (see createDefaultServiceConnections below) so the
// settings page always has something to render for that user — and, for
// installs that predate per-user connections, backfill any user who has none.
const SERVICE_CONNECTION_KEYS = ["truenas", "plex", "sonarr", "radarr", "qbittorrent"] as const;

const seedConnection = db.prepare(
  "INSERT OR IGNORE INTO service_connections (user_id, service) VALUES (?, ?)"
);
const allUserIds = db.prepare("SELECT id FROM users").all() as { id: number }[];
for (const u of allUserIds) {
  for (const service of SERVICE_CONNECTION_KEYS) {
    seedConnection.run(u.id, service);
  }
}

// ── Helper types ──────────────────────────────────────────────────────────────

export interface DbUser {
  id: number;
  username: string;
  password: string;
  created_at: string;
}

export interface DbPage {
  id: number;
  user_id: number;
  name: string;
  position: number;
  layout_preset: string | null;
  layout_orientation: string | null;
  created_at: string;
}

export interface DbDeviceMode {
  id: number;
  user_id: number;
  name: string;
  position: number;
  created_at: string;
}

export interface DbTile {
  id: number;
  user_id: number;
  page_id: number | null;
  device_mode_id: number | null;
  variant: string | null;
  type: string;
  integration: string | null;
  grid_x: number;
  grid_y: number;
  grid_w: number;
  grid_h: number;
  name: string | null;
  url: string | null;
  bg_color: string | null;
  image_url: string | null;
  image_fit: string | null;
  image_position: string | null;
  image_scale: number | null;
  title_size: string | null;
  title_position: string | null;
  title_color: string | null;
  hide_title: number;
  metrics: string | null;
  tile_settings: string | null;
  created_at: string;
}

// ── Prepared statements ───────────────────────────────────────────────────────

export const userStmts = {
  findFirst: db.prepare<[], Pick<DbUser, "id">>("SELECT id FROM users ORDER BY id ASC LIMIT 1"),
  findByUsername: db.prepare<[string], DbUser>("SELECT * FROM users WHERE username = ?"),
  findById: db.prepare<[number], DbUser>("SELECT * FROM users WHERE id = ?"),
  create: db.prepare<[string, string], { id: number }>(
    "INSERT INTO users (username, password) VALUES (?, ?) RETURNING id"
  ),
};

export interface DbUploadedFile {
  id: number;
  user_id: number;
  filename: string;
  original_name: string;
  mimetype: string;
  size: number;
  url: string;
  created_at: string;
}

export const uploadStmts = {
  create: db.prepare<[number, string, string, string, number, string], { id: number }>(
    `INSERT INTO uploaded_files (user_id, filename, original_name, mimetype, size, url)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  ),
  findAllByUser: db.prepare<[number], DbUploadedFile>(
    "SELECT * FROM uploaded_files WHERE user_id = ? ORDER BY created_at DESC"
  ),
  findById: db.prepare<[number, number], DbUploadedFile>(
    "SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?"
  ),
  delete: db.prepare<[number, number], void>(
    "DELETE FROM uploaded_files WHERE id = ? AND user_id = ?"
  ),
  totalSize: db.prepare<[], { total: number }>(
    "SELECT COALESCE(SUM(size), 0) AS total FROM uploaded_files"
  ),
};

export const tileStmts = {
  findAllByUser: db.prepare<[number], DbTile>(
    "SELECT * FROM tiles WHERE user_id = ? ORDER BY created_at ASC"
  ),
  findAllByPage: db.prepare<[number, number], DbTile>(
    "SELECT * FROM tiles WHERE user_id = ? AND page_id = ? ORDER BY created_at ASC"
  ),
  // Variant-scoped page tiles: a specific device mode plus a layout variant
  // (NULL variant = the base layout used by auto/fixed pages).
  findAllByPageScope: db.prepare<[number, number, number, string | null], DbTile>(
    `SELECT * FROM tiles
     WHERE user_id = ? AND page_id = ? AND device_mode_id = ?
       AND variant IS ?
     ORDER BY created_at ASC`
  ),
  findById: db.prepare<[number, number], DbTile>(
    "SELECT * FROM tiles WHERE id = ? AND user_id = ?"
  ),
  create: db.prepare<
    [number, string, string | null, number, number, number, number, string | null, string | null, string | null, string | null, string | null],
    { id: number }
  >(
    `INSERT INTO tiles (user_id, type, integration, grid_x, grid_y, grid_w, grid_h, name, url, bg_color, image_url, image_fit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ),
  delete: db.prepare<[number, number], void>(
    "DELETE FROM tiles WHERE id = ? AND user_id = ?"
  ),
  // Remove every tile in one (page, device mode, variant) layout scope —
  // used by copy-layout's replace flag before re-seeding the scope.
  deleteByPageScope: db.prepare<[number, number, number, string | null], void>(
    `DELETE FROM tiles
     WHERE user_id = ? AND page_id = ? AND device_mode_id = ?
       AND variant IS ?`
  ),
};

export const pageStmts = {
  findAllByUser: db.prepare<[number], DbPage>(
    "SELECT * FROM pages WHERE user_id = ? ORDER BY position ASC, id ASC"
  ),
  findById: db.prepare<[number, number], DbPage>(
    "SELECT * FROM pages WHERE id = ? AND user_id = ?"
  ),
  countByUser: db.prepare<[number], { count: number }>(
    "SELECT COUNT(*) AS count FROM pages WHERE user_id = ?"
  ),
  maxPosition: db.prepare<[number], { maxPos: number | null }>(
    "SELECT MAX(position) AS maxPos FROM pages WHERE user_id = ?"
  ),
  create: db.prepare<[number, string, number], { id: number }>(
    "INSERT INTO pages (user_id, name, position) VALUES (?, ?, ?) RETURNING id"
  ),
  rename: db.prepare<[string, number, number], void>(
    "UPDATE pages SET name = ? WHERE id = ? AND user_id = ?"
  ),
  updateLayout: db.prepare<[string | null, string | null, number, number], void>(
    "UPDATE pages SET layout_preset = ?, layout_orientation = ? WHERE id = ? AND user_id = ?"
  ),
  updatePosition: db.prepare<[number, number, number], void>(
    "UPDATE pages SET position = ? WHERE id = ? AND user_id = ?"
  ),
  delete: db.prepare<[number, number], void>(
    "DELETE FROM pages WHERE id = ? AND user_id = ?"
  ),
};

// Create a user's default "Home" page. Used on signup so every new user always
// has at least one page to drop tiles onto.
export function createDefaultPage(userId: number): number {
  const row = pageStmts.create.get(userId, "Home", 0)!;
  return row.id;
}

export const deviceModeStmts = {
  findAllByUser: db.prepare<[number], DbDeviceMode>(
    "SELECT * FROM device_modes WHERE user_id = ? ORDER BY position ASC, id ASC"
  ),
  findById: db.prepare<[number, number], DbDeviceMode>(
    "SELECT * FROM device_modes WHERE id = ? AND user_id = ?"
  ),
  countByUser: db.prepare<[number], { count: number }>(
    "SELECT COUNT(*) AS count FROM device_modes WHERE user_id = ?"
  ),
  maxPosition: db.prepare<[number], { maxPos: number | null }>(
    "SELECT MAX(position) AS maxPos FROM device_modes WHERE user_id = ?"
  ),
  create: db.prepare<[number, string, number], { id: number }>(
    "INSERT INTO device_modes (user_id, name, position) VALUES (?, ?, ?) RETURNING id"
  ),
  rename: db.prepare<[string, number, number], void>(
    "UPDATE device_modes SET name = ? WHERE id = ? AND user_id = ?"
  ),
  delete: db.prepare<[number, number], void>(
    "DELETE FROM device_modes WHERE id = ? AND user_id = ?"
  ),
};

// Create a user's default device mode. Used on signup so every new user always
// has exactly one mode for their tiles to belong to. Returns the mode id.
export function createDefaultDeviceMode(userId: number): number {
  const row = deviceModeStmts.create.get(userId, "Default", 0)!;
  return row.id;
}

// Resolve the user's default (first) device mode id, creating one if the user
// somehow has none. Used as the fallback scope for legacy requests that don't
// name a device mode.
export function defaultDeviceModeId(userId: number): number {
  const first = deviceModeStmts.findAllByUser.get(userId);
  return first ? first.id : createDefaultDeviceMode(userId);
}

export interface DbServiceConnection {
  id: number;
  user_id: number;
  service: string;
  url: string | null;
  api_key: string | null;
  username: string | null;
  password: string | null;
  extra: string | null;
  updated_at: string;
}

// All connection reads/writes are scoped by user_id so one authenticated user
// can never see or overwrite another user's saved service credentials, mail
// accounts, or linked Google/Spotify tokens.
export const connectionStmts = {
  findAllByUser: db.prepare<[number], DbServiceConnection>(
    "SELECT * FROM service_connections WHERE user_id = ? ORDER BY service ASC"
  ),
  findByService: db.prepare<[number, string], DbServiceConnection>(
    "SELECT * FROM service_connections WHERE user_id = ? AND service = ?"
  ),
  upsert: db.prepare<
    [number, string, string | null, string | null, string | null, string | null, string | null],
    void
  >(
    `INSERT INTO service_connections (user_id, service, url, api_key, username, password, extra, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, service) DO UPDATE SET
       url = excluded.url,
       api_key = excluded.api_key,
       username = excluded.username,
       password = excluded.password,
       extra = excluded.extra,
       updated_at = datetime('now')`
  ),
};

// Seed empty rows for the single-value connection services so a brand-new
// user's settings page always has something to render. Called on signup and
// during the legacy-data backfill above.
export function createDefaultServiceConnections(userId: number): void {
  for (const service of SERVICE_CONNECTION_KEYS) {
    seedConnection.run(userId, service);
  }
}

export interface DbServiceHealth {
  id: number;
  user_id: number;
  service: string;
  ok: number;
  message: string;
  checked_at: string;
}

export const healthStmts = {
  findAllByUser: db.prepare<[number], DbServiceHealth>(
    "SELECT * FROM service_health WHERE user_id = ? ORDER BY service ASC"
  ),
  upsert: db.prepare<[number, string, number, string], void>(
    `INSERT INTO service_health (user_id, service, ok, message, checked_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, service) DO UPDATE SET
       ok = excluded.ok,
       message = excluded.message,
       checked_at = datetime('now')`
  ),
  delete: db.prepare<[number, string], void>(
    "DELETE FROM service_health WHERE user_id = ? AND service = ?"
  ),
};
