import { test, expect, type Page } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for the per-page fixed scale lock (task #235).
//
// Each dashboard page can be locked to a fixed column count (a resolution-style
// preset) and an orientation so tiles never reflow when the window resizes.
// "Auto" keeps the responsive behavior; a fixed preset renders the grid at a
// locked intrinsic width and CSS-scales it to fit (landscape = fit-width).
//
// A jsdom unit test cannot observe CSS transforms / real layout, so this is an
// end-to-end check in a real browser. It guards:
//   1. The layout settings control is reachable from the page tab UI (edit mode)
//      and applying a fixed preset persists across reload.
//   2. On an AUTO page the grid width tracks the viewport (responsive); after
//      switching to a FIXED landscape preset, shrinking the viewport no longer
//      reflows the column count — the same grid is CSS-scaled instead, so the
//      tiles keep their relative layout (the far-right tile stays to the right).
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("a page can be locked to a fixed scale preset that survives reload and resize", async ({
  page,
}) => {
  const username = `layouttest_${rand()}`;
  const password = `Pw_${rand()}!`;

  // Auth is a Bearer JWT stored in localStorage["token"]. Register via the API,
  // then seed the same token so the browser app loads authenticated.
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  expect(token, "register returned no token").toBeTruthy();
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Seed a tile placed far to the right so we can tell a fixed (scaled) layout
  // from a responsive one after the viewport shrinks.
  const res = await page.request.post("/api/tiles", {
    data: { name: "Right Tile", gridX: 18, gridY: 0, gridW: 4, gridH: 4 },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".react-grid-item")).toHaveCount(1);

  // --- Enter edit mode so the page-layout control is visible ----------------
  await page.getByRole("button", { name: /^Edit$/ }).click();

  // The layout settings trigger defaults to the "Auto / responsive" label.
  const layoutTrigger = page.getByRole("button", {
    name: /Auto \/ responsive/i,
  });
  await expect(layoutTrigger).toBeVisible();

  // --- Switch to a fixed 1080p landscape preset -----------------------------
  await layoutTrigger.click();
  await page.getByRole("menuitemradio", { name: /^1080p$/ }).click();

  // The trigger label reflects the new preset (and orientation marker).
  await expect(page.getByRole("button", { name: /1080p/ })).toBeVisible();

  // --- It persists across a reload ------------------------------------------
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await expect(page.getByRole("button", { name: /1080p/ })).toBeVisible();

  // --- Leave edit mode: the grid is now scaled to fit, not reflowed ---------
  await page.getByRole("button", { name: /^Done$/ }).click();
  await page.locator(".react-grid-layout").waitFor();
  const wrapper = page.getByTestId("fixed-scale-wrapper");
  await expect(wrapper).toBeVisible();

  // Read the grid's INTRINSIC layout width (offsetWidth ignores CSS transforms)
  // and the wrapper's applied scale factor. The intrinsic width is locked to the
  // preset's column count; the scale is what fits it to the viewport.
  const probe = () =>
    page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".react-grid-layout");
      const wrap = document.querySelector<HTMLElement>(
        '[data-testid="fixed-scale-wrapper"]',
      );
      if (!grid || !wrap) throw new Error("grid/wrapper not found");
      const m = new DOMMatrixReadOnly(getComputedStyle(wrap).transform);
      return { gridIntrinsicWidth: grid.offsetWidth, scaleX: m.a };
    });

  const wide = await probe();
  // On a wide viewport the fixed grid is scaled UP to fill the width.
  expect(wide.scaleX).toBeGreaterThan(1);

  // Shrink the viewport. A responsive page would drop columns (reflow); a fixed
  // page keeps the SAME intrinsic width and simply scales DOWN to fit.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect
    .poll(async () => (await probe()).scaleX, { timeout: 10_000 })
    .toBeLessThan(wide.scaleX - 0.1);

  const narrow = await probe();
  // No reflow: the intrinsic (untransformed) grid width is identical on both
  // viewports — only the scale changed.
  expect(narrow.gridIntrinsicWidth).toBe(wide.gridIntrinsicWidth);

  // --- Portrait fits to width (never clips horizontally) --------------------
  // Switch the page to portrait. Portrait, like landscape, scales to fit the
  // viewport WIDTH — tiles render at their intended size edge-to-edge and the
  // page scrolls vertically when content extends past the fold.
  await page.setViewportSize({ width: 900, height: 1400 });
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await page.getByRole("button", { name: /1080p/ }).click();
  await page.getByRole("menuitemradio", { name: /Vertical/ }).click();
  await page.getByRole("button", { name: /^Done$/ }).click();
  await expect(page.getByTestId("fixed-scale-wrapper")).toBeVisible();
  await page.waitForTimeout(500);

  const portrait = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".react-grid-layout");
    const wrap = document.querySelector<HTMLElement>(
      '[data-testid="fixed-scale-wrapper"]',
    );
    if (!grid || !wrap) throw new Error("grid/wrapper not found");
    const scaleX = new DOMMatrixReadOnly(getComputedStyle(wrap).transform).a;
    // The visible (scaled) width of the grid must fit within the wrapper's
    // clipping container — otherwise the sides are clipped.
    const containerWidth = (wrap.parentElement as HTMLElement).clientWidth;
    return {
      visibleWidth: grid.offsetWidth * scaleX,
      containerWidth,
      gridIntrinsicWidth: grid.offsetWidth,
    };
  });
  // Fit-to-width: the scaled grid fills the container width (within 1px of
  // sub-pixel rounding slack) — no oversized side padding, no horizontal clip.
  expect(portrait.visibleWidth).toBeLessThanOrEqual(portrait.containerWidth + 1);
  expect(portrait.visibleWidth).toBeGreaterThanOrEqual(portrait.containerWidth - 1);
  // Vertical mode uses its own simplified column tiers shaped by the screen's
  // SHORT side, so the portrait grid's intrinsic width must be substantially
  // narrower than the landscape one (a tall narrow grid, not a squeezed-down
  // wide layout). Standard vertical is 14 cols vs 24 for 1080p landscape.
  expect(portrait.gridIntrinsicWidth).toBeLessThan(wide.gridIntrinsicWidth * 0.75);

  // The layout trigger shows the simplified vertical tier label.
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await expect(
    page.getByRole("button", { name: /Standard.*Vertical/ }),
  ).toBeVisible();
  // The vertical page-scale menu offers only the simplified tiers.
  await page.getByRole("button", { name: /Standard.*Vertical/ }).click();
  await expect(page.getByRole("menuitemradio", { name: /^Standard$/ })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /^4K$/ })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /^2K$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Done$/ }).click();

  // --- A dense preset wider than the viewport must NOT collapse --------------
  // Switch to the 4K (densest) preset on a narrow viewport so the fixed canvas
  // is much wider than the screen (scale < 1). Regression guard: a flexbox
  // align-items:stretch feedback loop used to shrink the measured height
  // geometrically to ~0, hiding every tile. The reserved height must stay
  // positive and stable across measurement cycles. (Selecting a radio item
  // closes the menu, so this only re-opens the trigger once for the preset.)
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await page.getByRole("button", { name: /Vertical|2K|4K|1080p|Compact/ }).click();
  await page.getByRole("menuitemradio", { name: /^4K$/ }).click();
  await page.getByRole("button", { name: /^Done$/ }).click();
  await expect(page.getByTestId("fixed-scale-wrapper")).toBeVisible();

  const reservedHeight = () =>
    page.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>(
        '[data-testid="fixed-scale-wrapper"]',
      );
      const outer = wrap?.parentElement as HTMLElement | undefined;
      if (!wrap || !outer) throw new Error("wrapper not found");
      return outer.getBoundingClientRect().height;
    });

  // Let any ResizeObserver cycles settle, then confirm the height didn't
  // collapse toward zero and is stable on a re-measure.
  await page.waitForTimeout(800);
  const h1 = await reservedHeight();
  await page.waitForTimeout(400);
  const h2 = await reservedHeight();
  expect(h1).toBeGreaterThan(20);
  expect(Math.abs(h2 - h1)).toBeLessThan(2);
});

