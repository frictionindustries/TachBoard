import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIsolatedServer } from "./isolated-server.mjs";

test("cleanup after failure removes only owned data; concurrent servers stay independent", async () => {
  const unrelated = await mkdtemp(join(tmpdir(), "tachboard-sentinel-"));
  const sentinel = join(unrelated, "real-user-data");
  await writeFile(sentinel, "do not touch");
  const servers = [];
  try {
    servers.push(await startIsolatedServer({ web: false }));
    servers.push(await startIsolatedServer({ web: false }));
    for (const server of servers) {
      const response = await fetch(`${server.baseURL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "independent", password: "Test-password-123!" }),
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).user.id, 1);
    }
    await assert.rejects(async () => {
      try {
        throw new Error("simulated assertion failure");
      } finally {
        await servers[0].stop();
      }
    }, /simulated assertion failure/);
    await assert.rejects(access(servers[0].dataDir), { code: "ENOENT" });
    await servers[0].stop(); // Cleanup is idempotent.
    assert.equal((await fetch(`${servers[1].baseURL}/api/healthz`)).status, 200);
    assert.equal(await readFile(sentinel, "utf8"), "do not touch");
  } finally {
    await Promise.all(servers.map(server => server.stop()));
    await rm(unrelated, { recursive: true, force: true });
  }
  for (const server of servers) {
    await assert.rejects(access(server.dataDir), { code: "ENOENT" });
  }
});

test("every browser spec uses the isolated fixture", async () => {
  for (const name of await readdir(new URL(".", import.meta.url))) {
    if (!name.endsWith(".spec.ts")) continue;
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.match(source, /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']\.\/fixtures["']/, name);
    assert.doesNotMatch(source, /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/, name);
  }
});