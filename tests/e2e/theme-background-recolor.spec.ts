import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Background-recolor regression coverage for ALL six built-in themes (task
// #499). Slate ("nebula"), Workshop and Pebble derive their page field, cards,
// neumorphic shadows and (Workshop) the brushed-metal gradient from theme
// tokens: THEME_SURFACES in index.html sets per-theme surface deltas + helper
// vars (--neu-shadow-*, --metal-*, --panel-shadow), and index.css paints
// .bg-dot-pattern / .bg-card from those vars instead of hardcoded HSL.
//
// A future hardcoded HSL in index.css, or a helper var missing from
// OVERRIDE_VARS in index.html, would silently freeze a theme's background:
// the user picks a custom background color, --background updates, but the
// visible page field keeps the stock color (or the helper vars leak across a
// reset). This spec drives the real Settings color picker on every theme and
// asserts the *computed* .bg-dot-pattern paint actually changes — and resets
// to the stock paint exactly, with all helper vars cleared.
// ---------------------------------------------------------------------------

// One distinctive pick that differs from every theme's stock background.
const OVERRIDE_BACKGROUND = "#336699";

// Mirror of the hex→HSL + triplet derivation in index.html (see
// builtin-theme.spec.ts for rationale: compute expectations, don't hardcode).
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
const bg = hexToHsl(OVERRIDE_BACKGROUND);
const EXPECTED_BACKGROUND = `${Math.round(bg.h)} ${clamp(bg.s, 0, 100)}% ${clamp(bg.l, 0, 100)}%`;

// The six built-in themes as they appear in the Settings picker, plus which
// tokenized helper vars each theme's surfaces depend on (must be SET while a
// custom background is active and CLEARED on reset).
const NEU_VARS = ["--neu-shadow-dark", "--neu-shadow-light"];
const METAL_VARS = [
  "--metal-streak-1",
  "--metal-streak-2",
  "--metal-streak-3",
  "--metal-top",
  "--metal-bottom",
  "--metal-card-mid",
  "--metal-card-base",
  "--metal-bevel",
  "--panel-shadow",
];
// Every helper var that must be gone after a reset, on every theme.
const ALL_HELPER_VARS = [...NEU_VARS, ...METAL_VARS];

const THEMES: Array<{ id: string; button: RegExp; helperVars: string[] }> = [
  { id: "friction", button: /^Friction$/i, helperVars: [] },
  { id: "rack", button: /^Rack$/i, helperVars: [] },
  { id: "nebula", button: /^Slate$/i, helperVars: NEU_VARS },
  { id: "hearth", button: /^Hearth$/i, helperVars: [] },
  { id: "workshop", button: /^Workshop$/i, helperVars: METAL_VARS },
  { id: "pebble", button: /^Pebble$/i, helperVars: NEU_VARS },
];

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Reads the state this spec asserts on: the *computed* paint of the page's
// .bg-dot-pattern field (backgroundColor + backgroundImage — Workshop/Friction
// paint via background-image gradients, Slate/Pebble via background-color, and
// every settings page also carries bg-background so the flat color always
// participates), plus the inline helper/background vars on documentElement.
function readRecolorState(vars: string[]) {
  const root = document.documentElement;
  const field = document.querySelector(".bg-dot-pattern");
  const cs = field ? getComputedStyle(field) : null;
  const inlineVars: Record<string, string> = {};
  for (const v of vars) inlineVars[v] = root.style.getPropertyValue(v).trim();
  return {
    dataTheme: root.getAttribute("data-theme"),
    inlineBackground: root.style.getPropertyValue("--background").trim(),
    fieldPaint: cs ? `${cs.backgroundColor} | ${cs.backgroundImage}` : null,
    inlineVars,
  };
}

async function registerAndAuth(page: import("@playwright/test").Page) {
  const username = `bgrecolor_${rand()}`;
  const password = `Pw_${rand()}!`;
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  expect(token, "register returned no token").toBeTruthy();
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);
}

// Commits a hex through the real popover input → commitDraft → onChange path.
async function setBackgroundColor(
  page: import("@playwright/test").Page,
  hex: string,
) {
  await page.getByRole("button", { name: "Pick background color" }).click();
  const input = page.getByPlaceholder("#000000");
  await input.fill(hex);
  await page.keyboard.press("Escape");
}

test("picking a custom background recolors the page field on every built-in theme and resets to stock exactly", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await registerAndAuth(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: /Upload theme/i }).waitFor();

  for (const themeCase of THEMES) {
    await test.step(`theme ${themeCase.id}`, async () => {
      // Select the theme through the real picker.
      await page.getByRole("button", { name: themeCase.button }).click();
      await expect
        .poll(
          async () =>
            (await page.evaluate(readRecolorState, ALL_HELPER_VARS)).dataTheme,
        )
        .toBe(themeCase.id);

      // Snapshot the STOCK paint of the page field (no overrides active —
      // previous iterations always reset before moving on, asserted below).
      const stock = await page.evaluate(readRecolorState, ALL_HELPER_VARS);
      expect(stock.inlineBackground, "stock state has a leaked override").toBe(
        "",
      );
      expect(stock.fieldPaint, ".bg-dot-pattern element missing").toBeTruthy();

      // Pick a custom background through the real color control.
      await setBackgroundColor(page, OVERRIDE_BACKGROUND);
      await expect
        .poll(
          async () =>
            (await page.evaluate(readRecolorState, ALL_HELPER_VARS))
              .inlineBackground,
        )
        .toBe(EXPECTED_BACKGROUND);

      const overridden = await page.evaluate(readRecolorState, ALL_HELPER_VARS);
      // The regression this guards against: --background updates but the
      // visible field keeps its stock paint (hardcoded HSL in index.css).
      expect(
        overridden.fieldPaint,
        `custom background did not change the computed .bg-dot-pattern paint on ${themeCase.id}`,
      ).not.toBe(stock.fieldPaint);

      // Token-derived themes must re-derive their helper vars from the pick;
      // otherwise shadows/metal would keep the stock tint.
      for (const v of themeCase.helperVars) {
        expect(
          overridden.inlineVars[v],
          `${v} not derived from the custom background on ${themeCase.id}`,
        ).not.toBe("");
      }

      // Reset to theme defaults through the real button.
      await page
        .getByRole("button", { name: /Reset to theme defaults/i })
        .click();
      await expect
        .poll(
          async () =>
            (await page.evaluate(readRecolorState, ALL_HELPER_VARS))
              .inlineBackground,
        )
        .toBe("");

      const reset = await page.evaluate(readRecolorState, ALL_HELPER_VARS);
      // Stock paint must come back EXACTLY — anything else means an override
      // (or a helper var missing from OVERRIDE_VARS) survived the reset.
      expect(
        reset.fieldPaint,
        `.bg-dot-pattern paint did not reset to stock exactly on ${themeCase.id}`,
      ).toBe(stock.fieldPaint);
      for (const v of ALL_HELPER_VARS) {
        expect(
          reset.inlineVars[v],
          `${v} not cleared on reset on ${themeCase.id} (missing from OVERRIDE_VARS?)`,
        ).toBe("");
      }
    });
  }
});