// ---------------------------------------------------------------------------
// Regression coverage for: the bottom of a fixed-scale page is clipped on a
// COLD refresh (task #258, broadened in #259).
//
// A locked fixed page reserves its outer container height as
// intrinsicHeight * scale with overflow-hidden. The intrinsic height is read by
// a ResizeObserver attached to the scaled wrapper in a layout effect. On a hard
// refresh the tiles are still fetching, so the render shows a "Loading tiles…"
// placeholder and the scaled wrapper does not exist yet — the effect finds a
// null ref and bails. If it never re-runs when the grid finally mounts, the
// reserved height stays stale and overflow-hidden clips the bottom rows. A
// settings round-trip remounts the dashboard and masks the bug, so these tests
// load the fixed page cold (tiles fetched fresh, no Settings toggle) and assert
// the reserved outer height matches the scaled grid height.
//
// The same measurement-timing path runs for every preset and orientation, so a
// regression could reappear in a combination the original single-scenario test
// (2K landscape) never exercised. Each scenario below drives the flow through a
// different preset/orientation/viewport, including a portrait fixed page and a
// scale<1 case (a dense preset on a small viewport), reusing the same
// transform-independent probe (grid.offsetHeight * scale vs. reserved outer
// height; data-testid="fixed-scale-wrapper").
// ---------------------------------------------------------------------------
type ColdRefreshScenario = {
  name: string;
  preset: RegExp;
  // Undefined = leave the default (landscape) orientation.
  orientation?: RegExp;
  viewport: { width: number; height: number };
};

