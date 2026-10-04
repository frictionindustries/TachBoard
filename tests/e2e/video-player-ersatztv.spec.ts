import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for the Video Player tile's ErsatzTV live-TV source.
//
// Verifies the videoErsatzChannel setting survives the API whitelist, an
// unconfigured ErsatzTV (sample lineup, no stream URLs) keeps the yule log
// demo, and — with a mocked real lineup — the tile shows the tuned channel's
// guide line, opens the channel pop-out, and persists a channel change.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function register(page: import("@playwright/test").Page) {
  const username = `ersatzvid_${rand()}`;
  const password = `Pw_${rand()}!`;
  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  return { token, authHeaders: { Authorization: `Bearer ${token}` } };
}

async function seedTile(
  page: import("@playwright/test").Page,
  authHeaders: Record<string, string>,
  channel: string | null,
) {
  const res = await page.request.post("/api/tiles", {
    data: {
      type: "integration",
      integration: "videoplayer",
      name: "",
      gridX: 0,
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
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as { id: number; tileSettings: Record<string, unknown> };
}

async function openDashboard(page: import("@playwright/test").Page, token: string) {
  await page.goto("/");
  await page.evaluate((t) => localStorage.setItem("token", t), token);
  await page.goto("/");
  await expect(page.getByTestId("videoplayer-video")).toBeVisible({ timeout: 15000 });
}

test("ersatztv source round-trips its channel setting and demos when unconfigured", async ({
  page,
}) => {
  const { token, authHeaders } = await register(page);
  const tile = await seedTile(page, authHeaders, "7");

  // Whitelist round-trip: the saved tile keeps source + channel.
  expect(tile.tileSettings["videoSource"]).toBe("ersatztv");
  expect(tile.tileSettings["videoErsatzChannel"]).toBe("7");

  // No ErsatzTV connection on this fresh account → sample lineup → the tile
  // plays the yule log demo (badge visible, no channels toggle).
  await openDashboard(page, token);
  await expect(page.getByTestId("videoplayer-demo-badge")).toBeVisible();
  await expect(page.getByTestId("videoplayer-channels-toggle")).toHaveCount(0);
});

test("ersatztv tile shows the tuned channel and persists channel switching", async ({
  page,
}) => {
  const { token, authHeaders } = await register(page);
  await seedTile(page, authHeaders, "2");

  // Mock a real lineup; leave the HLS playlist request pending so playback
  // neither succeeds nor turns fatal during the pop-out interaction.
  // Channel 1 carries a schedule window (guide-grid blocks); channel 2 has
  // none, exercising the "no guide data" placeholder row.
  const now = Date.now();
  const iso = (min: number) => new Date(now + min * 60_000).toISOString();
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
              { title: "The Big Sleep", start: iso(120), stop: iso(180) },
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
    /* never fulfilled — keeps hls.js in its loading state */
  });

  await openDashboard(page, token);

  // The tuned channel (2) drives the title line: "num · name — now playing".
  await expect(page.getByText("2 · Cartoons — Looney Tunes")).toBeVisible();
  await expect(page.getByTestId("videoplayer-demo-badge")).toHaveCount(0);

  // Hover reveals controls; the TV button opens the channel pop-out.
  const video = page.getByTestId("videoplayer-video");
  await video.hover();
  const toggle = page.getByTestId("videoplayer-channels-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
  const popout = page.getByTestId("videoplayer-channels");
  await expect(popout).toBeVisible();

  const entries = page.getByTestId("videoplayer-channel-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(1)).toHaveAttribute("data-current", "true");

  // DirecTV-style guide grid: time-slot header + programme blocks laid out
  // on the timeline, a now-line, and a highlighted currently airing block.
  await expect(page.getByTestId("videoplayer-guide-grid")).toBeVisible();
  await expect(page.getByTestId("videoplayer-guide-nowline")).toBeAttached();
  const programs = page.getByTestId("videoplayer-guide-program");
  await expect(programs).toHaveCount(3);
  const airing = page.locator('[data-testid="videoplayer-guide-program"][data-airing="true"]');
  await expect(airing).toHaveCount(1);
  await expect(airing).toContainText("The Maltese Falcon");
  // The later programme block is wider than the shorter one (proportional
  // durations: Casablanca 90m vs Big Sleep 60m).
  const widths = await programs.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().width),
  );
  expect(widths[1]!).toBeGreaterThan(widths[2]!);
  // The channel without guide data shows a placeholder block.
  await expect(page.getByTestId("videoplayer-guide-placeholder")).toBeVisible();

  // Tune to channel 1 and confirm the change is persisted server-side.
  await entries.nth(0).click();
  await expect(popout).toHaveCount(0);
  await expect(page.getByText("1 · Movies — The Maltese Falcon")).toBeVisible({
    timeout: 10000,
  });
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/tiles", { headers: authHeaders });
      const tiles = (await res.json()) as {
        tileSettings?: { videoErsatzChannel?: string | null };
      }[];
      return tiles[0]?.tileSettings?.videoErsatzChannel ?? null;
    })
    .toBe("1");
});
