import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return port;
}

// Every caller owns exactly one mkdtemp directory. No supplied DATA_DIR, database
// path, username prefix, or remote server can become a cleanup target.
export async function startIsolatedServer({ web = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "tachboard-e2e-"));
  const children = [];
  let logs = "";
  function launch(args, env, cwd) {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.on("error", e => { logs += String(e); });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", chunk => { logs = (logs + chunk).slice(-8000); });
    }
    return child;
  }
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const child of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
    await rm(dataDir, { recursive: true, force: true });
  }
  async function ready(url, child) {
    for (let n = 0; n < 300; n++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Isolated test server exited:\n${logs}`);
      }
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch { /* Still starting. */ }
      await delay(100);
    }
    throw new Error(`Isolated test server did not become ready:\n${logs}`);
  }
  try {
    const apiPort = await freePort();
    const apiURL = `http://127.0.0.1:${apiPort}`;
    // Do not seed test accounts with real service credentials from the shell.
    const api = launch([resolve("artifacts/api-server/dist/index.mjs")], {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      PORT: String(apiPort),
      DATA_DIR: dataDir,
      JWT_SECRET: randomBytes(32).toString("hex"),
    }, resolve("artifacts/api-server"));
    await ready(`${apiURL}/api/healthz`, api);
    let baseURL = apiURL;
    if (web) {
      const webPort = await freePort();
      baseURL = `http://127.0.0.1:${webPort}`;
      const vite = launch([resolve("artifacts/homelab-dashboard/node_modules/vite/bin/vite.js")], {
        PATH: process.env.PATH,
        NODE_ENV: "development",
        PORT: String(webPort),
        BASE_PATH: "/",
        VITE_FORCE_API_PROXY: "1",
        VITE_API_PROXY_TARGET: apiURL,
      }, resolve("artifacts/homelab-dashboard"));
      await ready(`${baseURL}/api/healthz`, vite);
    }
    return { baseURL, dataDir, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}