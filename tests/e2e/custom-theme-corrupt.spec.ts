import { test, expect } from "./fixtures";
import { beforeReact } from "./before-react";

// ---------------------------------------------------------------------------
// Coverage for the corrupt-saved-theme safety net (task #242).
//
// `readCustomThemes()` re-validates every entry in
// localStorage["homehub:customThemes"] on load, and both the index.html
// before-paint script and `readSavedTheme` fall back to the default built-in
// when the saved theme id is unknown/invalid. This is the guard that stops a
// hand-edited or corrupt localStorage value from feeding malformed data to the
// runtime — but it is only unit-tested in isolation, never verified end-to-end
// in a real browser load.
//
// A regression here would let a single bad localStorage value crash the app on
// boot or render an unstyled (broken) page — neither of which a jsdom unit test
// can catch. This spec seeds a corrupt theme state directly into localStorage
// (via page.addInitScript, so it is present before the before-paint script
// runs) and confirms the dashboard still:
//   1. applies the default built-in theme synchronously before first paint
//      (the before-paint try/catch fallback), and
//   2. boots, hydrates, and renders the real dashboard (React's
//      readCustomThemes/readSavedTheme fallback) — landing on the default
//      built-in rather than crashing or flashing a broken page.
//
// Two flavours of corruption are exercised:
//   A. `homehub:customThemes` is unparseable garbage, with `homehub:theme`
//      pointing at a custom id that therefore cannot resolve.
//   B. `homehub:customThemes` is valid JSON but its lone entry fails
//      validateCustomTheme (missing colors/structural fields), with
//      `homehub:theme` dangling at that same id.
// ---------------------------------------------------------------------------

const DEFAULT_THEME = "friction";
const KNOWN_THEMES = [
  "friction",
  "hearth",
  "nebula",
  "rack",
  "workshop",
  "pebble",
];

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Reads the resolved theme state straight off documentElement so we observe the
// real applied result, not React internals. `background` reads the *computed*
// value because a built-in theme's --background lives in the stylesheet (the
// [data-theme="..."] rule), not in an inline override. It is therefore only
// meaningful once the CSS has loaded (i.e. after hydration), not at the
// pre-React assertions with the entry module blocked in Vite dev.
function readThemeState() {
  const root = document.documentElement;
  return {
    dataTheme: root.getAttribute("data-theme"),
    shadow: root.getAttribute("data-shadow"),
    pattern: root.getAttribute("data-pattern"),
    background: getComputedStyle(root).getPropertyValue("--background").trim(),
  };
}

async function registerAndAuth(page: import("@playwright/test").Page) {
  const username = `corrupttest_${rand()}`;
  const password = `Pw_${rand()}!`;
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  expect(token, "register returned no token").toBeTruthy();

  // A brand-new user shows a "No tiles yet" empty state instead of the grid.
  // Seed one tile so the dashboard renders the real react-grid-layout — that
  // mounting is our proof the app booted past ThemeProvider on the corrupt
  // theme state without crashing.
  const tile = await page.request.post("/api/tiles", {
    data: { name: "Smoke Tile", gridX: 0, gridY: 0, gridW: 4, gridH: 4 },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(tile.ok(), `tile create failed: ${tile.status()}`).toBeTruthy();

  return token;
}

test("a corrupt (unparseable) saved theme falls back to the default and the dashboard still renders", async ({
  page,
}) => {
  const token = await registerAndAuth(page);

  // Seed auth + a deliberately broken theme state BEFORE any app script runs.
  // page.addInitScript executes on every navigation prior to the page's own
  // scripts, so the index.html before-paint <script> sees exactly this state.
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
    // Unparseable JSON: JSON.parse will throw and the before-paint catch +
    // readCustomThemes catch must both swallow it and yield an empty map.
    window.localStorage.setItem(
      "homehub:customThemes",
      "}{ not valid json at all",
    );
    // Dangling pointer at a custom id that can never resolve (the map is empty).
    window.localStorage.setItem("homehub:theme", "custom:ghost-deadbeef");
  }, token);

  // --- Before first paint: the inline script must have fallen back ----------
  // Hold main.tsx so only the inline script can supply the fallback.
  await beforeReact(page, "/", async () => {
    const beforePaint = await page.evaluate(readThemeState);
    expect(
      beforePaint.dataTheme,
      "before-paint script did not fall back to a known built-in theme",
    ).toBe(DEFAULT_THEME);
    expect(KNOWN_THEMES).toContain(beforePaint.dataTheme);
    // The custom-only structural attributes must not be set for a built-in theme.
    expect(beforePaint.shadow).toBeNull();
    expect(beforePaint.pattern).toBeNull();
  });

  // --- After hydration: React must render the real dashboard ---------------
  // The grid mounting proves the app booted past ThemeProvider's
  // readCustomThemes()/readSavedTheme() without throwing on the corrupt value.
  await page.locator(".react-grid-layout").waitFor();

  const afterHydration = await page.evaluate(readThemeState);
  expect(
    afterHydration.dataTheme,
    "React layer did not settle on the default built-in theme",
  ).toBe(DEFAULT_THEME);
  expect(afterHydration.shadow).toBeNull();
  expect(afterHydration.pattern).toBeNull();
  expect(afterHydration.background.length).toBeGreaterThan(0);

  // The corrupt value should not have been re-persisted as-is in a way that
  // would resolve to a custom theme; the active pointer still reads as the
  // dangling id only until the user changes it, and nothing crashed.
  const noConsoleCrash = await page.evaluate(
    () => document.getElementById("root")?.childElementCount ?? 0,
  );
  expect(
    noConsoleCrash,
    "React root did not mount any children",
  ).toBeGreaterThan(0);
});

test("a structurally invalid saved custom theme falls back to the default and the dashboard still renders", async ({
  page,
}) => {
  const token = await registerAndAuth(page);

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
    // Valid JSON, but the entry is missing the required colors + structural
    // fields, so validateCustomTheme rejects it and readCustomThemes drops it.
    window.localStorage.setItem(
      "homehub:customThemes",
      JSON.stringify({
        "custom:broken": {
          format: "homehub-theme",
          version: 1,
          name: "Broken",
        },
      }),
    );
    // The active theme dangles at that now-dropped id.
    window.localStorage.setItem("homehub:theme", "custom:broken");
  }, token);

  await beforeReact(page, "/", async () => {
    // The before-paint script only applies a custom def when it carries colors;
    // this one does not, so it must fall through to the default built-in.
    const beforePaint = await page.evaluate(readThemeState);
    expect(
      beforePaint.dataTheme,
      "before-paint script did not fall back for a colorless custom entry",
    ).toBe(DEFAULT_THEME);
    expect(beforePaint.shadow).toBeNull();
    expect(beforePaint.pattern).toBeNull();
  });

  // React boots and renders, settling on the default built-in.
  await page.locator(".react-grid-layout").waitFor();
  const afterHydration = await page.evaluate(readThemeState);
  expect(afterHydration.dataTheme).toBe(DEFAULT_THEME);
  expect(afterHydration.shadow).toBeNull();
  expect(afterHydration.pattern).toBeNull();
  expect(afterHydration.background.length).toBeGreaterThan(0);

  const rootChildren = await page.evaluate(
    () => document.getElementById("root")?.childElementCount ?? 0,
  );
  expect(rootChildren, "React root did not mount any children").toBeGreaterThan(
    0,
  );
});
