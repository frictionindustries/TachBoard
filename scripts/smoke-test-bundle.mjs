#!/usr/bin/env node
/**
 * smoke-test-bundle.mjs — boot a packaged Tachboard bundle with its OWN Node
 * runtime and verify the release-critical paths before the artifact ships:
 *
 *   1. Native modules load and work (better-sqlite3 insert/select in-memory,
 *      sharp encodes a PNG) under the bundled runtime — catches wrong-ABI /
 *      wrong-platform binaries.
 *   2. The server boots, /api/healthz answers 200.
 *   3. The frontend is served (GET / returns the SPA index.html).
 *   4. SQLite persistence works in a scratch DATA_DIR (register a user via
 *      the real API, then read it back after checking the DB file exists).
 *
 * Usage: node scripts/smoke-test-bundle.mjs <bundle-dir> [port]
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bundleDir = path.resolve(process.argv[2] ?? "");
const port = Number(process.argv[3] ?? 20095);
if (!bundleDir || !fs.existsSync(bundleDir)) {
  console.error("Usage: node scripts/smoke-test-bundle.mjs <bundle-dir> [port]");
  process.exit(2);
}
const nodeBin = path.join(bundleDir, "bin", process.platform === "win32" ? "node.exe" : "node");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tachboard-smoke-"));
const base = `http://127.0.0.1:${port}`;

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

// ── 1. Native module probe under the bundled runtime ─────────────────────
const probe = path.join(bundleDir, "smoke-probe.cjs");
fs.writeFileSync(
  probe,
  `const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.exec("CREATE TABLE t (v TEXT)");
db.prepare("INSERT INTO t (v) VALUES (?)").run("ok");
if (db.prepare("SELECT v FROM t").get().v !== "ok") throw new Error("sqlite roundtrip failed");
console.log("[smoke] better-sqlite3 OK (" + db.prepare("select sqlite_version() v").get().v + ")");
const sharp = require("sharp");
sharp({ create: { width: 4, height: 4, channels: 3, background: "#f00" } })
  .png().toBuffer()
  .then((buf) => {
    if (buf.length < 8) throw new Error("sharp produced empty output");
    console.log("[smoke] sharp OK (" + buf.length + " byte png)");
  })
  .catch((e) => { console.error(e); process.exit(1); });
`,
);
try {
  execFileSync(nodeBin, [probe], { cwd: bundleDir, stdio: "inherit" });
} catch {
  fail("native module probe failed (better-sqlite3 / sharp)");
} finally {
  fs.rmSync(probe, { force: true });
}

// ── 2-4. Boot the server and hit it ───────────────────────────────────────
const child = spawn(nodeBin, ["--enable-source-maps", path.join(bundleDir, "server", "index.mjs")], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATA_DIR: dataDir,
    FRONTEND_DIST: path.join(bundleDir, "frontend-dist"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
child.on("exit", (code) => {
  if (!done) fail(`server exited early with code ${code}`);
});
let done = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForHealth(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  fail("server did not answer /api/healthz in time");
}

try {
  await waitForHealth();
  console.log("[smoke] /api/healthz OK");

  const index = await fetch(`${base}/`);
  const html = await index.text();
  if (!index.ok || !html.toLowerCase().includes("<!doctype html")) fail("frontend index.html not served at /");
  console.log("[smoke] frontend served OK");

  // Real end-to-end persistence: register + login through the API.
  const creds = { username: "smoketest", password: "smoke-test-password-1" };
  const reg = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!reg.ok) fail(`register failed: ${reg.status} ${await reg.text()}`);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!login.ok) fail(`login failed: ${login.status}`);
  console.log("[smoke] register + login OK (SQLite persistence works)");

  const dbFiles = fs.readdirSync(dataDir);
  if (!dbFiles.some((f) => f.includes(".db") || f.includes("sqlite"))) {
    fail(`no SQLite database file appeared in DATA_DIR (${dataDir}): ${dbFiles.join(", ")}`);
  }
  if (!fs.existsSync(path.join(dataDir, "jwt-secret"))) {
    fail("jwt-secret was not auto-generated in DATA_DIR");
  }
  console.log("[smoke] DATA_DIR contains database + persisted jwt-secret OK");

  console.log("[smoke] PASS — bundle is releasable");
  done = true;
} finally {
  child.kill("SIGTERM");
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
