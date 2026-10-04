import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for the Audio Player tile (Plex source) demo path.
//
// On Replit / CI there is no reachable Plex server, so the backend's
// "demo-when-unconfigured" convention kicks in: GET /api/widgets/audioplayer
// returns sample:true with a built-in Fleetwood Mac queue and streamUrl=null.
// This verifies the tile is selectable, renders the now-playing track, the
// "Demo" badge, and the up-next queue — and that playback controls are
// disabled because demo tracks carry no streamUrl.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("audio player tile renders demo now-playing + queue with controls disabled", async ({
  page,
}) => {
  const username = `audiotest_${rand()}`;
  const password = `Pw_${rand()}!`;

  // Auth is a Bearer JWT (returned by /api/auth/register, stored by the app in
  // localStorage["token"]).
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  expect(token, "register returned no token").toBeTruthy();
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Sanity-check the widget endpoint itself returns the demo payload.
  const widget = await page.request.get("/api/widgets/audioplayer?source=plex", {
    headers: authHeaders,
  });
  expect(widget.ok(), `widget fetch failed: ${widget.status()}`).toBeTruthy();
  const payload = (await widget.json()) as {
    sample: boolean;
    nowPlaying: { title: string } | null;
    queue: { id: string; streamUrl: string | null }[];
  };
  expect(payload.sample).toBe(true);
  expect(payload.nowPlaying?.title).toBe("Dreams");
  expect(payload.queue.length).toBeGreaterThanOrEqual(3);
  // Demo tracks are not streamable.
  expect(payload.queue.every((t) => t.streamUrl === null)).toBe(true);

  // Seed an Audio Player tile big enough to reveal controls + queue.
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "audioplayer",
      name: "Audio",
      gridX: 0,
      gridY: 0,
      gridW: 4,
      gridH: 6,
      tileSettings: { audioSource: "plex" },
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  // Authenticate the browser for every page load.
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".react-grid-item")).toHaveCount(1);

  // Now-playing track + artist render.
  await expect(page.getByText("Dreams", { exact: true })).toBeVisible();
  await expect(page.getByText("Fleetwood Mac").first()).toBeVisible();

  // The demo badge is shown for sample data.
  await expect(page.getByText("Demo", { exact: true })).toBeVisible();

  // Up-next queue surfaces the other album tracks.
  await expect(page.getByText("Up Next", { exact: true })).toBeVisible();
  await expect(page.getByText("The Chain", { exact: true })).toBeVisible();

  // The play/pause toggle is disabled for demo (no streamUrl). The demo
  // now-playing track reports state "playing", so the toggle exposes the
  // "Pause" accessible name.
  await expect(page.getByRole("button", { name: "Pause" })).toBeDisabled();
});