const coldRefreshScenarios: ColdRefreshScenario[] = [
  // Original coverage: a landscape preset scaled UP to a wide viewport.
  {
    name: "2K landscape",
    preset: /^2K$/,
    viewport: { width: 1920, height: 1080 },
  },
  // Portrait fixed preset: fits to width like landscape, and the
  // measurement-timing path runs through the portrait branch.
  {
    name: "1080p portrait",
    preset: /^1080p$/,
    orientation: /Vertical/,
    viewport: { width: 900, height: 1400 },
  },
  // Dense preset on a small viewport → the fixed canvas is much wider than the
  // screen, so scale < 1. This is where the align-items:stretch feedback loop
  // and any stale-measurement clip are most likely to resurface.
  {
    name: "4K dense (scale < 1)",
    preset: /^4K$/,
    viewport: { width: 1100, height: 800 },
  },
];

for (const scenario of coldRefreshScenarios) {
  test(`a fixed-scale ${scenario.name} page shows its full height on a cold refresh (no bottom clip)`, async ({
    page,
  }) => {
    const username = `layoutclip_${rand()}`;
    const password = `Pw_${rand()}!`;

    const reg = await page.request.post("/api/auth/register", {
      data: { username, password },
    });
    expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
    const { token } = (await reg.json()) as { token: string };
    expect(token, "register returned no token").toBeTruthy();
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Seed several tiles stacked across many rows so the intrinsic grid height
    // is large — a stale/unset reserved height would clip the lower rows.
    for (let row = 0; row < 5; row++) {
      const res = await page.request.post("/api/tiles", {
        data: { name: `Row ${row}`, gridX: 0, gridY: row * 4, gridW: 4, gridH: 4 },
        headers: authHeaders,
      });
      expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
    }

    await page.addInitScript((t) => {
      window.localStorage.setItem("token", t as string);
    }, token);

    // Lock the page to the scenario's fixed preset (and orientation) once, via
    // edit mode. Selecting a radio item closes the menu, so re-open the trigger
    // for each selection.
    await page.setViewportSize(scenario.viewport);
    await page.goto("/");
    await page.locator(".react-grid-layout").waitFor();
    await page.getByRole("button", { name: /^Edit$/ }).click();
    await page.getByRole("button", { name: /Auto \/ responsive/i }).click();
    await page.getByRole("menuitemradio", { name: scenario.preset }).click();
    if (scenario.orientation) {
      await page
        .getByRole("button", { name: /Vertical|Horizontal|2K|4K|1080p|Compact/ })
        .click();
      await page.getByRole("menuitemradio", { name: scenario.orientation }).click();
    }
    await page.getByRole("button", { name: /^Done$/ }).click();
    await expect(page.getByTestId("fixed-scale-wrapper")).toBeVisible();

    // Probe: the outer clipping container's height must match the scaled grid
    // height (grid.offsetHeight * scaleY). offsetHeight ignores CSS transforms,
    // so this is the transform-independent true layout height. A bottom clip
    // shows up as the reserved outer height being smaller than the scaled grid.
    const clipProbe = () =>
      page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(".react-grid-layout");
        const wrap = document.querySelector<HTMLElement>(
          '[data-testid="fixed-scale-wrapper"]',
        );
        const outer = wrap?.parentElement as HTMLElement | undefined;
        if (!grid || !wrap || !outer) throw new Error("grid/wrapper not found");
        const scaleY = new DOMMatrixReadOnly(getComputedStyle(wrap).transform).d;
        return {
          scaledGridHeight: grid.offsetHeight * scaleY,
          reservedHeight: outer.getBoundingClientRect().height,
        };
      });

    // --- COLD refresh: reload the fixed page with tiles fetched fresh --------
    // This is the exact scenario the bug fires in — no Settings round-trip to
    // remount the dashboard and hide the stale measurement.
    for (let i = 0; i < 3; i++) {
      await page.goto("/");
      await page.locator(".react-grid-layout").waitFor();
      await expect(page.getByTestId("fixed-scale-wrapper")).toBeVisible();
      // Let the loading→loaded ResizeObserver measurement settle.
      await expect
        .poll(async () => (await clipProbe()).reservedHeight, { timeout: 10_000 })
        .toBeGreaterThan(20);

      const { scaledGridHeight, reservedHeight } = await clipProbe();
      // The reserved (clipping) height must be at least the scaled grid height —
      // anything less means the bottom rows are clipped and unreachable. Allow a
      // couple px of sub-pixel rounding slack.
      expect(
        reservedHeight,
        `${scenario.name} cold refresh #${i}: reserved height ${reservedHeight} clips scaled grid ${scaledGridHeight}`,
      ).toBeGreaterThanOrEqual(scaledGridHeight - 2);
    }
  });
}

