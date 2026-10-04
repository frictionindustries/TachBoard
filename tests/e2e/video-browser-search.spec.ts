import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for the Find-videos browser's search box: typing filters the
// loaded poster grid (shows, movies, and episode rows) client-side, a
// non-matching query shows the "No matches" empty state, and clearing the
// search (X button or navigation) restores the full grid.
//
// The Plex endpoints are mocked with page.route so no real server is needed.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function register(page: import("@playwright/test").Page) {
  const username = `vbsearch_${rand()}`;
  const password = `Pw_${rand()}!`;
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  return { token, authHeaders: { Authorization: `Bearer ${token}` } };
}

test("browser search filters shows, movies, and episodes; clearing restores the grid", async ({
  page,
}) => {
  const { token, authHeaders } = await register(page);

  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "videoplayer",
      name: "",
      gridX: 0,
      gridY: 0,
      gridW: 6,
      gridH: 5,
      tileSettings: { videoSource: "plex", videoLibraryId: "1", videoMuted: true },
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  // Mock the library + browse endpoints so the browser has real-looking data.
  await page.route("**/api/widgets/videoplayer/libraries*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sample: false,
        libraries: [
          { id: "1", title: "TV Shows", kind: "shows" },
          { id: "2", title: "Movies", kind: "movies" },
        ],
      }),
    }),
  );
  await page.route("**/api/widgets/videoplayer/browse*", (route) => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get("kind");
    let body: unknown;
    if (kind === "shows") {
      body = {
        sample: false,
        containers: [
          { id: "s1", title: "Breaking Sad", kind: "show", thumb: null },
          { id: "s2", title: "Galaxy Quests", kind: "show", thumb: null },
          { id: "s3", title: "The Breakfast Hour", kind: "show", thumb: null },
        ],
      };
    } else if (kind === "movies") {
      body = {
        sample: false,
        videos: [
          { id: "m1", title: "Ocean Drift", streamUrl: "https://example.com/m1.mp4" },
          { id: "m2", title: "Mountain Echo", streamUrl: "https://example.com/m2.mp4" },
          { id: "m3", title: "Ocean Sunrise", streamUrl: "https://example.com/m3.mp4" },
        ],
      };
    } else if (kind === "seasons") {
      body = {
        sample: false,
        containers: [{ id: "sea1", title: "Season 1", kind: "season", thumb: null }],
      };
    } else {
      // episodes / show_episodes
      body = {
        sample: false,
        videos: [
          { id: "e1", title: "Pilot", streamUrl: "https://example.com/e1.mp4" },
          { id: "e2", title: "The Fall", streamUrl: "https://example.com/e2.mp4" },
          { id: "e3", title: "Falling Up", streamUrl: "https://example.com/e3.mp4" },
        ],
      };
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.addInitScript((t) => localStorage.setItem("token", t), token);
  await page.goto("/");

  const tileEl = page.getByTestId("videoplayer-tile");
  await expect(tileEl).toBeVisible();

  // Open the drill-down browser.
  await tileEl.hover();
  await tileEl.getByTestId("videoplayer-playlist-toggle").click();
  const browser = page.getByTestId("videoplayer-browser");
  await expect(browser).toBeVisible();

  // The first library (TV Shows) auto-loads with all three shows.
  await expect(browser.getByTestId("videoplayer-browser-show")).toHaveCount(3);

  // Typing filters case-insensitively as you type.
  const search = browser.getByTestId("videoplayer-browser-search");
  await search.fill("break");
  await expect(browser.getByTestId("videoplayer-browser-show")).toHaveCount(2);
  await expect(browser.getByText("Breaking Sad")).toBeVisible();
  await expect(browser.getByText("The Breakfast Hour")).toBeVisible();

  // Non-matching query → explicit empty state, not "Nothing here."
  await search.fill("zzz no such show");
  await expect(browser.getByTestId("videoplayer-browser-show")).toHaveCount(0);
  await expect(browser.getByTestId("videoplayer-browser-search-empty")).toBeVisible();

  // The clear (X) button restores the full grid.
  await browser.getByTestId("videoplayer-browser-search-clear").click();
  await expect(browser.getByTestId("videoplayer-browser-show")).toHaveCount(3);
  await expect(search).toHaveValue("");

  // Drilling into a show resets any typed search for the new level.
  await search.fill("break");
  await browser.getByTestId("videoplayer-browser-show").first().getByText("Breaking Sad").click();
  await expect(browser.getByTestId("videoplayer-browser-season")).toHaveCount(1);
  await expect(search).toHaveValue("");

  // Season → episodes list: search filters episode rows too.
  await browser.getByTestId("videoplayer-browser-season").getByText("Season 1").click();
  await expect(browser.getByTestId("videoplayer-browser-video")).toHaveCount(3);
  await search.fill("fall");
  await expect(browser.getByTestId("videoplayer-browser-video")).toHaveCount(2);

  // Switching to the Movies library clears the search and filters movies.
  await browser.getByTestId("videoplayer-browser-library").filter({ hasText: "Movies" }).click();
  await expect(browser.getByTestId("videoplayer-browser-video")).toHaveCount(3);
  await expect(search).toHaveValue("");
  await search.fill("ocean");
  await expect(browser.getByTestId("videoplayer-browser-video")).toHaveCount(2);
});
