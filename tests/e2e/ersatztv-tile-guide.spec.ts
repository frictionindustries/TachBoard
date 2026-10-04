import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for the ErsatzTV status tile's embedded TV guide + channel remote.
//
// Verifies: (1) the guide metric is opt-in — a tile with a null metric
// selection renders no guide; (2) with the guide metric on and a mocked real
// lineup, the DirecTV-style grid renders inline on the tile; (3) with a Video
// Player tile (source: ErsatzTV) on the same page, clicking a guide channel
// re-tunes that player (tuning banner + persisted videoErsatzChannel); and
// (4) with no eligible player, guide channels render without any click
// affordance.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function register(page: import("@playwright/test").Page) {
  const username = `ersatzguide_${rand()}`;
  const password = `Pw_${rand()}!`;
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  return { token, authHeaders: { Authorization: `Bearer ${token}` } };
}

async function seedErsatzTile(
  page: import("@playwright/test").Page,
  authHeaders: Record<string, string>,
  metrics: string[] | null,
) {
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "ersatztv",
      name: "ErsatzTV",
      gridX: 0,
      gridY: 0,
      gridW: 6,
      gridH: 6,
      metrics,
    },
    headers: authHeaders,
  });
  expect(res.ok(), `ersatztv tile create failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as { id: number };
}

async function seedPlayerTile(
  page: import("@playwright/test").Page,
  authHeaders: Record<string, string>,
  channel: string,
) {
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "videoplayer",
      name: "",
      gridX: 6,
      gridY: 0,
      gridW: 6,
      gridH: 5,
      tileSettings: {
        videoSource: "ersatztv",
        videoErsatzChannel: channel,
        videoMuted: true,
      },
    },
    headers: authHeaders,
  });
  expect(res.ok(), `player tile create failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as { id: number };
}

async function mockErsatz(page: import("@playwright/test").Page) {
  const now = Date.now();
  const iso = (min: number) => new Date(now + min * 60_000).toISOString();
  await page.route("**/api/widgets/ersatztv", (route) =>
    route.fulfill({
      json: {
        reachable: true,
        activeStreams: 1,
        channels: [
          { number: "1", name: "Movies", nowPlaying: "The Maltese Falcon" },
          { number: "2", name: "Cartoons", nowPlaying: "Looney Tunes" },
        ],
      },
    }),
  );
  await page.route("**/api/widgets/ersatztv/channels", (route) =>
    route.fulfill({
      json: {
        sample: false,
        channels: [
          {
            number: "1",
            name: "Movies",
            nowPlaying: "The Maltese Falcon",
            nowPlayingStart: iso(-30),
            nowPlayingStop: iso(30),
            programs: [
              { title: "The Maltese Falcon", start: iso(-30), stop: iso(30) },
              { title: "Casablanca", start: iso(30), stop: iso(120) },
            ],
            streamUrl: "/api/widgets/ersatztv/stream/iptv/channel/1.m3u8",
          },
          {
            number: "2",
            name: "Cartoons",
            nowPlaying: "Looney Tunes",
            programs: [],
            streamUrl: "/api/widgets/ersatztv/stream/iptv/channel/2.m3u8",
          },
        ],
      },
    }),
  );
  await page.route("**/api/widgets/ersatztv/stream/**", () => {
    /* never fulfilled — keeps hls.js loading so no fatal playback errors */
  });
}

async function openDashboard(page: import("@playwright/test").Page, token: string) {
  await page.goto("/");
  await page.evaluate((t) => localStorage.setItem("token", t), token);
  await page.goto("/");
}

test("guide is opt-in: default metric selection renders no guide", async ({ page }) => {
  const { token, authHeaders } = await register(page);
  await seedErsatzTile(page, authHeaders, null);
  await mockErsatz(page);
  await openDashboard(page, token);

  // The tile renders its normal sections…
  await expect(page.getByText("Active streams")).toBeVisible({ timeout: 15000 });
  // …but no embedded guide.
  await expect(page.getByTestId("ersatztv-tile-guide")).toHaveCount(0);
});

