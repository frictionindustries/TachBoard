import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Edit-mode safe-zone (fold) guide (task #407).
//
// In edit mode a dotted line marks the fold — the point where content starts
// requiring scrolling. It's purely visual: pointer-events-none, only in edit
// mode, and repositions on viewport resize.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("edit mode shows a non-interactive fold guide that tracks viewport height", async ({
  page,
}) => {
  const username = `foldtest_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  const res = await page.request.post("/api/tiles", {
    data: { name: "A Tile", gridX: 0, gridY: 0, gridW: 4, gridH: 4 },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  const guide = page.getByTestId("fold-guide");

  // Locked mode: no guide.
  await expect(guide).toHaveCount(0);

  // Edit mode: guide appears with its label, and never captures pointer events.
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await expect(guide).toBeVisible();
  await expect(guide).toContainText(/visible without scrolling/i);
  await expect(guide).toHaveCSS("pointer-events", "none");

  // The guide sits at the fold: its document-space Y position should equal the
  // viewport height (within a couple px of rounding).
  const foldY = async () =>
    guide.evaluate(
      (el) => el.getBoundingClientRect().top + window.scrollY,
    );
  const y1 = await foldY();
  expect(Math.abs(y1 - 800)).toBeLessThanOrEqual(2);

  // Resizing the viewport moves the guide accordingly.
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect
    .poll(async () => Math.abs((await foldY()) - 600))
    .toBeLessThanOrEqual(2);

  // Dragging a tile still works with the guide present (guide doesn't block).
  const tile = page.locator(".react-grid-item").first();
  const before = await tile.boundingBox();
  expect(before).toBeTruthy();
  const handle = tile.locator(".drag-handle");
  await handle.hover({ position: { x: 10, y: 40 } });
  await page.mouse.down();
  await page.mouse.move(before!.x + 300, before!.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await tile.boundingBox())!.x)
    .toBeGreaterThan(before!.x + 100);

  // Leaving edit mode hides the guide.
  await page.getByRole("button", { name: /^Done$/ }).click();
  await expect(guide).toHaveCount(0);
});

test("a vertical guide marks the fixed page's width limit in edit mode", async ({
  page,
}) => {
  const username = `foldxtest_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  const res = await page.request.post("/api/tiles", {
    data: { name: "A Tile", gridX: 0, gridY: 0, gridW: 4, gridH: 4 },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await page.getByRole("button", { name: /^Edit$/ }).click();

  const vGuide = page.getByTestId("fold-guide-vertical");

  // Fluid (auto) pages have no fixed width limit — no vertical guide.
  await expect(vGuide).toHaveCount(0);

  // The guide's document-space X vs the grid's right edge.
  const guideX = () =>
    vGuide.evaluate((el) => el.getBoundingClientRect().left + window.scrollX);
  const gridRight = () =>
    page
      .locator(".react-grid-layout")
      .evaluate((el) => el.getBoundingClientRect().right + window.scrollX);

  // Lock the page to a Compact preset: the fixed canvas is NARROWER than the
  // 1280px viewport, and the guide marks its right (max-width) boundary.
  await page.getByRole("button", { name: /Auto \/ responsive/i }).click();
  await page.getByRole("menuitemradio", { name: /^Compact$/ }).click();

  await expect(vGuide).toBeVisible();
  await expect(vGuide).toHaveCSS("pointer-events", "none");
  expect(Math.abs((await guideX()) - (await gridRight()))).toBeLessThanOrEqual(3);
  // Sanity: on this compact preset the boundary is inside the viewport.
  expect(await gridRight()).toBeLessThan(1280);

  // Switch to a 4K preset: the canvas is WIDER than the viewport; the guide
  // still tracks the grid's right edge (it scrolls with the grid).
  await page.getByRole("button", { name: /Compact/ }).click();
  await page.getByRole("menuitemradio", { name: /^4K$/ }).click();

  await expect
    .poll(async () => Math.abs((await guideX()) - (await gridRight())))
    .toBeLessThanOrEqual(3);
  expect(await gridRight()).toBeGreaterThan(1280);

  // Leaving edit mode hides it (locked fixed pages are scaled to fit).
  await page.getByRole("button", { name: /^Done$/ }).click();
  await expect(vGuide).toHaveCount(0);
});