// ---------------------------------------------------------------------------
// Portrait fixed pages fill the width and SCROLL vertically when content
// extends past one screen height (fold guides are advisory only, never a
// content ceiling). Previously portrait fit-to-height: tall content shrank the
// whole grid far below the viewport width, leaving tiny tiles with huge side
// padding. Guards:
//   1. A tall portrait page's scaled grid still fills the container width.
//   2. The reserved page height exceeds the viewport height (the page scrolls
//      instead of compressing), and the bottom-most tile is reachable by
//      scrolling — not clipped by the overflow wrapper.
//   3. A tile placed below the fold persists and renders after a reload.
// ---------------------------------------------------------------------------
test("a tall portrait fixed page fills the width and scrolls instead of shrinking", async ({
  page,
}) => {
  const username = `portraitscroll_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Seed a tall stack of tiles — far more rows than fit in one viewport
  // height — including one placed WELL below the fold.
  for (let row = 0; row < 8; row++) {
    const res = await page.request.post("/api/tiles", {
      data: { name: `Row ${row}`, gridX: 0, gridY: row * 4, gridW: 6, gridH: 4 },
      headers: authHeaders,
    });
    expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  }

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 900, height: 1400 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  // Lock to a 1080p portrait fixed preset.
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await page.getByRole("button", { name: /Auto \/ responsive/i }).click();
  await page.getByRole("menuitemradio", { name: /^1080p$/ }).click();
  await page
    .getByRole("button", { name: /Vertical|Horizontal|2K|4K|1080p|Compact/ })
    .click();
  await page.getByRole("menuitemradio", { name: /Vertical/ }).click();
  await page.getByRole("button", { name: /^Done$/ }).click();
  await expect(page.getByTestId("fixed-scale-wrapper")).toBeVisible();

  // Let the ResizeObserver measurement settle, then probe.
  const probe = () =>
    page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".react-grid-layout");
      const wrap = document.querySelector<HTMLElement>(
        '[data-testid="fixed-scale-wrapper"]',
      );
      const outer = wrap?.parentElement as HTMLElement | undefined;
      if (!grid || !wrap || !outer) throw new Error("grid/wrapper not found");
      const m = new DOMMatrixReadOnly(getComputedStyle(wrap).transform);
      return {
        visibleWidth: grid.offsetWidth * m.a,
        containerWidth: outer.clientWidth,
        scaledGridHeight: grid.offsetHeight * m.d,
        reservedHeight: outer.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
      };
    });
  await expect
    .poll(async () => (await probe()).reservedHeight, { timeout: 10_000 })
    .toBeGreaterThan(20);
  const p = await probe();

  // Fit-to-width: the scaled grid fills the container width (±1px slack).
  expect(p.visibleWidth).toBeGreaterThanOrEqual(p.containerWidth - 1);
  expect(p.visibleWidth).toBeLessThanOrEqual(p.containerWidth + 1);

  // The page reserves the full scaled content height — taller than the
  // viewport, so it scrolls — and nothing is clipped at the bottom.
  expect(p.reservedHeight).toBeGreaterThan(p.viewportHeight);
  expect(p.reservedHeight).toBeGreaterThanOrEqual(p.scaledGridHeight - 2);

  // The bottom-most tile (seeded below the fold) is present and reachable by
  // scrolling into view.
  const bottomTile = page.getByText("Row 7", { exact: false }).first();
  await bottomTile.scrollIntoViewIfNeeded();
  await expect(bottomTile).toBeVisible();

  // --- A tile placed below the fold persists across reload ------------------
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByTestId("fixed-scale-wrapper")).toBeVisible();
  const again = page.getByText("Row 7", { exact: false }).first();
  await again.scrollIntoViewIfNeeded();
  await expect(again).toBeVisible();
});