test("guide metric renders the grid inline and remotes an ErsatzTV player tile", async ({
  page,
}) => {
  const { token, authHeaders } = await register(page);
  await seedErsatzTile(page, authHeaders, [
    "health",
    "activeStreams",
    "nowPlaying",
    "guide",
  ]);
  const player = await seedPlayerTile(page, authHeaders, "2");
  await mockErsatz(page);
  await openDashboard(page, token);

  // Inline guide: grid, now-line, programme blocks, airing highlight.
  await expect(page.getByTestId("ersatztv-tile-guide")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("ersatztv-tile-guide-grid")).toBeVisible();
  await expect(page.getByTestId("ersatztv-tile-guide-nowline")).toBeAttached();
  const airing = page.locator(
    '[data-testid="ersatztv-tile-guide-program"][data-airing="true"]',
  );
  await expect(airing).toHaveCount(1);
  await expect(airing).toContainText("The Maltese Falcon");

  // The player's tuned channel (2) is highlighted as current in the guide.
  const entries = page.getByTestId("ersatztv-tile-channel-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(1)).toHaveAttribute("data-current", "true");

  // Remote: click channel 1 → player shows its tuning banner for channel 1
  // and the change is persisted on the player tile.
  await entries.nth(0).click();
  const banner = page.getByTestId("videoplayer-tuning-banner");
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner).toContainText("Movies");
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/tiles", { headers: authHeaders });
      const tiles = (await res.json()) as {
        id: number;
        tileSettings?: { videoErsatzChannel?: string | null };
      }[];
      return (
        tiles.find((t) => t.id === player.id)?.tileSettings
          ?.videoErsatzChannel ?? null
      );
    })
    .toBe("1");
});

test("without an eligible player the guide is read-only but still shows programme details", async ({
  page,
}) => {
  const { token, authHeaders } = await register(page);
  await seedErsatzTile(page, authHeaders, ["nowPlaying", "guide"]);
  await mockErsatz(page);
  await openDashboard(page, token);

  await expect(page.getByTestId("ersatztv-tile-guide")).toBeVisible({ timeout: 15000 });
  const entries = page.getByTestId("ersatztv-tile-channel-entry");
  await expect(entries).toHaveCount(2);
  // Channel cells are plain divs, not buttons — nothing to click.
  for (const el of await entries.all()) {
    expect(await el.evaluate((node) => node.tagName)).toBe("DIV");
  }
  // Programme blocks still open the details popover, but with no Watch
  // button (tuning is disabled in read-only mode).
  const airing = page.locator(
    '[data-testid="ersatztv-tile-guide-program"][data-airing="true"]',
  );
  await expect(airing).toHaveCount(1);
  await airing.click();
  const popover = page.getByTestId("ersatztv-tile-guide-program-popover");
  await expect(popover).toBeVisible();
  await expect(
    page.getByTestId("ersatztv-tile-guide-program-popover-title"),
  ).toHaveText("The Maltese Falcon");
  await expect(
    page.getByTestId("ersatztv-tile-guide-program-popover-times"),
  ).toContainText("–");
  await expect(
    page.getByTestId("ersatztv-tile-guide-program-popover-watch"),
  ).toHaveCount(0);
  // Close button dismisses it.
  await page.getByTestId("ersatztv-tile-guide-program-popover-close").click();
  await expect(popover).toHaveCount(0);
});

// Assert `inner` is fully contained inside `outer` (with a small tolerance
// for subpixel rounding).
async function expectContained(
  inner: import("@playwright/test").Locator,
  outer: import("@playwright/test").Locator,
) {
  const i = await inner.boundingBox();
  const o = await outer.boundingBox();
  expect(i, "inner bounding box").toBeTruthy();
  expect(o, "outer bounding box").toBeTruthy();
  if (!i || !o) return;
  const tol = 1;
  expect(i.x, "left edge").toBeGreaterThanOrEqual(o.x - tol);
  expect(i.y, "top edge").toBeGreaterThanOrEqual(o.y - tol);
  expect(i.x + i.width, "right edge").toBeLessThanOrEqual(o.x + o.width + tol);
  expect(i.y + i.height, "bottom edge").toBeLessThanOrEqual(
    o.y + o.height + tol,
  );
}

