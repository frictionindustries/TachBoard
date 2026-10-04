import { test, expect, type Page } from "./fixtures";

// ---------------------------------------------------------------------------
// Regression coverage for the FULL-WIDTH dashboard grid + width-based column
// scaling.
//
// The grid was changed from a fixed, centered ~24-column strip (capped near
// ~1500px) to a full-width grid whose column COUNT scales with the browser
// width while each column keeps a fixed visual size. A jsdom unit test cannot
// observe this — it has no real layout — so this is an end-to-end check in a
// real browser that measures actual DOM widths.
//
// It guards three things:
//   1. On a wide viewport the grid root (`.react-grid-layout`) spans nearly the
//      whole window (window width minus the ~32px page padding), and is NOT
//      re-capped near ~1500px.
//   2. A narrower viewport yields fewer columns and a wider one more — observed
//      via the grid root shrinking with the window while an individual tile
//      keeps a roughly constant pixel width (columns scale, tiles don't
//      stretch).
//   3. A tile placed far to the right (high gridX) survives a page reload and
//      does not collapse back to the top-left.
// ---------------------------------------------------------------------------

const PAGE_PADDING = 32; // <main className="px-4 …"> => 16px each side
const MARGIN_OF_ERROR = 48; // allow for scrollbars / sub-pixel rounding

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function gridWidth(page: Page): Promise<number> {
  const box = await page.locator(".react-grid-layout").boundingBox();
  if (!box) throw new Error(".react-grid-layout not found / not visible");
  return box.width;
}

async function tileMetrics(page: Page): Promise<{ maxLeft: number; leftmostWidth: number }> {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>(".react-grid-item"));
    if (items.length === 0) throw new Error("no .react-grid-item rendered");
    const rects = items.map((el) => el.getBoundingClientRect());
    const maxLeft = Math.max(...rects.map((r) => r.left));
    const leftmost = rects.reduce((a, b) => (a.left <= b.left ? a : b));
    return { maxLeft, leftmostWidth: leftmost.width };
  });
}

test("dashboard grid is full-width and scales its column count with the viewport", async ({
  page,
}) => {
  const username = `gridtest_${rand()}`;
  const password = `Pw_${rand()}!`;

  // --- Register a throwaway user -------------------------------------------
  // Auth is a Bearer JWT (returned by /api/auth/register, stored by the app in
  // localStorage["token"]). Register via the API, then seed the same token so
  // the browser app is authenticated on load.
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  expect(token, "register returned no token").toBeTruthy();
  const authHeaders = { Authorization: `Bearer ${token}` };

  // --- Seed two tiles: one at the left, one far to the right ----------------
  // gridX=18 only fits when the grid is full-width with enough columns, so it
  // doubles as the "wide area" + "survives reload" probe.
  for (const data of [
    { name: "Left Tile", gridX: 0, gridY: 0, gridW: 4, gridH: 4 },
    { name: "Right Tile", gridX: 18, gridY: 0, gridW: 4, gridH: 4 },
  ]) {
    const res = await page.request.post("/api/tiles", { data, headers: authHeaders });
    expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  }

  // Authenticate the browser for every page load in this test.
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  // --- Wide viewport: grid spans (window - padding), not capped ~1500px -----
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".react-grid-item")).toHaveCount(2);

  const innerWide = await page.evaluate(() => window.innerWidth);
  const gridWide = await gridWidth(page);

  // Spans nearly the full window: not re-capped near ~1500px.
  expect(gridWide).toBeGreaterThan(1700);
  // And it tracks the window minus the page padding.
  expect(Math.abs(innerWide - PAGE_PADDING - gridWide)).toBeLessThanOrEqual(MARGIN_OF_ERROR);

  const wide = await tileMetrics(page);
  // The far-right tile really sits in the wide area (only possible with enough
  // columns), not collapsed toward x=0.
  expect(wide.maxLeft).toBeGreaterThan(1000);

  // --- Reload: the far-right tile keeps its position ------------------------
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".react-grid-item")).toHaveCount(2);
  const afterReload = await tileMetrics(page);
  expect(afterReload.maxLeft).toBeGreaterThan(1000);

  // --- Narrow viewport: fewer columns, same tile size ----------------------
  await page.setViewportSize({ width: 1280, height: 800 });
  // Wait for the ResizeObserver-driven re-measure to shrink the grid.
  await expect
    .poll(async () => Math.round(await gridWidth(page)), { timeout: 10_000 })
    .toBeLessThan(Math.round(gridWide) - 400);

  const innerNarrow = await page.evaluate(() => window.innerWidth);
  const gridNarrow = await gridWidth(page);
  expect(Math.abs(innerNarrow - PAGE_PADDING - gridNarrow)).toBeLessThanOrEqual(MARGIN_OF_ERROR);

  const narrow = await tileMetrics(page);
  // Each column keeps a fixed visual size: an individual tile is ~the same
  // pixel width on both viewports, so the COUNT of columns is what changed
  // (wider window = more columns, narrower = fewer) — not the tiles stretching.
  expect(Math.abs(narrow.leftmostWidth - wide.leftmostWidth)).toBeLessThanOrEqual(25);
});
