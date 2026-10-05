#!/usr/bin/env node
// Assemble on the native ARM64 runner AFTER the standard bundle smoke test.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function packagePi(root, out) {
  const bundle = path.join(out, "tachboard-linux-arm64");
  for (const file of ["bin/node", "server/index.mjs", "frontend-dist/index.html", "node_modules"]) {
    if (!fs.existsSync(path.join(bundle, file))) throw new Error(`Missing ARM64 bundle file: ${file}`);
  }
  const stage = path.join(out, "tachboard-pi");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const name of ["install.py", "config.py", "kiosk.py", "offline.html", "README.md"]) {
    fs.copyFileSync(path.join(root, "packaging/pi", name), path.join(stage, name));
  }
  // npm's .bin links must remain relative and valid after unpacking elsewhere.
  fs.cpSync(bundle, path.join(stage, "bundle"), { recursive: true, verbatimSymlinks: true });
  const filename = "tachboard-pi-arm64.tar.gz";
  const archive = path.join(out, filename);
  execFileSync("tar", ["-czf", archive, "-C", out, "tachboard-pi"], { stdio: "inherit" });
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  fs.writeFileSync(`${archive}.sha256`, `${hash.digest("hex")}  ${filename}\n`);
  console.log(`Pi installer bundle: ${archive}`);
  return archive;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("Pi releases must be assembled on Linux ARM64 with the native bundle.");
  }
  await packagePi(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    path.resolve(process.argv[2] ?? "release"));
}