test("popover stays inside a tiny 4x4 tile and its close button works", async ({
  page,
}) => {
  const { token, authHeaders } = await register(page);
  // Smallest realistic embedded-guide tile.
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "ersatztv",
      name: "ErsatzTV",
      gridX: 0,
      gridY: 0,
      gridW: 4,
      gridH: 4,
      metrics: ["guide"],
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  await mockErsatz(page);
  await openDashboard(page, token);

  const guide = page.getByTestId("ersatztv-tile-guide");
  await expect(guide).toBeVisible({ timeout: 15000 });

  const airing = page.locator(
    '[data-testid="ersatztv-tile-guide-program"][data-airing="true"]',
  );
  await airing.click();
  const popover = page.getByTestId("ersatztv-tile-guide-program-popover");
  await expect(popover).toBeVisible();

  // The popover must be fully contained within the guide area of the tile —
  // no clipping by overflow-hidden and no bleeding over neighbours.
  await expectContained(popover, guide);

  // The close button is visible, inside the tile, and actually dismisses.
  const close = page.getByTestId("ersatztv-tile-guide-program-popover-close");
  await expect(close).toBeVisible();
  await expectContained(close, guide);
  await close.click();
  await expect(popover).toHaveCount(0);
});

test("popover stays readable on a ~400px-wide phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 780 });
  const { token, authHeaders } = await register(page);
  await seedErsatzTile(page, authHeaders, ["nowPlaying", "guide"]);
  await mockErsatz(page);
  await openDashboard(page, token);

  const guide = page.getByTestId("ersatztv-tile-guide");
  await expect(guide).toBeVisible({ timeout: 15000 });

  // Open the popover from the airing programme block. On a narrow viewport
  // large parts of the block sit under the sticky channel column, so a
  // coordinate-based click is unreliable — dispatch the click event on the
  // block itself (the interesting assertions are about the popover, below).
  const airing = page.locator(
    '[data-testid="ersatztv-tile-guide-program"][data-airing="true"]',
  );
  await expect(airing).toBeVisible();
  await airing.dispatchEvent("click");
  const popover = page.getByTestId("ersatztv-tile-guide-program-popover");
  await expect(popover).toBeVisible();

  // Contained in the guide (and therefore in the tile and the viewport).
  await expectContained(popover, guide);
  const box = await popover.boundingBox();
  expect(box).toBeTruthy();
  if (box) {
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(401);
  }

  // Title and times are visible and the close button is clickable.
  await expect(
    page.getByTestId("ersatztv-tile-guide-program-popover-title"),
  ).toBeVisible();
  await expect(
    page.getByTestId("ersatztv-tile-guide-program-popover-times"),
  ).toBeVisible();
  const close = page.getByTestId("ersatztv-tile-guide-program-popover-close");
  await expect(close).toBeVisible();
  await expectContained(close, guide);
  await close.click();
  await expect(popover).toHaveCount(0);
});

