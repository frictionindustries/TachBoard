import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The release-manifest renderer lives at the repo root; this test drives it
// end-to-end against dummy archives so a renamed archive, a new unrendered
// placeholder, or bad semver handling fails CI before a tag ships.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const script = path.join(repoRoot, "scripts", "render-packaging.mjs");

const ARCHIVES = [
  "tachboard-macos-arm64.tar.gz",
  "tachboard-macos-x64.tar.gz",
  "tachboard-linux-arm64.tar.gz",
  "tachboard-linux-x64.tar.gz",
  "tachboard-windows-x64.zip",
] as const;

const VERSION = "9.8.7";
const REPO = "acme/tachboard";

let tmp: string;
let archivesDir: string;
let outDir: string;
const sha: Record<string, string> = {};

function runRender(args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function defaultArgs(overrides: Partial<Record<"version" | "repo" | "archives" | "out", string>> = {}) {
  const a = { version: VERSION, repo: REPO, archives: archivesDir, out: outDir, ...overrides };
  return ["--version", a.version, "--repo", a.repo, "--archives", a.archives, "--out", a.out];
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-packaging-"));
  archivesDir = path.join(tmp, "archives");
  outDir = path.join(tmp, "out");
  fs.mkdirSync(archivesDir, { recursive: true });
  for (const name of ARCHIVES) {
    const content = `dummy archive content for ${name}\n`;
    fs.writeFileSync(path.join(archivesDir, name), content);
    sha[name] = crypto.createHash("sha256").update(content).digest("hex");
  }
  // Render once up front; the output-inspection tests below read from outDir
  // and are independent of each other's ordering.
  runRender(defaultArgs());
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("render-packaging.mjs", () => {
  it("renders the formula with the correct sha256 for every archive", () => {
    const formula = fs.readFileSync(path.join(outDir, "homebrew", "Formula", "tachboard.rb"), "utf8");
    expect(formula).toContain(`version "${VERSION}"`);
    expect(formula).toContain(sha["tachboard-macos-arm64.tar.gz"]);
    expect(formula).toContain(sha["tachboard-macos-x64.tar.gz"]);
    expect(formula).toContain(sha["tachboard-linux-arm64.tar.gz"]);
    expect(formula).toContain(sha["tachboard-linux-x64.tar.gz"]);
    expect(formula).toContain(
      `https://github.com/acme/tachboard/releases/download/v${VERSION}/tachboard-macos-arm64.tar.gz`,
    );
  });

  it("puts the windows sha in the winget installer manifest under manifests/t/Tachboard/Tachboard/<version>/", () => {
    const wingetDir = path.join(outDir, "winget", "manifests", "t", "Tachboard", "Tachboard", VERSION);
    const files = fs.readdirSync(wingetDir).sort();
    expect(files).toEqual([
      "Tachboard.Tachboard.installer.yaml",
      "Tachboard.Tachboard.locale.en-US.yaml",
      "Tachboard.Tachboard.yaml",
    ]);
    const installer = fs.readFileSync(path.join(wingetDir, "Tachboard.Tachboard.installer.yaml"), "utf8");
    expect(installer).toContain(`InstallerSha256: ${sha["tachboard-windows-x64.zip"]}`);
    expect(installer).toContain(`PackageVersion: "${VERSION}"`);
  });

  it("leaves no __PLACEHOLDER__ strings anywhere in the output", () => {
    const rendered = [...walk(outDir)];
    expect(rendered.length).toBeGreaterThan(4); // formula + 3 winget + truenas files
    for (const file of rendered) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, `unrendered placeholder in ${file}`).not.toMatch(/__[A-Z0-9_]+__/);
    }
  });

  it("renders the truenas entry with version and repo", () => {
    const appYaml = fs.readFileSync(path.join(outDir, "truenas", "tachboard", "app.yaml"), "utf8");
    expect(appYaml).toContain(`app_version: "${VERSION}"`);
    expect(appYaml).toContain("https://github.com/acme/tachboard");
    const ixValues = fs.readFileSync(path.join(outDir, "truenas", "tachboard", "ix_values.yaml"), "utf8");
    expect(ixValues).toContain(`tag: "${VERSION}"`);
  });

  it("strips a leading v from the version", () => {
    const vOut = path.join(tmp, "out-vprefix");
    runRender(defaultArgs({ version: `v${VERSION}`, out: vOut }));
    const wingetDir = path.join(vOut, "winget", "manifests", "t", "Tachboard", "Tachboard", VERSION);
    expect(fs.existsSync(path.join(wingetDir, "Tachboard.Tachboard.yaml"))).toBe(true);
  });

  it("fails when a release archive is missing", () => {
    const partialDir = path.join(tmp, "archives-partial");
    fs.mkdirSync(partialDir, { recursive: true });
    for (const name of ARCHIVES) {
      if (name === "tachboard-linux-x64.tar.gz") continue;
      fs.copyFileSync(path.join(archivesDir, name), path.join(partialDir, name));
    }
    const failOut = path.join(tmp, "out-missing");
    expect(() => runRender(defaultArgs({ archives: partialDir, out: failOut }))).toThrow(/missing release archive/);
  });

  it("rejects versions that are not full semver", () => {
    for (const bad of ["latest", "1.2", "1.2.3foo", "1.2.3.4", "1.2.3-", "1.2.3 && echo pwn"]) {
      expect(() => runRender(defaultArgs({ version: bad, out: path.join(tmp, "out-badver") })), bad).toThrow(
        /doesn't look like semver/,
      );
    }
  });

  it("accepts semver with prerelease/build metadata", () => {
    const preOut = path.join(tmp, "out-prerelease");
    runRender(defaultArgs({ version: "1.2.3-rc.1+build.5", out: preOut }));
    const formula = fs.readFileSync(path.join(preOut, "homebrew", "Formula", "tachboard.rb"), "utf8");
    expect(formula).toContain('version "1.2.3-rc.1+build.5"');
  });

  it("rejects repos that are not exactly owner/name", () => {
    for (const bad of ["just-a-name", "a/b/c", "/name", "owner/", "ow ner/name", "owner/na me"]) {
      expect(() => runRender(defaultArgs({ repo: bad, out: path.join(tmp, "out-badrepo") })), bad).toThrow(
        /--repo must be owner\/name/,
      );
    }
  });
});
