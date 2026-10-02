import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url);
const workspace = readFileSync(new URL("pnpm-workspace.yaml", root), "utf8");
const lock = readFileSync(new URL("pnpm-lock.yaml", root), "utf8");

// Frozen installs must contain the native optional dependencies for EVERY
// release runner, not just the machine on which pnpm regenerated the lockfile.
const platforms = {
  "linux-x64": ["linux-x64", "linux-x64-gnu", "linux-x64-gnu", "linux-x64-gnu"],
  "linux-arm64": ["linux-arm64", "linux-arm64-gnu", "linux-arm64-gnu", "linux-arm64-gnu"],
  "macos-x64": ["darwin-x64", "darwin-x64", "darwin-x64", "darwin-x64"],
  "macos-arm64": ["darwin-arm64", "darwin-arm64", "darwin-arm64", "darwin-arm64"],
  "windows-x64": ["win32-x64", "win32-x64-msvc", "win32-x64-msvc", "win32-x64-msvc"],
};
const tools = [
  ["esbuild", "@esbuild/"],
  ["rollup", "@rollup/rollup-"],
  ["lightningcss", "lightningcss-"],
  ["@tailwindcss/oxide", "@tailwindcss/oxide-"],
];

describe("release platform dependencies", () => {
  for (const [platform, suffixes] of Object.entries(platforms)) {
    it(`preserves native build dependencies for ${platform}`, () => {
      tools.forEach(([parent, prefix], index) => {
        const name = `${prefix}${suffixes[index]}`;
        expect(workspace, `${name} must not be excluded`).not.toContain(`${parent}>${name}:`);
        expect(workspace, `${name} must not be excluded`).not.toContain(`${parent}>${name}'`);
        expect(workspace, `${name} must not be excluded`).not.toContain(`${parent}>${name}"`);
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(lock, `${name} needs a locked package`).toMatch(
          new RegExp(`^  ['"]?${escaped}@[^\\n]+:`, "m"),
        );
        expect(lock, `${name} must remain an optional dependency`).toMatch(
          new RegExp(`^      ['"]?${escaped}['"]?: `, "m"),
        );
      });
    });
  }
});