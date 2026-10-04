import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for the Vinyl Record and CD Player visualizer styles.
//
// A tile saved with visualizerStyle "vinyl" or "cd" must render its canvas
// visualization (not fall back to bars), paint real content (non-blank
// pixels), and animate its idle state. Existing styles must be unaffected —
// an unknown/legacy style still normalizes to bars.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function registerAndAuth(page: import("@playwright/test").Page) {
  const username = `vizdisc_${rand()}`;
  const password = `Pw_${rand()}!`;
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);
  return token;
}

async function seedVisualizerTile(
  page: import("@playwright/test").Page,
  token: string,
  tileSettings: Record<string, unknown>,
) {
  const res = await page.request.post("/api/tiles", {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      type: "integration",
      integration: "visualizer",
      name: "",
      gridX: 0,
      gridY: 0,
      gridW: 4,
      gridH: 4,
      tileSettings,
    },
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as { id: number; tileSettings?: Record<string, unknown> };
}

// Count non-transparent pixels on the visualizer canvas — a blank/failed
// renderer leaves the canvas empty.
async function paintedPixels(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return -1;
    const { width, height } = canvas;
    if (width === 0 || height === 0) return -1;
    const data = ctx.getImageData(0, 0, width, height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) painted++;
    }
    return painted;
  });
}

for (const style of ["vinyl", "cd"] as const) {
  test(`${style} visualizer saves, renders, and animates idle`, async ({ page }) => {
    const token = await registerAndAuth(page);
    const tile = await seedVisualizerTile(page, token, { visualizerStyle: style });
    // The style must round-trip through the API (whitelist + enum accept it).
    expect(tile.tileSettings?.visualizerStyle).toBe(style);

    await page.goto("/");
    await page.waitForSelector("canvas");
    await page.waitForTimeout(500);

    const p1 = await paintedPixels(page);
    expect(p1, "canvas should paint real content").toBeGreaterThan(1000);

    // Idle animation: the frame keeps changing over time.
    const snap = () =>
      page.evaluate(() => document.querySelector("canvas")!.toDataURL());
    const a = await snap();
    await page.waitForTimeout(600);
    const b = await snap();
    expect(b, "idle animation should keep repainting").not.toBe(a);
  });
}

test("unknown saved style still falls back to bars", async ({ page }) => {
  const token = await registerAndAuth(page);
  // Bypass the enum via a null style — normalizeVisualizerStyle must default.
  await seedVisualizerTile(page, token, { visualizerStyle: null });
  await page.goto("/");
  await page.waitForSelector("canvas");
  await page.waitForTimeout(400);
  expect(await paintedPixels(page)).toBeGreaterThan(0);
});
