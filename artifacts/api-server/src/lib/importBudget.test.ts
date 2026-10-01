import { describe, expect, it, vi } from "vitest";
import {
  createPageNameAllocator,
  importBudgetError,
  MAX_IMPORT_PAGES,
  MAX_IMPORT_LAYOUTS,
  MAX_IMPORT_TILE_ENTRIES,
} from "./importBudget.js";

describe("import resource budget", () => {
  it("accepts the exact collection limits", () => {
    expect(importBudgetError({
      pages: Array.from({ length: MAX_IMPORT_PAGES }, (_, i) => ({
        tiles: i === 0 ? Array(MAX_IMPORT_TILE_ENTRIES).fill({}) : [],
        layouts: i === 0 ? Array(MAX_IMPORT_LAYOUTS).fill({ tiles: [] }) : [],
      })),
      deviceModes: Array(100).fill({}),
      connections: Array(200).fill({}),
    })).toBeNull();
  });

  it("rejects excessive pages before traversing their entries", () => {
    const pages = Array(MAX_IMPORT_PAGES + 1);
    Object.defineProperty(pages, 0, { get() { throw new Error("visited page"); } });
    expect(importBudgetError({ pages })).toContain("100 pages");
  });

  it("counts layouts and tile entries across pages and both v2 representations", () => {
    expect(importBudgetError({ pages: [
      { layouts: Array(250).fill({}) }, { layouts: Array(251).fill({}) },
    ] })).toContain("500 layouts");
    expect(importBudgetError({ pages: [
      { tiles: Array(2000).fill({}) },
      { layouts: [{ tiles: Array(2001).fill({}) }] },
    ] })).toContain("4000 tile entries");
    expect(importBudgetError({ deviceModes: Array(101) })).toContain("100 device modes");
    expect(importBudgetError({ connections: Array(201) })).toContain("200 connections");
  });

  it("leaves malformed types to the schema validator", () => {
    for (const body of [null, [], 1, {}, { pages: [null, 3, { layouts: [null, {}] }] }]) {
      expect(importBudgetError(body)).toBeNull();
    }
  });
});

describe("page name allocation", () => {
  it("preserves first-free suffix behavior with gaps, nested suffixes, and interleaved bases", () => {
    const next = createPageNameAllocator(["x", "x (3)", "y"]);
    expect(next("x")).toBe("x (2)");
    expect(next("y")).toBe("y (2)");
    expect(next("x")).toBe("x (4)");
    expect(next("x (2)")).toBe("x (2) (2)");
    expect(next("x (5)")).toBe("x (5)");
    expect(next("x")).toBe("x (6)");
    expect(next("z")).toBe("z");
  });

  it("uses linear set lookups for 15,000 duplicate names, including existing suffixes", () => {
    const next = createPageNameAllocator([
      "x", ...Array.from({ length: 15000 }, (_, i) => `x (${i + 2})`),
    ]);
    const has = vi.spyOn(Set.prototype, "has");
    let last = "";
    for (let i = 0; i < 15000; i++) last = next("x");
    const calls = has.mock.calls.length;
    has.mockRestore();
    expect(last).toBe("x (30001)");
    expect(calls).toBeLessThanOrEqual(60000);
  });
});