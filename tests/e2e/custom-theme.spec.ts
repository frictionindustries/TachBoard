import { test, expect } from "./fixtures";
import { beforeReact } from "./before-react";

// ---------------------------------------------------------------------------
// Coverage for the custom (user-uploaded) theme visual application path
// (task #239).
//
// The format/validation/persistence of custom themes is unit-tested, but the
// actual application path has no automated coverage:
//   - the index.html before-paint <script> reads localStorage and applies the
//     custom theme synchronously (data-theme="custom" + inline CSS vars + the
//     data-shadow/-pattern/-uppercase/-heading attributes that drive the
//     [data-theme="custom"] CSS in index.css), and
//   - ThemeProvider keeps that DOM in sync for live changes.
// A regression there would flash the wrong theme on reload or render a broken
// dashboard — neither of which a jsdom unit test can catch.
//
// This e2e test:
//   1. Logs in, uploads a valid custom theme through the real Appearance UI,
//      and verifies the document picks up the expected colors, radius and
//      structural style.
//   2. Reloads and confirms the custom theme is already applied at
//      a blocked React entry module — only the before-paint script applied it,
//      so there is no flash of the default theme.
//   3. Deletes the active custom theme and verifies the app falls back to the
//      default built-in (friction).
// ---------------------------------------------------------------------------

const DEFAULT_THEME = "friction";

// A deliberately distinctive theme so every assertion is unambiguous and could
// not accidentally match a built-in.
const CUSTOM_THEME = {
  format: "homehub-theme",
  version: 1,
  name: "E2E Neon",
  dark: true,
  colors: { primary: "#ff0080", background: "#101820" },
  radius: "0.75rem",
  font: "'Inter', sans-serif",
  shadow: "glow",
  backgroundPattern: "dots",
  uppercase: false,
  headingFont: "serif",
} as const;

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Port of the hex→HSL derivation in index.html / customThemes so the test
// computes the expected CSS-variable triplets from the source colors rather
// than hardcoding (and silently drifting from) them.
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

// Reads the resolved theme state straight off documentElement so we observe the
// real applied result, not React internals.
function readThemeState(args: string[]) {
  const root = document.documentElement;
  const style = root.style;
  const out: Record<string, string | null> = {
    dataTheme: root.getAttribute("data-theme"),
    shadow: root.getAttribute("data-shadow"),
    pattern: root.getAttribute("data-pattern"),
    uppercase: root.getAttribute("data-uppercase"),
    heading: root.getAttribute("data-heading"),
  };
  for (const v of args) out[v] = style.getPropertyValue(v).trim();
  return out;
}

const READ_VARS = ["--radius", "--primary", "--background", "--app-font-sans"];

test("a custom theme applies, survives reload without a flash, and falls back on delete", async ({
  page,
}) => {
  const username = `themetest_${rand()}`;
  const password = `Pw_${rand()}!`;

  // Auth is a Bearer JWT stored in localStorage["token"]. Register via the API,
  // then seed the same token so the browser app loads authenticated.
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  expect(token, "register returned no token").toBeTruthy();

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  // Expected derived CSS variable values for the custom theme.
  const primaryHsl = hexToHsl(CUSTOM_THEME.colors.primary);
  const expectedPrimary = triplet(primaryHsl.h, primaryHsl.s, primaryHsl.l);
  const bgHsl = hexToHsl(CUSTOM_THEME.colors.background);
  const expectedBackground = triplet(bgHsl.h, bgHsl.s, bgHsl.l);

  // --- Upload the custom theme through the real Appearance UI ----------------
  await page.goto("/settings");
  const uploadBtn = page.getByRole("button", { name: /Upload theme/i });
  await expect(uploadBtn).toBeVisible();

  // Use the theme button's file chooser, not a page-global file input selector:
  // Settings also has a separate profile-import input.
  const fileChooserPromise = page.waitForEvent("filechooser");
  await uploadBtn.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "e2e-neon-theme.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(CUSTOM_THEME)),
  });

  // The custom theme is now active. Verify the document reflects it.
  await expect
    .poll(
      async () => (await page.evaluate(readThemeState, READ_VARS)).dataTheme,
    )
    .toBe("custom");

  const applied = await page.evaluate(readThemeState, READ_VARS);
  expect(applied.dataTheme).toBe("custom");
  expect(applied["--radius"]).toBe(CUSTOM_THEME.radius);
  expect(applied["--primary"]).toBe(expectedPrimary);
  expect(applied["--background"]).toBe(expectedBackground);
  expect(applied["--app-font-sans"]).toBe(CUSTOM_THEME.font);
  // Structural knobs become data-* attributes consumed by the CSS.
  expect(applied.shadow).toBe(CUSTOM_THEME.shadow);
  expect(applied.pattern).toBe(CUSTOM_THEME.backgroundPattern);
  expect(applied.uppercase).toBe("off"); // uppercase:false → data-uppercase="off"
  expect(applied.heading).toBe(CUSTOM_THEME.headingFont);

  // It should have been persisted to localStorage so the before-paint script
  // can re-apply it on the next load.
  const savedTheme = await page.evaluate(() =>
    window.localStorage.getItem("homehub:theme"),
  );
  expect(savedTheme).toMatch(/^custom:/);

  // --- Reload: the before-paint script must apply it with no flash -----------
  // Hold main.tsx so React cannot repair a missing inline application.
  await beforeReact(page, "/settings", async () => {
    const beforePaint = await page.evaluate(readThemeState, READ_VARS);
    expect(
      beforePaint.dataTheme,
      "custom theme not applied before first paint",
    ).toBe("custom");
    expect(beforePaint.dataTheme).not.toBe(DEFAULT_THEME);
    expect(beforePaint["--radius"]).toBe(CUSTOM_THEME.radius);
    expect(beforePaint["--primary"]).toBe(expectedPrimary);
    expect(beforePaint.shadow).toBe(CUSTOM_THEME.shadow);
    expect(beforePaint["--background"]).toBe(expectedBackground);
    expect(beforePaint["--app-font-sans"]).toBe(CUSTOM_THEME.font);
    expect(beforePaint.pattern).toBe(CUSTOM_THEME.backgroundPattern);
    expect(beforePaint.uppercase).toBe("off");
    expect(beforePaint.heading).toBe(CUSTOM_THEME.headingFont);
  });

  // After full hydration it is still the custom theme (didn't get reset).
  await page.getByRole("button", { name: /Upload theme/i }).waitFor();
  const afterHydration = await page.evaluate(readThemeState, READ_VARS);
  expect(afterHydration.dataTheme).toBe("custom");
  expect(afterHydration["--background"]).toBe(expectedBackground);

  // --- Delete the active custom theme: must fall back to the default ---------
  await page
    .getByRole("button", {
      name: new RegExp(`Delete ${CUSTOM_THEME.name}`, "i"),
    })
    .click();

  await expect
    .poll(
      async () => (await page.evaluate(readThemeState, READ_VARS)).dataTheme,
    )
    .toBe(DEFAULT_THEME);

  const afterDelete = await page.evaluate(readThemeState, READ_VARS);
  expect(afterDelete.dataTheme).toBe(DEFAULT_THEME);
  // The custom-only structural attributes must be cleared so nothing leaks.
  expect(afterDelete.shadow).toBeNull();
  expect(afterDelete.pattern).toBeNull();

  // The fallback is persisted, so a subsequent reload also lands on the default
  // built-in rather than a dangling custom: id.
  const savedAfterDelete = await page.evaluate(() =>
    window.localStorage.getItem("homehub:theme"),
  );
  expect(savedAfterDelete).toBe(DEFAULT_THEME);
});
