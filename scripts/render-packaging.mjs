#!/usr/bin/env node
/**
 * Renders the packaging templates (Homebrew formula, winget manifests,
 * TrueNAS catalog entry) with a concrete version, repo slug, and the sha256
 * of each release archive.
 *
 * Usage:
 *   node scripts/render-packaging.mjs \
 *     --version 1.2.3 --repo owner/name \
 *     --archives <dir with the five release archives> \
 *     --out packaging-out
 *
 * Archives are located by their canonical names (tachboard-<target>.<ext>);
 * every one of the five must be present — a missing archive means the render
 * would ship a formula/manifest pointing at a nonexistent asset, so we fail.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

const version = arg("version").replace(/^v/, "");
const repo = arg("repo"); // owner/name
const archivesDir = arg("archives");
const outDir = arg("out");
const repoParts = repo.split("/");
const [owner, repoName] = repoParts;
if (repoParts.length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(owner ?? "") || !/^[A-Za-z0-9_.-]+$/.test(repoName ?? ""))
  throw new Error(`--repo must be owner/name, got: ${repo}`);
// Full semver: MAJOR.MINOR.PATCH with optional -prerelease and +build.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version))
  throw new Error(`--version doesn't look like semver: ${version}`);

const ARCHIVES = {
  SHA_MACOS_ARM64: "tachboard-macos-arm64.tar.gz",
  SHA_MACOS_X64: "tachboard-macos-x64.tar.gz",
  SHA_LINUX_ARM64: "tachboard-linux-arm64.tar.gz",
  SHA_LINUX_X64: "tachboard-linux-x64.tar.gz",
  SHA_WINDOWS_X64: "tachboard-windows-x64.zip",
};

const vars = { VERSION: version, OWNER: owner, REPO: repoName };
for (const [key, file] of Object.entries(ARCHIVES)) {
  const p = path.join(archivesDir, file);
  if (!fs.existsSync(p)) throw new Error(`missing release archive: ${p}`);
  vars[key] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  console.log(`[render] ${file}  sha256=${vars[key]}`);
}

function render(text) {
  const out = text.replace(/__([A-Z0-9_]+)__/g, (m, name) => {
    if (!(name in vars)) throw new Error(`unknown placeholder ${m}`);
    return vars[name];
  });
  const leftover = out.match(/__[A-Z0-9_]+__/);
  if (leftover) throw new Error(`unrendered placeholder ${leftover[0]}`);
  return out;
}

const pkgRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "packaging");

/** Copy a file, rendering placeholders and dropping a trailing .tmpl. */
function emit(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, render(fs.readFileSync(src, "utf8")));
  console.log(`[render] wrote ${dest}`);
}

// Homebrew: tap layout (Formula/tachboard.rb)
emit(
  path.join(pkgRoot, "homebrew", "Formula", "tachboard.rb.tmpl"),
  path.join(outDir, "homebrew", "Formula", "tachboard.rb"),
);

// winget: manifests/t/Tachboard/Tachboard/<version>/ (winget-pkgs layout)
const wingetDest = path.join(outDir, "winget", "manifests", "t", "Tachboard", "Tachboard", version);
for (const f of [
  "Tachboard.Tachboard.yaml",
  "Tachboard.Tachboard.installer.yaml",
  "Tachboard.Tachboard.locale.en-US.yaml",
]) {
  emit(path.join(pkgRoot, "winget", `${f}.tmpl`), path.join(wingetDest, f));
}

// TrueNAS: whole catalog entry, rendered in place structure
const truenasSrc = path.join(pkgRoot, "truenas", "tachboard");
for (const rel of fs.readdirSync(truenasSrc, { recursive: true })) {
  const src = path.join(truenasSrc, String(rel));
  if (fs.statSync(src).isDirectory()) continue;
  emit(src, path.join(outDir, "truenas", "tachboard", String(rel)));
}

console.log(`[render] done → ${outDir}`);
