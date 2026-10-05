import { randomBytes, randomUUID, createHash } from "node:crypto";
import { db, userStmts } from "./db.js";

export const PAIR_TTL = 120_000;
export const LIVE_TTL = 8_000;
export const COMMAND_TTL = 4_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const secret = () => randomBytes(32).toString("hex");
export class LauncherError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new LauncherError(status, message); }
export function text(v: unknown, max = 100): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) fail(400, "Invalid value");
  return v.trim();
}
export interface Action { id: string; name: string }
export function actions(value: unknown): Action[] {
  if (!Array.isArray(value) || value.length > 50) fail(400, "At most 50 approved actions");
  const result = value.map(a => {
    if (!a || typeof a !== "object") fail(400, "Invalid action");
    const id = text(a.id, 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail(400, "Invalid action ID");
    return { id, name: text(a.name) };
  });
  if (new Set(result.map(a => a.id)).size !== result.length) fail(400, "Duplicate action ID");
  return result;
}
interface Device { id: string; owner: number; name: string; token: string; revoked: number; actions: string }
interface Command { id: string; device: string; action: string; session: string; status: string; expires: number; error: string | null }
db.exec(`
 CREATE TABLE IF NOT EXISTS launcher_instance (id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS launcher_devices (
   id TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0, actions TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS launcher_commands (
   id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES launcher_devices(id) ON DELETE CASCADE,
   action TEXT NOT NULL, session TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL, error TEXT
 );
`);
if (!db.prepare("SELECT id FROM launcher_instance").get()) db.prepare("INSERT INTO launcher_instance VALUES (?)").run(randomUUID());
export const instanceId = (db.prepare("SELECT id FROM launcher_instance").get() as { id: string }).id;
// Never resume queued work after a server restart.
db.prepare("UPDATE launcher_commands SET status='expired', error='Server restarted' WHERE status='pending'").run();
const pairings = new Map<string, { owner: number; expires: number }>();
const live = new Map<string, { session: string; seen: number }>();
// A single global budget avoids unbounded attacker-controlled IP keys, and works
// behind proxies without trusting forwarded addresses.
const budgets = new Map<string, { start: number; count: number }>();
export function limit(bucket: string, max: number, now = Date.now()) {
  let b = budgets.get(bucket);
  if (!b || now - b.start >= 60_000) { b = { start: now, count: 0 }; budgets.set(bucket, b); }
  if (++b.count > max) fail(429, "Too many requests; try again in one minute");
}
export function owner(id: number | undefined) {
  if (!id || userStmts.findFirst.get()?.id !== id) fail(403, "Only the instance owner can control computers");
  return id;
}
export function createPairing(user: number, now = Date.now()) {
  owner(user); limit("create-pairing", 5, now);
  // Only one outstanding invitation. It is not recoverable from disk or export.
  pairings.clear();
  const code = secret(); pairings.set(hash(code), { owner: user, expires: now + PAIR_TTL });
  return { code, instanceId, expiresAt: now + PAIR_TTL, owner: userStmts.findById.get(user)!.username };
}
function pairing(code: unknown, instance: unknown, now: number) {
  limit("pair-attempt", 20, now);
  if (instance !== instanceId) fail(403, "Wrong server instance");
  const p = pairings.get(hash(text(code, 64)));
  if (!p || p.expires <= now) fail(410, "Pairing expired or invalid");
  owner(p.owner); return p;
}
export function inspectPairing(code: unknown, instance: unknown, now = Date.now()) {
  const p = pairing(code, instance, now);
  return { instanceId, owner: userStmts.findById.get(p.owner)!.username, expiresAt: p.expires };
}
export function approvePairing(input: Record<string, unknown>, now = Date.now()) {
  const p = pairing(input.code, input.instanceId, now);
  if (input.approved !== true) fail(400, "Explicit local approval required");
  const approved = actions(input.actions);
  const name = text(input.name);
  if ((db.prepare("SELECT count(*) n FROM launcher_devices WHERE revoked=0").get() as { n: number }).n >= 20) fail(409, "Revoke a computer before pairing another (limit 20)");
  const id = randomUUID(), token = secret();
  db.prepare("INSERT INTO launcher_devices(id,owner,name,token,actions) VALUES (?,?,?,?,?)").run(id, p.owner, name, hash(token), JSON.stringify(approved));
  pairings.delete(hash(input.code as string));
  return { instanceId, deviceId: id, token };
}
export function deviceAuth(token: string, instance: unknown): Device {
  if (instance !== instanceId) fail(403, "Wrong server instance");
  const d = db.prepare("SELECT * FROM launcher_devices WHERE token=?").get(hash(token)) as Device | undefined;
  if (!d || d.revoked) fail(401, "Computer revoked or unknown");
  owner(d.owner); return d;
}
function device(id: string): Device {
  const d = db.prepare("SELECT * FROM launcher_devices WHERE id=?").get(id) as Device | undefined;
  if (!d) fail(404, "Computer unavailable");
  return d;
}
export function listDevices(user: number, now = Date.now()) {
  owner(user);
  return { instanceId, devices: (db.prepare("SELECT * FROM launcher_devices WHERE owner=?").all(user) as Device[]).map(d => ({
    id: d.id, name: d.name, revoked: !!d.revoked,
    online: !d.revoked && now - (live.get(d.id)?.seen ?? 0) < LIVE_TTL,
    actions: JSON.parse(d.actions) as Action[],
  })) };
}
export function renameDevice(user: number, id: string, name: unknown) {
  owner(user); if (device(id).owner !== user) fail(404, "Computer unavailable");
  db.prepare("UPDATE launcher_devices SET name=? WHERE id=? AND owner=?").run(text(name), id, user);
}
export function revokeDevice(user: number, id: string) {
  owner(user); if (device(id).owner !== user) fail(404, "Computer unavailable");
  db.prepare("UPDATE launcher_devices SET revoked=1 WHERE id=? AND owner=?").run(id, user);
  live.delete(id);
  db.prepare("UPDATE launcher_commands SET status='failed',error='Computer revoked' WHERE device=? AND status='pending'").run(id);
}
export function hello(d: Device, approved: unknown, now = Date.now()) {
  const list = actions(approved), session = secret();
  db.prepare("UPDATE launcher_devices SET actions=? WHERE id=?").run(JSON.stringify(list), d.id);
  db.prepare("UPDATE launcher_commands SET status='expired',error='Companion reconnected' WHERE device=? AND status='pending'").run(d.id);
  live.set(d.id, { session, seen: now });
  return { session, instanceId };
}
function session(d: Device, s: unknown, now: number) {
  const l = live.get(d.id);
  if (!l || l.session !== s || now - l.seen >= LIVE_TTL) fail(409, "Session expired; reconnect");
  return l;
}
function expire(now: number) {
  db.prepare("UPDATE launcher_commands SET status='expired',error='Request expired' WHERE status='pending' AND expires<=?").run(now);
}
function view(c: Command) { return { id: c.id, status: c.status, expiresAt: c.expires, ...(c.error ? { error: c.error } : {}) }; }
export function queue(user: number, input: Record<string, unknown>, now = Date.now()) {
  owner(user);
  if (input.instanceId !== instanceId) fail(409, "Rebind this tile to this server instance");
  const id = text(input.requestId, 36);
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) fail(400, "Invalid request ID");
  const d = device(text(input.deviceId, 36)), action = text(input.actionId, 64);
  if (d.owner !== user || d.revoked) fail(410, "Computer revoked or unavailable");
  expire(now);
  const existing = db.prepare("SELECT * FROM launcher_commands WHERE id=?").get(id) as Command | undefined;
  if (existing) {
    if (existing.device !== d.id || existing.action !== action) fail(409, "Request ID already used");
    return view(existing);
  }
  if (!(JSON.parse(d.actions) as Action[]).some(a => a.id === action)) fail(410, "Approved action removed");
  const l = live.get(d.id);
  if (!l || now - l.seen >= LIVE_TTL) fail(409, "Computer offline");
  limit("commands", 60, now);
  if ((db.prepare("SELECT count(*) n FROM launcher_commands").get() as { n: number }).n >= 100000) fail(507, "Command history capacity reached; contact the server administrator");
  if (db.prepare("SELECT 1 FROM launcher_commands WHERE device=? AND status='pending'").get(d.id)) fail(409, "A launch is already pending");
  db.prepare("INSERT INTO launcher_commands VALUES (?,?,?,?,?,?,NULL)").run(id, d.id, action, l.session, "pending", now + COMMAND_TTL);
  return { id, status: "pending", expiresAt: now + COMMAND_TTL };
}
export function command(user: number, id: string, now = Date.now()) {
  owner(user); expire(now);
  const c = db.prepare("SELECT * FROM launcher_commands WHERE id=?").get(id) as Command | undefined;
  if (!c || device(c.device).owner !== user) fail(404, "Request unavailable");
  return view(c);
}
export function poll(d: Device, s: unknown, approved: unknown, now = Date.now()) {
  const l = session(d, s, now), list = actions(approved); l.seen = now;
  db.prepare("UPDATE launcher_devices SET actions=? WHERE id=?").run(JSON.stringify(list), d.id);
  expire(now);
  const pending = db.prepare("SELECT * FROM launcher_commands WHERE device=? AND session=? AND status='pending'").all(d.id, s) as Command[];
  const commands: { id: string; actionId: string; expiresAt: number }[] = [];
  for (const c of pending) {
    if (!list.some(a => a.id === c.action)) db.prepare("UPDATE launcher_commands SET status='failed',error='Approved action removed' WHERE id=?").run(c.id);
    else commands.push({ id: c.id, actionId: c.action, expiresAt: c.expires });
  }
  return { commands, serverTime: now };
}
// A one-shot grant: loss of this response must never be retried as a launch.
// Revocation/action removal is checked again at the last server round-trip.
export function accept(d: Device, s: unknown, id: string, now = Date.now()) {
  session(d, s, now); expire(now);
  const c = db.prepare("SELECT * FROM launcher_commands WHERE id=? AND device=?").get(id, d.id) as Command | undefined;
  if (!c || c.session !== s || c.status !== "pending") fail(409, "Request expired or already consumed");
  const current = device(d.id);
  if (current.revoked || !(JSON.parse(current.actions) as Action[]).some(a => a.id === c.action)) fail(410, "Action unavailable");
  db.prepare("UPDATE launcher_commands SET status='accepted' WHERE id=?").run(id);
  return { id, actionId: c.action, expiresAt: c.expires };
}
export function reportFailure(d: Device, s: unknown, id: string) {
  session(d, s, Date.now());
  db.prepare("UPDATE launcher_commands SET status='failed',error='Companion rejected or could not start application' WHERE id=? AND device=? AND session=? AND status IN ('pending','accepted')").run(id, d.id, s);
}
