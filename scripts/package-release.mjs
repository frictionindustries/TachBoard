#!/usr/bin/env node
/**
 * package-release.mjs — build a self-contained, runnable Tachboard bundle for
 * the CURRENT OS + CPU architecture.
 *
 * The bundle contains:
 *   bin/node(.exe)     — the exact Node runtime this script ran under
 *   server/            — the esbuild output of the API server (dist/)
 *   frontend-dist/     — the production Vite build of the dashboard
 *   node_modules/      — the runtime-external packages (better-sqlite3, sharp,
 *                        gamedig, isomorphic-dompurify) installed natively on
 *                        this machine, so native binaries always match the
 *                        bundled Node runtime and platform
 *   start.sh / start.bat — launch script (sets DATA_DIR, PORT, FRONTEND_DIST)
 *   README.txt         — per-platform install/run instructions
 *
 * IMPORTANT: this script must run ON the target platform (no cross-compiling
 * of native modules). The release workflow runs it once per OS/arch runner.
 *
 * Usage:  node scripts/package-release.mjs [--out release] [--no-archive]
 * Output: release/tachboard-<platform>-<arch>/  and
 *         release/tachboard-<platform>-<arch>.(tar.gz|zip)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outDir = path.resolve(repoRoot, argValue("--out") ?? "release");
const makeArchive = !args.includes("--no-archive");

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// Packages that build.mjs externalizes AND that the api-server actually
// depends on at runtime. They are installed (not bundled) so their native /
// asset-loading behavior works. Keep in sync with artifacts/api-server:
// build.mjs `external` list x package.json `dependencies`.
const RUNTIME_EXTERNALS = ["better-sqlite3", "sharp", "gamedig", "isomorphic-dompurify"];

const PLATFORM_NAMES = { linux: "linux", darwin: "macos", win32: "windows" };
const plat = PLATFORM_NAMES[process.platform];
if (!plat) throw new Error(`Unsupported platform: ${process.platform}`);
const arch = process.arch; // x64 | arm64
const isWindows = process.platform === "win32";
const bundleName = `tachboard-${plat}-${arch}`;
const stage = path.join(outDir, bundleName);

const serverDist = path.join(repoRoot, "artifacts/api-server/dist");
const frontendDist = path.join(repoRoot, "artifacts/homelab-dashboard/dist/public");
if (!fs.existsSync(path.join(serverDist, "index.mjs"))) {
  throw new Error(`Missing ${serverDist}/index.mjs — run: pnpm --filter @workspace/api-server run build`);
}
if (!fs.existsSync(path.join(frontendDist, "index.html"))) {
  throw new Error(`Missing ${frontendDist}/index.html — run the dashboard production build first`);
}

console.log(`[package] staging ${bundleName} …`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 1. Server bundle + frontend
fs.cpSync(serverDist, path.join(stage, "server"), { recursive: true });
fs.cpSync(frontendDist, path.join(stage, "frontend-dist"), { recursive: true });

// 2. Node runtime — copy the exact binary running this script. This guarantees
// the ABI of the native modules installed below matches the shipped runtime.
const nodeName = isWindows ? "node.exe" : "node";
fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
fs.copyFileSync(process.execPath, path.join(stage, "bin", nodeName));
if (!isWindows) fs.chmodSync(path.join(stage, "bin", nodeName), 0o755);

// 3. Runtime-external packages, pinned to the exact versions the workspace
// resolved, installed natively in the stage dir. Node's ESM resolution walks
// up from server/index.mjs to <stage>/node_modules, so this "just works".
const deps = {};
for (const name of RUNTIME_EXTERNALS) {
  const pkgJson = path.join(repoRoot, "artifacts/api-server/node_modules", name, "package.json");
  deps[name] = JSON.parse(fs.readFileSync(pkgJson, "utf8")).version;
}
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify({ name: "tachboard-bundle", private: true, version: "0.0.0", dependencies: deps }, null, 2),
);
console.log(`[package] npm install runtime externals: ${JSON.stringify(deps)}`);
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"], {
  cwd: stage,
  stdio: "inherit",
  shell: isWindows, // npm is npm.cmd on Windows
});

// 4. Launch scripts
const startSh = `#!/bin/sh
# Tachboard launcher — data lives in ./data next to this script by default.
DIR="$(cd "$(dirname "$0")" && pwd)"
export NODE_ENV=production
export PORT="\${PORT:-20028}"
export DATA_DIR="\${DATA_DIR:-$DIR/data}"
export FRONTEND_DIST="$DIR/frontend-dist"
mkdir -p "$DATA_DIR"
echo "Tachboard starting — open http://localhost:$PORT once it's up."
echo "Data directory: $DATA_DIR"
exec "$DIR/bin/node" --enable-source-maps "$DIR/server/index.mjs"
`;
const startBat = `@echo off\r
rem Tachboard launcher - data lives in .\\data next to this script by default.\r
setlocal\r
set "DIR=%~dp0"\r
set "NODE_ENV=production"\r
if "%PORT%"=="" set "PORT=20028"\r
if "%DATA_DIR%"=="" set "DATA_DIR=%DIR%data"\r
set "FRONTEND_DIST=%DIR%frontend-dist"\r
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"\r
echo Tachboard starting - open http://localhost:%PORT% once it's up.\r
echo Data directory: %DATA_DIR%\r
"%DIR%bin\\node.exe" --enable-source-maps "%DIR%server\\index.mjs"\r
`;
if (isWindows) {
  fs.writeFileSync(path.join(stage, "start.bat"), startBat);
} else {
  fs.writeFileSync(path.join(stage, "start.sh"), startSh);
  fs.chmodSync(path.join(stage, "start.sh"), 0o755);
}

// 5. README
const bypass =
  plat === "macos"
    ? `macOS Gatekeeper note
--------------------
This bundle is not notarized. Because the archive was downloaded from the
internet, macOS quarantines it. Clear the quarantine flag once, then run:

    xattr -dr com.apple.quarantine <this folder>
    ./start.sh
`
    : plat === "windows"
      ? `Windows SmartScreen note
------------------------
This bundle is not code-signed. If SmartScreen appears when you run
start.bat, click "More info" -> "Run anyway". You can also right-click the
downloaded .zip -> Properties -> check "Unblock" before extracting.
`
      : `Linux note
----------
Most users should prefer the Docker image (works on TrueNAS SCALE too). This
bundle is for hosts without Docker.
`;
fs.writeFileSync(
  path.join(stage, "README.txt"),
  `Tachboard ${bundleName}
${"=".repeat(11 + bundleName.length)}

A self-hosted homelab dashboard. This bundle includes its own Node runtime —
you do not need Node, npm, or build tools installed.

Run it
------
${isWindows ? "  Double-click start.bat (or run it from a terminal)." : "  ./start.sh"}

Then open http://localhost:20028 in your browser and register your account.

Configuration (environment variables, all optional)
----------------------------------------------------
  PORT        Port to listen on. Default: 20028
  DATA_DIR    Where the SQLite database, uploaded images, and the generated
              JWT secret live. Default: the "data" folder next to the launcher.
              Back this folder up; deleting it resets the app.
  JWT_SECRET  Auth token signing secret. If unset, a strong random secret is
              generated on first run and persisted at DATA_DIR/jwt-secret, so
              logins survive restarts. Set your own to override.

${bypass}
Upgrading
---------
Stop the server, replace this folder with the new release, keep (or point
DATA_DIR at) your existing data folder, and start it again.
`,
);

console.log(`[package] staged at ${stage}`);

// 6. Archive (zip on Windows, tar.gz elsewhere). GitHub runners ship bsdtar on
// Windows/macOS, GNU tar on Linux; both handle these invocations.
if (makeArchive) {
  const archiveName = isWindows ? `${bundleName}.zip` : `${bundleName}.tar.gz`;
  const archivePath = path.join(outDir, archiveName);
  fs.rmSync(archivePath, { force: true });
  const tarArgs = isWindows
    ? ["-a", "-c", "-f", archiveName, bundleName] // bsdtar: -a picks zip from suffix
    : ["-czf", archiveName, bundleName];
  execFileSync("tar", tarArgs, { cwd: outDir, stdio: "inherit" });
  console.log(`[package] archive: ${archivePath}`);
}
console.log(`[package] done: ${bundleName}`);
