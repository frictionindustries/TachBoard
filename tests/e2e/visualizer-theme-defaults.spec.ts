import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for theme-aware Audio Visualizer default colors.
//
// A visualizer tile with NO visualizerPrimary/visualizerBackground set must
// derive its colors from the active theme (--primary and a dark surface) and
// re-color live when the theme changes — no reload. Explicit custom colors
// must always win and stay untouched by theme switches.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function registerAndAuth(page: import("@playwright/test").Page) {
  const username = `viztheme_${rand()}`;
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
}

// The visualizer's outer wrapper carries the resolved background as an inline
// style; a canvas child confirms we found the visualizer and not another tile.
async function readVisualizerBackground(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    for (const c of canvases) {
      const wrap = c.closest<HTMLElement>("div[style*='background']");
      if (wrap) return wrap.style.background || wrap.style.backgroundColor;
    }
    return null;
  });
}

test("default visualizer follows the theme and re-colors on theme switch", async ({
  page,
}) => {
  const token = await registerAndAuth(page);
  await seedVisualizerTile(page, token, { visualizerStyle: "bars" });

  await page.goto("/");
  await page.waitForSelector("canvas");

  const initialBg = await readVisualizerBackground(page);
  expect(initialBg, "visualizer wrapper background not found").toBeTruthy();
  // It must NOT be the old hardcoded default; friction (default theme) derives
  // a different dark surface.
  expect(initialBg).not.toContain("15, 15, 26"); // rgb of #0f0f1a

  // Switch themes through the real settings UI, then return to the dashboard.
  await page.goto("/settings");
  await page.getByRole("button", { name: /Upload theme/i }).waitFor();
  await page.getByRole("button", { name: /^Hearth$/i }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.getAttribute("data-theme")),
    )
    .toBe("hearth");
  await page.goto("/");
  await page.waitForSelector("canvas");
  const hearthBg = await readVisualizerBackground(page);
  expect(hearthBg).toBeTruthy();
  expect(hearthBg, "visualizer did not re-color for the new theme").not.toBe(
    initialBg,
  );

  // Live switch (no reload): flip data-theme directly and expect a repaint.
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "nebula"),
  );
  await expect
    .poll(() => readVisualizerBackground(page), { timeout: 5000 })
    .not.toBe(hearthBg);
});

test("explicit custom colors always win over the theme", async ({ page }) => {
  const token = await registerAndAuth(page);
  const CUSTOM_BG = "#123456";
  await seedVisualizerTile(page, token, {
    visualizerStyle: "bars",
    visualizerPrimary: "#ff0080",
    visualizerBackground: CUSTOM_BG,
  });

  await page.goto("/");
  await page.waitForSelector("canvas");
  const bg = await readVisualizerBackground(page);
  expect(bg).toContain("rgb(18, 52, 86)"); // #123456

  // Theme switch must not touch a custom-colored tile.
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "hearth"),
  );
  await page.waitForTimeout(300);
  expect(await readVisualizerBackground(page)).toContain("rgb(18, 52, 86)");
});
