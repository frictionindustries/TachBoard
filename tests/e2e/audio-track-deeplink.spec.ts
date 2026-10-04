import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for clickable now-playing track info (artist / album) opening the
// Music Browser deep-linked into that artist or album.
//
// Uses the public Navidrome demo server (demo.navidrome.org, demo/demo) as a
// real Subsonic source so tracks carry artistId/albumId. When nothing is live
// on the demo server, the backend falls back to the newest album's tracks —
// the first one still becomes nowPlaying and carries both IDs, so the artist
// and album lines render as buttons either way.
//
// Also verifies the negative path: the Plex demo payload (unconfigured) has no
// artistId/albumId, so its track info renders as plain text, not buttons.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function registerAndAuth(page: import("@playwright/test").Page) {
  const username = `deeplink_${rand()}`;
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
  return { Authorization: `Bearer ${token}` };
}

test("clicking now-playing artist/album deep-links the music browser (Subsonic)", async ({
  page,
}) => {
  const authHeaders = await registerAndAuth(page);

  // Point the subsonic connection at the public Navidrome demo server.
  const save = await page.request.put("/api/connections/subsonic", {
    data: { url: "https://demo.navidrome.org", username: "demo", password: "demo" },
    headers: authHeaders,
  });
  expect(save.ok(), `connection save failed: ${save.status()}`).toBeTruthy();

  // Confirm the now-playing payload carries the new parent IDs.
  const widget = await page.request.get("/api/widgets/audioplayer?source=subsonic", {
    headers: authHeaders,
  });
  expect(widget.ok(), `widget fetch failed: ${widget.status()}`).toBeTruthy();
  const payload = (await widget.json()) as {
    sample: boolean;
    nowPlaying: {
      artist: string | null;
      artistId: string | null;
      album: string | null;
      albumId: string | null;
    } | null;
  };
  expect(payload.sample).toBe(false);
  expect(payload.nowPlaying?.artistId).toBeTruthy();
  expect(payload.nowPlaying?.albumId).toBeTruthy();
  const artistName = payload.nowPlaying!.artist!;
  const albumName = payload.nowPlaying!.album!;

  // Seed an Audio Player tile backed by the subsonic source.
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "audioplayer",
      name: "Audio",
      gridX: 0,
      gridY: 0,
      gridW: 4,
      gridH: 6,
      tileSettings: { audioSource: "subsonic" },
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".react-grid-item")).toHaveCount(1);

  // The artist line renders as a button with a "Browse …" tooltip affordance.
  const artistButton = page.locator(`button[title="Browse ${artistName}"]`);
  await expect(artistButton).toBeVisible();
  await artistButton.click();

  // The browser opens deep-linked into the artist: breadcrumb Artists › name.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Find music")).toBeVisible();
  // Both the root pill and the breadcrumb entry render "Artists".
  await expect(dialog.getByRole("button", { name: "Artists" })).toHaveCount(2);
  await expect(
    dialog.getByRole("button", { name: artistName, exact: true }).last(),
  ).toBeVisible();

  // Breadcrumb back navigation still works from the deep-linked view.
  await dialog.getByRole("button", { name: "Artists" }).last().click();
  await expect(dialog.getByText("Loading…")).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The album line deep-links likewise.
  const albumButton = page.locator(`button[title="Browse ${albumName}"]`);
  await expect(albumButton).toBeVisible();
  await albumButton.click();
  const dialog2 = page.getByRole("dialog");
  await expect(dialog2.getByText("Find music")).toBeVisible();
  // Both the root pill and the breadcrumb entry render "Albums".
  await expect(dialog2.getByRole("button", { name: "Albums" })).toHaveCount(2);
});

test("Jellyfin now-playing artist/album deep-link the music browser", async ({
  page,
}) => {
  const authHeaders = await registerAndAuth(page);

  // Unconfigured Jellyfin serves demo tracks whose artistId/albumId point into
  // the demo browse catalog, so the full click → deep-link → listing flow can
  // be exercised without a live Jellyfin server.
  const widget = await page.request.get("/api/widgets/audioplayer?source=jellyfin", {
    headers: authHeaders,
  });
  expect(widget.ok(), `widget fetch failed: ${widget.status()}`).toBeTruthy();
  const payload = (await widget.json()) as {
    nowPlaying: { artist: string | null; artistId: string | null; albumId: string | null } | null;
  };
  expect(payload.nowPlaying?.artistId).toBeTruthy();
  expect(payload.nowPlaying?.albumId).toBeTruthy();

  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "audioplayer",
      name: "Audio",
      gridX: 0,
      gridY: 0,
      gridW: 4,
      gridH: 6,
      tileSettings: { audioSource: "jellyfin" },
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".react-grid-item")).toHaveCount(1);

  // The artist line is a deep-link button for Jellyfin too.
  const artistButton = page.locator('button[title="Browse Fleetwood Mac"]');
  await expect(artistButton).toBeVisible();
  await artistButton.click();

  // Browser opens deep-linked into the artist; its albums (demo catalog) load.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Find music")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Artists" })).toHaveCount(2);
  await expect(dialog.getByText("Rumours").first()).toBeVisible();

  // Breadcrumb back navigation works from the deep-linked view.
  await dialog.getByRole("button", { name: "Artists" }).last().click();
  await expect(dialog.getByText("Loading…")).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Album deep link likewise.
  const albumButton = page.locator('button[title="Browse Rumours"]');
  await expect(albumButton).toBeVisible();
  await albumButton.click();
  const dialog2 = page.getByRole("dialog");
  await expect(dialog2.getByRole("button", { name: "Albums" })).toHaveCount(2);
  await expect(dialog2.getByText("Dreams").first()).toBeVisible();
});

test("demo (unconfigured) track info stays plain text — no deep-link buttons", async ({
  page,
}) => {
  const authHeaders = await registerAndAuth(page);

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

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  // Demo payload has no artistId/albumId → artist renders, but never as a
  // "Browse …" button.
  await expect(page.getByText("Fleetwood Mac").first()).toBeVisible();
  await expect(page.locator('button[title^="Browse "]')).toHaveCount(0);
});
