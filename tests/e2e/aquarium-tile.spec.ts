import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for the Aquarium fun tile.
//
// The tile is purely cosmetic: an animated SVG fish tank that fills the tile,
// with fish species / sand color / decoration props persisted in tileSettings.
// This verifies the settings round-trip through the API whitelist, the tile
// renders its tank SVG on the dashboard, and the fish/prop population scales
// with tile size (a big tile shows more fish than the small-tile minimum).
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("aquarium tile persists settings and renders a populated tank", async ({
  page,
}) => {
  const username = `aquatest_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Seed a large aquarium tile with explicit settings.
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "aquarium",
      name: "",
      gridX: 0,
      gridY: 0,
      gridW: 6,
      gridH: 6,
      tileSettings: {
        aquariumFishTypes: ["goldfish", "betta", "pufferfish"],
        aquariumSandColor: "#c08552",
        aquariumProps: ["castle", "anchor", "chest"],
      },
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  const tile = (await res.json()) as {
    id: number;
    tileSettings: {
      aquariumFishTypes: string[] | null;
      aquariumSandColor: string | null;
      aquariumProps: string[] | null;
    };
  };

  // Settings must survive the server-side tileSettings whitelist.
  expect(tile.tileSettings.aquariumFishTypes).toEqual([
    "goldfish",
    "betta",
    "pufferfish",
  ]);
  expect(tile.tileSettings.aquariumSandColor).toBe("#c08552");
  expect(tile.tileSettings.aquariumProps).toEqual(["castle", "anchor", "chest"]);

  // Load the dashboard authenticated and find the rendered tank. Pin the
  // clock to mid-morning so the time-driven mood is the calm baseline
  // (particle/bubble density assertions below assume it).
  await page.addInitScript((t) => localStorage.setItem("token", t), token);
  await page.clock.setFixedTime(new Date("2026-07-18T10:00:00"));
  await page.goto("/");
  const tank = page.getByRole("img", { name: "Aquarium" });
  await expect(tank).toBeVisible();

  // The custom sand hex is painted on the floor path.
  await expect(tank.locator('path[fill="#c08552"]')).toHaveCount(1);

  // Fish population scales with pixel area: a 6x6 tile is large, so there
  // must be more than the small-tile minimum of 2 fish.
  const fishCount = await tank.locator("g.aq-fish").count();
  expect(fishCount).toBeGreaterThan(2);

  // Ambient bubble streams rise from the sand (pure CSS animation, always on).
  const bubbleCount = await tank.locator("g.aq-bubble").count();
  expect(bubbleCount).toBeGreaterThanOrEqual(2);

  // Mood layer: 1-2 diagonal light rays sweep the tank, and on a large tile
  // a few faint particles drift with the water (both pure CSS keyframes).
  const rayCount = await tank.locator("g.aq-ray").count();
  expect(rayCount).toBeGreaterThanOrEqual(1);
  expect(rayCount).toBeLessThanOrEqual(2);
  const particleCount = await tank.locator("g.aq-particle").count();
  expect(particleCount).toBeGreaterThanOrEqual(4);

  // At least one decoration prop is on the sand (castle base rects render as
  // fill #a9a29a, anchor strokes #6b7683, chest fill #8a5a2b).
  const propMarkup = await tank.innerHTML();
  expect(
    propMarkup.includes("#a9a29a") ||
      propMarkup.includes("#6b7683") ||
      propMarkup.includes("#8a5a2b"),
  ).toBe(true);

  // ---- Click reactions (locked mode) ----

  // Clicking the water drops a transient food pellet at the click point and
  // sends the nearest fish swimming over to eat it (no tank-wide wiggle).
  const box = await tank.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.3);
  await expect(tank.locator("g.aq-pellet")).toHaveCount(1);
  await expect(tank.locator("g.aq-feeding")).toHaveCount(1);
  // Exactly one fish reacts; the rest keep their normal swim loop.
  const swimmingCount = await tank.locator("g.aq-fish").count();
  expect(swimmingCount).toBe(fishCount - 1);
  expect(await tank.locator("g.aq-excite").count()).toBe(0);

  // Regression: the pellet must render at the click point, not at the tile's
  // left edge (the sink animation once overrode the placement transform).
  const pelletBox = await tank.locator("g.aq-pellet").boundingBox();
  expect(pelletBox).not.toBeNull();
  const pelletCenterX = pelletBox!.x + pelletBox!.width / 2;
  expect(Math.abs(pelletCenterX - (box!.x + box!.width * 0.5))).toBeLessThan(
    box!.width * 0.1,
  );

  // When the fish reaches the pellet, a one-off chomp flourish plays at the
  // landing point (crumb particles + a small bubble puff), then fades.
  await expect(tank.locator("g.aq-crumb").first()).toBeAttached({ timeout: 10_000 });
  await expect(tank.locator("g.aq-crumb")).toHaveCount(0, { timeout: 10_000 });

  // The pellet is transient: eaten or sunk, it is removed; the feeding fish
  // finishes its meal and rejoins the normal swim loop.
  await expect(tank.locator("g.aq-pellet")).toHaveCount(0, { timeout: 10_000 });
  await expect(tank.locator("g.aq-feeding")).toHaveCount(0, { timeout: 10_000 });
  await expect(tank.locator("g.aq-fish")).toHaveCount(fishCount);

  // Clicking a fish makes it dart (one-off burst animation, then cleared).
  await tank.locator("g.aq-fish-hit").first().click({ force: true });
  await expect(tank.locator("g.aq-dart")).toHaveCount(1);
  await expect(tank.locator("g.aq-dart")).toHaveCount(0, { timeout: 10_000 });
});

test("aquarium mood follows the time of day", async ({ page }) => {
  const username = `aquamood_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "aquarium",
      name: "",
      gridX: 0,
      gridY: 0,
      gridW: 6,
      gridH: 6,
      tileSettings: {},
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.addInitScript((t) => localStorage.setItem("token", t), token);

  // 10 PM: night mode — dark water gradient and dimmed light rays.
  await page.clock.setFixedTime(new Date("2026-07-18T22:00:00"));
  await page.goto("/");
  const tank = page.getByRole("img", { name: "Aquarium" });
  await expect(tank).toBeVisible();
  await expect(tank.locator('stop[stop-color="#0a1c33"]')).toHaveCount(1);
  expect(
    await tank.locator("g.aq-ray").first().getAttribute("opacity"),
  ).toBe("0.35");
  const nightStreams = await tank.locator("g.aq-bubble").count();

  // 2 PM: lively mode — bright water, extra bubble streams versus night
  // (night = base-1 streams, lively = base+2) and a guaranteed minimum of
  // drifting particles, with rays back to full strength.
  await page.clock.setFixedTime(new Date("2026-07-18T14:00:00"));
  await page.reload();
  await expect(tank).toBeVisible();
  await expect(tank.locator('stop[stop-color="#1e5f92"]')).toHaveCount(1);
  const livelyBubbles = await tank.locator("g.aq-bubble").count();
  expect(livelyBubbles).toBeGreaterThan(nightStreams);
  expect(await tank.locator("g.aq-particle").count()).toBeGreaterThanOrEqual(4);
  expect(
    await tank.locator("g.aq-ray").first().getAttribute("opacity"),
  ).toBe("1");

  // 10 AM: calm mode — bright water, no ray dimming, and fewer bubble
  // streams than lively (calm adds none on top of the base count).
  await page.clock.setFixedTime(new Date("2026-07-18T10:00:00"));
  await page.reload();
  await expect(tank).toBeVisible();
  await expect(tank.locator('stop[stop-color="#1e5f92"]')).toHaveCount(1);
  expect(await tank.locator("g.aq-bubble").count()).toBeLessThan(livelyBubbles);
  expect(
    await tank.locator("g.aq-ray").first().getAttribute("opacity"),
  ).toBe("1");
});
