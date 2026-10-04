import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for the Picture Frame photo slideshow tile.
//
// Verifies the tileSettings round-trip through the API whitelist (source,
// interval, fit, and frame styling all survive), the unconfigured tile renders
// its built-in demo slideshow with a Demo badge, the crossfading slideshow
// auto-advances on its configured interval, and the hover prev/next controls
// step through photos manually.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("picture frame persists settings and cycles the demo slideshow", async ({
  page,
}) => {
  const username = `frametest_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Seed a picture-frame tile with a short 10s interval and a custom frame.
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "pictureframe",
      name: "",
      gridX: 0,
      gridY: 0,
      gridW: 6,
      gridH: 5,
      tileSettings: {
        photoSource: "uploads",
        photoInterval: 10,
        photoFit: "contain",
        frameStyle: "custom",
        frameColor: "#336699",
        frameWidth: 8,
      },
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  const tile = (await res.json()) as {
    tileSettings: {
      photoSource: string | null;
      photoInterval: number | null;
      photoFit: string | null;
      frameStyle: string | null;
      frameColor: string | null;
      frameWidth: number | null;
    };
  };

  // Every setting must survive the server-side tileSettings whitelist.
  expect(tile.tileSettings.photoSource).toBe("uploads");
  expect(tile.tileSettings.photoInterval).toBe(10);
  expect(tile.tileSettings.photoFit).toBe("contain");
  expect(tile.tileSettings.frameStyle).toBe("custom");
  expect(tile.tileSettings.frameColor).toBe("#336699");
  expect(tile.tileSettings.frameWidth).toBe(8);

  await page.addInitScript((t) => localStorage.setItem("token", t), token);
  await page.goto("/");

  const frame = page.getByTestId("pictureframe-tile");
  await expect(frame).toBeVisible();

  // Unconfigured source (no uploads picked) → built-in demo slideshow with a
  // visible Demo badge and a rendered photo.
  await expect(frame.getByTestId("pictureframe-demo-badge")).toBeVisible();
  const photo = frame.getByTestId("pictureframe-photo");
  await expect(photo).toBeVisible();
  const firstId = await photo.getAttribute("data-photo-id");
  expect(firstId).toBeTruthy();

  // The photo respects the configured fit.
  const objectFit = await photo.evaluate((el) => getComputedStyle(el).objectFit);
  expect(objectFit).toBe("contain");

  // The custom frame paints its color and width as padding around the photo
  // area.
  const framePad = frame.locator("div[style*='rgb(51, 102, 153)']");
  await expect(framePad).toHaveCount(1);
  const padding = await framePad.evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(padding).toBe("8px");

  // Hover next/prev step through the demo photos manually.
  await frame.hover();
  await frame.getByTestId("pictureframe-next").click();
  await expect
    .poll(async () => photo.getAttribute("data-photo-id"))
    .not.toBe(firstId);
  const secondId = await photo.getAttribute("data-photo-id");
  await frame.hover();
  await frame.getByTestId("pictureframe-prev").click();
  await expect
    .poll(async () => photo.getAttribute("data-photo-id"))
    .toBe(firstId);
  expect(secondId).not.toBe(firstId);

  // The slideshow auto-advances on its 10s interval (crossfade to the next
  // demo photo without any interaction).
  await expect
    .poll(async () => photo.getAttribute("data-photo-id"), { timeout: 15_000 })
    .not.toBe(firstId);
});

test("picture frame with a server album in sample mode shows demo photos", async ({
  page,
}) => {
  const username = `framegoog_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  // The albums endpoint reports sample mode for an unconfigured Immich.
  const albums = await page.request.get("/api/widgets/photos/albums?source=immich", {
    headers: authHeaders,
  });
  expect(albums.ok()).toBeTruthy();
  const albumsBody = (await albums.json()) as {
    sample?: boolean;
    albums: { id: string }[];
  };
  expect(albumsBody.sample).toBe(true);
  expect(albumsBody.albums.length).toBeGreaterThan(0);

  // A tile pointed at a sample album renders the demo slideshow.
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "pictureframe",
      name: "",
      gridX: 0,
      gridY: 0,
      gridW: 5,
      gridH: 4,
      tileSettings: {
        photoSource: "immich",
        photoAlbumId: albumsBody.albums[0].id,
        photoInterval: 0,
        frameStyle: "wood",
      },
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.addInitScript((t) => localStorage.setItem("token", t), token);
  await page.goto("/");

  const frame = page.getByTestId("pictureframe-tile");
  await expect(frame).toBeVisible();
  await expect(frame.getByTestId("pictureframe-demo-badge")).toBeVisible();
  await expect(frame.getByTestId("pictureframe-photo")).toBeVisible();
});
