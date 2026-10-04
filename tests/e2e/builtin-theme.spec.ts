import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Coverage for the built-in theme + per-theme color-override application path
// (task #241).
//
// Task #239 added e2e coverage that *custom* (user-uploaded) themes apply
// before first paint. The very same index.html before-paint <script> also
// drives the 6 built-in themes (friction/rack/nebula/hearth/workshop/pebble)
// AND the per-theme custom color overrides stored in localStorage
// ("homehub:colors"). Those two branches have the identical flash-of-wrong-
// theme risk on reload but no e2e coverage:
//   - a plain built-in theme is applied before paint purely by setting the
//     data-theme attribute (its colors live in the [data-theme="..."] CSS), and
//   - a per-theme color override is applied before paint as inline CSS
//     variables derived from the saved hex colors (CSS-independent), and the
//     same script must CLEAR those inline vars when switching themes so one
//     theme's override never leaks onto another.
// A regression in either branch would flash the default theme (or the previous
// theme's colors) on reload — which a jsdom unit test cannot catch.
// ---------------------------------------------------------------------------

const DEFAULT_THEME = "friction";

// Deliberately distinctive override colors that match neither the default
// (friction) nor the theme we apply them to (nebula), so every assertion is
// unambiguous.
const OVERRIDE_PRIMARY = "#ff0080";
const OVERRIDE_BACKGROUND = "#101820";

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Port of the hex→HSL derivation in index.html so the test computes the
// expected CSS-variable triplets from the source colors rather than hardcoding
// (and silently drifting from) them.
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let m = hex.trim().replace(/^#/, "");
  if (m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

function triplet(h: number, s: number, l: number): string {
  return `${Math.round(h)} ${clamp(Math.round(s), 0, 100)}% ${clamp(
    Math.round(l),
    0,
    100,
  )}%`;
}

const prHsl = hexToHsl(OVERRIDE_PRIMARY);
const EXPECTED_PRIMARY = triplet(prHsl.h, prHsl.s, prHsl.l);
const bgHsl = hexToHsl(OVERRIDE_BACKGROUND);
const EXPECTED_BACKGROUND = triplet(bgHsl.h, bgHsl.s, bgHsl.l);

// Reads the resolved theme state straight off documentElement so we observe the
// real applied result, not React internals. `--primary`/`--background` are read
// from the *inline* style (root.style): a per-theme color override is applied
// as inline CSS variables by the before-paint script, so they are present even
// at DOMContentLoaded (before the stylesheet has loaded in Vite dev). A plain
// built-in theme sets none of these inline, so they read as "".
function readThemeState() {
  const root = document.documentElement;
  return {
    dataTheme: root.getAttribute("data-theme"),
    shadow: root.getAttribute("data-shadow"),
    pattern: root.getAttribute("data-pattern"),
    inlinePrimary: root.style.getPropertyValue("--primary").trim(),
    inlineBackground: root.style.getPropertyValue("--background").trim(),
    computedBackground: getComputedStyle(root)
      .getPropertyValue("--background")
      .trim(),
  };
}

async function registerAndAuth(page: import("@playwright/test").Page) {
  const username = `builtintheme_${rand()}`;
  const password = `Pw_${rand()}!`;
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  expect(token, "register returned no token").toBeTruthy();

  // Seed the same token so the browser app loads authenticated.
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  return token;
}

// Opens the color popover for a built-in color control and commits a hex value
// through the real input → commitDraft → onChange path, exactly as a user would.
async function setOverrideColor(
  page: import("@playwright/test").Page,
  which: "primary" | "background",
  hex: string,
) {
  await page.getByRole("button", { name: `Pick ${which} color` }).click();
  // Radix keeps the previous popover in the DOM during its exit animation, so
  // a page-global placeholder locator can transiently match two inputs (strict
  // mode failure). Scope to the newest popper wrapper, which is the popover we
  // just opened.
  const input = page
    .locator("[data-radix-popper-content-wrapper]")
    .last()
    .getByPlaceholder("#000000");
  await input.waitFor({ state: "visible" });
  await input.fill(hex);
  await page.keyboard.press("Escape");
}

test("a non-default built-in theme applies and survives reload without a flash", async ({
  page,
}) => {
  await registerAndAuth(page);

  // Land on Settings (default theme) and capture the default theme's resolved
  // --background after hydration so we can later prove the selected theme's
  // derived tokens really changed (not just the data-theme attribute).
  await page.goto("/settings");
  await page.getByRole("button", { name: /Upload theme/i }).waitFor();
  const baseline = await page.evaluate(readThemeState);
  expect(baseline.dataTheme).toBe(DEFAULT_THEME);
  expect(baseline.computedBackground.length).toBeGreaterThan(0);

  // Select a distinctly different built-in theme through the real picker.
  await page.getByRole("button", { name: "Slate", exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(readThemeState)).dataTheme)
    .toBe("nebula");

  // It must be persisted so the before-paint script can re-apply it on reload.
  const savedTheme = await page.evaluate(() =>
    window.localStorage.getItem("homehub:theme"),
  );
  expect(savedTheme).toBe("nebula");

  // --- Reload: the before-paint script must apply it with no flash -----------
  // main.tsx is a deferred module script, so it has NOT executed at
  // DOMContentLoaded — only the inline before-paint script has. The data-theme
  // attribute is the mechanism that prevents a flash of the default for a
  // built-in theme (its colors live in the stylesheet), so reading it here
  // proves the saved theme was applied synchronously before first paint.
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  const beforePaint = await page.evaluate(readThemeState);
  expect(
    beforePaint.dataTheme,
    "built-in theme not applied before first paint",
  ).toBe("nebula");
  expect(beforePaint.dataTheme).not.toBe(DEFAULT_THEME);
  // A built-in (no override) must not carry custom-only structural attributes.
  expect(beforePaint.shadow).toBeNull();
  expect(beforePaint.pattern).toBeNull();
  expect(beforePaint.inlinePrimary).toBe("");

  // --- After hydration: the derived tokens differ from the default ----------
  await page.getByRole("button", { name: /Upload theme/i }).waitFor();
  const afterHydration = await page.evaluate(readThemeState);
  expect(afterHydration.dataTheme).toBe("nebula");
  expect(afterHydration.computedBackground.length).toBeGreaterThan(0);
  expect(
    afterHydration.computedBackground,
    "selected theme's derived --background did not differ from the default",
  ).not.toBe(baseline.computedBackground);
});

test("a per-theme color override applies before paint, survives reload, and does not leak across themes", async ({
  page,
}) => {
  await registerAndAuth(page);

  await page.goto("/settings");
  await page.getByRole("button", { name: /Upload theme/i }).waitFor();

  // Pick a built-in theme and give it a distinctive per-theme color override.
  await page.getByRole("button", { name: "Slate", exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(readThemeState)).dataTheme)
    .toBe("nebula");

  await setOverrideColor(page, "primary", OVERRIDE_PRIMARY);
  await setOverrideColor(page, "background", OVERRIDE_BACKGROUND);

  // The override is applied live as inline CSS variables derived from the hex.
  await expect
    .poll(async () => (await page.evaluate(readThemeState)).inlinePrimary)
    .toBe(EXPECTED_PRIMARY);
  const applied = await page.evaluate(readThemeState);
  expect(applied.inlineBackground).toBe(EXPECTED_BACKGROUND);

  // It must be persisted under the active theme id so the before-paint script
  // can re-apply it on reload.
  const savedColors = await page.evaluate(() =>
    window.localStorage.getItem("homehub:colors"),
  );
  expect(savedColors).toBeTruthy();
  expect(JSON.parse(savedColors as string).nebula).toMatchObject({
    primary: OVERRIDE_PRIMARY,
    background: OVERRIDE_BACKGROUND,
  });

  // --- Reload: the override must be re-derived inline before first paint -----
  // These inline CSS variables are set by the before-paint script directly, so
  // they are observable at DOMContentLoaded regardless of stylesheet loading —
  // proving the derived tokens are applied before paint with no flash.
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  const beforePaint = await page.evaluate(readThemeState);
  expect(beforePaint.dataTheme).toBe("nebula");
  expect(
    beforePaint.inlinePrimary,
    "per-theme primary override not re-applied before first paint",
  ).toBe(EXPECTED_PRIMARY);
  expect(beforePaint.inlineBackground).toBe(EXPECTED_BACKGROUND);

  // --- Switch to a theme with NO override: the previous override must clear ---
  await page.getByRole("button", { name: /Upload theme/i }).waitFor();
  await page.getByRole("button", { name: /^Rack$/i }).click();
  await expect
    .poll(async () => (await page.evaluate(readThemeState)).dataTheme)
    .toBe("rack");
  const afterSwitch = await page.evaluate(readThemeState);
  expect(
    afterSwitch.inlinePrimary,
    "previous theme's primary override leaked onto the new theme",
  ).toBe("");
  expect(afterSwitch.inlineBackground).toBe("");

  // Reloading on the un-overridden theme must also be leak-free before paint.
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  const rackBeforePaint = await page.evaluate(readThemeState);
  expect(rackBeforePaint.dataTheme).toBe("rack");
  expect(
    rackBeforePaint.inlinePrimary,
    "override leaked onto a non-overridden theme after reload",
  ).toBe("");
  expect(rackBeforePaint.inlineBackground).toBe("");

  // --- Switch back: the original theme's override is still scoped to it ------
  await page.getByRole("button", { name: /Upload theme/i }).waitFor();
  await page.getByRole("button", { name: "Slate", exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(readThemeState)).inlinePrimary)
    .toBe(EXPECTED_PRIMARY);
  const backToNebula = await page.evaluate(readThemeState);
  expect(backToNebula.dataTheme).toBe("nebula");
  expect(backToNebula.inlineBackground).toBe(EXPECTED_BACKGROUND);
});
