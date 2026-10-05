import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packagePi } from "./package-pi.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Pi archive contains installer, intact relative links, and matching checksum", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-test-"));
  try {
    const bundle = path.join(out, "tachboard-linux-arm64");
    for (const name of ["bin/node", "server/index.mjs", "frontend-dist/index.html", "node_modules/tool/index.js"]) {
      const target = path.join(bundle, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "fixture only");
    }
    fs.mkdirSync(path.join(bundle, "node_modules/.bin"));
    fs.symlinkSync("../tool/index.js", path.join(bundle, "node_modules/.bin/tool"));
    const archive = await packagePi(root, out);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    assert.equal(fs.readFileSync(archive + ".sha256", "utf8"),
      `${hash}  tachboard-pi-arm64.tar.gz\n`);
    const unpack = path.join(out, "unpack");
    fs.mkdirSync(unpack);
    execFileSync("tar", ["-xzf", archive, "-C", unpack]);
    const extracted = path.join(unpack, "tachboard-pi");
    for (const file of ["install.py", "config.py", "kiosk.py", "README.md", "offline.html", "bundle/server/index.mjs"]) {
      assert.ok(fs.existsSync(path.join(extracted, file)), file);
    }
    assert.equal(fs.readlinkSync(path.join(extracted, "bundle/node_modules/.bin/tool")), "../tool/index.js");
    fs.rmSync(path.join(out, "tachboard-linux-arm64"), { recursive: true });
    assert.equal(fs.readFileSync(path.join(extracted, "bundle/node_modules/.bin/tool"), "utf8"), "fixture only");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("Pi packaging fails explicitly without the server bundle", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missing-test-"));
  try {
    await assert.rejects(packagePi(root, out), /Missing ARM64 bundle file/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});