test("phone: scrolling the guide timeline makes programmes tappable with a real click", async ({
  page,
}) => {
  // Narrow phone viewport: near "now", programme blocks sit largely under
  // the sticky channel column, so a real pointer click is intercepted. A
  // phone user horizontally scrolls the timeline first — emulate that with
  // a horizontal wheel gesture (Playwright's touch-scroll equivalent) and
  // then tap a programme block with a REAL click (no dispatchEvent).
  await page.setViewportSize({ width: 400, height: 780 });
  const { token, authHeaders } = await register(page);
  // Full-width tile — on a phone the guide tile spans the screen.
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "ersatztv",
      name: "ErsatzTV",
      gridX: 0,
      gridY: 0,
      gridW: 12,
      gridH: 8,
      metrics: ["nowPlaying", "guide"],
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  await mockErsatz(page);
  await openDashboard(page, token);

  const grid = page.getByTestId("ersatztv-tile-guide-grid");
  await expect(grid).toBeVisible({ timeout: 15000 });
  // Wait for the auto-scroll (now-line positioning) to settle so the user
  // scroll below isn't overwritten.
  await expect
    .poll(() => grid.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  const before = await grid.evaluate((el) => el.scrollLeft);

  // The upcoming programme (Casablanca, starts +30m) begins to the right of
  // "now" — on this narrow viewport its left portion sits beyond / under the
  // sticky channel column. Scroll the timeline by exactly the distance that
  // brings its left edge just past the sticky column.
  const upcoming = page
    .getByTestId("ersatztv-tile-guide-program")
    .filter({ hasText: "Casablanca" });
  await expect(upcoming).toBeVisible();
  const sticky = await page
    .getByTestId("ersatztv-tile-channel-entry")
    .first()
    .boundingBox();
  const blockBefore = await upcoming.boundingBox();
  expect(sticky, "sticky column box").toBeTruthy();
  expect(blockBefore, "programme block box").toBeTruthy();
  if (!sticky || !blockBefore) return;
  const stickyRight = sticky.x + sticky.width;
  const delta = Math.round(blockBefore.x - (stickyRight + 8));
  expect(delta, "programme starts right of the sticky column").toBeGreaterThan(0);

  // Scroll with a horizontal wheel gesture over the timeline area (the
  // pointer-driven equivalent of a phone touch-scroll).
  const box = await grid.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2);
  await page.mouse.wheel(delta, 0);
  await expect
    .poll(() => grid.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(before);

  // Now the block's left portion is inside the visible timeline — a REAL
  // pointer click there must land on the block (not be intercepted by the
  // sticky column) and open its details popover. Click via raw mouse
  // coordinates so Playwright's auto scroll-into-view doesn't undo the
  // user's scroll position.
  const blockAfter = await upcoming.boundingBox();
  expect(blockAfter).toBeTruthy();
  if (!blockAfter) return;
  const clickX = blockAfter.x + 12;
  const clickY = blockAfter.y + blockAfter.height / 2;
  expect(clickX, "click point clear of the sticky column").toBeGreaterThan(
    stickyRight,
  );
  await page.mouse.click(clickX, clickY);
  const popover = page.getByTestId("ersatztv-tile-guide-program-popover");
  await expect(popover).toBeVisible();
  await expect(
    page.getByTestId("ersatztv-tile-guide-program-popover-title"),
  ).toHaveText("Casablanca");
  await page.getByTestId("ersatztv-tile-guide-program-popover-close").click();
  await expect(popover).toHaveCount(0);
});

test("tapping an upcoming programme block shows its start–stop times", async ({
  page,
}) => {
  const { token, authHeaders } = await register(page);
  await seedErsatzTile(page, authHeaders, ["nowPlaying", "guide"]);
  await mockErsatz(page);
  await openDashboard(page, token);

  await expect(page.getByTestId("ersatztv-tile-guide")).toBeVisible({ timeout: 15000 });
  // The future programme (Casablanca, +30m → +120m) opens a popover with
  // its title and start–stop times.
  const upcoming = page
    .getByTestId("ersatztv-tile-guide-program")
    .filter({ hasText: "Casablanca" });
  await expect(upcoming).toHaveCount(1);
  await upcoming.click();
  const popover = page.getByTestId("ersatztv-tile-guide-program-popover");
  await expect(popover).toBeVisible();
  await expect(
    page.getByTestId("ersatztv-tile-guide-program-popover-title"),
  ).toHaveText("Casablanca");
  const times = page.getByTestId("ersatztv-tile-guide-program-popover-times");
  await expect(times).toContainText("–");
  await expect(times).toContainText("1h 30m");
  // Escape dismisses it too.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});
