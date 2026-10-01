// Check collection sizes before schema parsing or synchronous SQLite work.
// Count both v2 tile representations: even the unused flat list costs parsing.
export const MAX_IMPORT_PAGES = 100;
export const MAX_IMPORT_LAYOUTS = 500;
export const MAX_IMPORT_TILE_ENTRIES = 4000;

export function importBudgetError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as Record<string, unknown>;
  if (Array.isArray(envelope.deviceModes) && envelope.deviceModes.length > 100) {
    return "An import can contain at most 100 device modes.";
  }
  if (Array.isArray(envelope.connections) && envelope.connections.length > 200) {
    return "An import can contain at most 200 connections.";
  }
  if (!Array.isArray(envelope.pages)) return null;
  if (envelope.pages.length > MAX_IMPORT_PAGES) {
    return `An import can contain at most ${MAX_IMPORT_PAGES} pages.`;
  }
  let layouts = 0;
  let tiles = 0;
  for (const page of envelope.pages) {
    if (!page || typeof page !== "object") continue;
    if (Array.isArray(page.tiles)) tiles += page.tiles.length;
    if (Array.isArray(page.layouts)) {
      layouts += page.layouts.length;
      if (layouts > MAX_IMPORT_LAYOUTS) {
        return `An import can contain at most ${MAX_IMPORT_LAYOUTS} layouts.`;
      }
      for (const layout of page.layouts) {
        if (layout && Array.isArray(layout.tiles)) tiles += layout.tiles.length;
      }
    }
    if (tiles > MAX_IMPORT_TILE_ENTRIES) {
      return `An import can contain at most ${MAX_IMPORT_TILE_ENTRIES} tile entries (including flat and layout copies).`;
    }
  }
  return null;
}

// This allocator owns an append-only set for one import. Remember the next
// suffix per base so repeated names don't rescan all previously allocated names.
export function createPageNameAllocator(existing: Iterable<string>) {
  const taken = new Set(existing);
  const nextSuffix = new Map<string, number>();
  return (base: string): string => {
    let name = base;
    if (taken.has(name)) {
      let n = nextSuffix.get(base) ?? 2;
      while (taken.has(`${base} (${n})`)) n++;
      name = `${base} (${n})`;
      nextSuffix.set(base, n + 1);
    }
    taken.add(name);
    return name;
  };
}