import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Optional tile expanded panels (task #527).
//
// The expanded panel promotes the tile's ALWAYS-MOUNTED host element into the
// browser top layer (popover="manual"). These checks guard what jsdom cannot:
//   - the very same DOM nodes (incl. <video>) survive open/close (no remount,
//     no second copy), and local drafts / timers keep running;
//   - nested Radix dialogs portal into the panel and stack above it, and
//     Escape closes nested-first;
//   - focus moves into the panel and is restored;
//   - edit mode / page switches dismiss; fixed-scale and mobile layouts work.
// ---------------------------------------------------------------------------

const PLAYBACK_FIXTURE =
  "data:video/mp4;base64," +
  readFileSync(join(__dirname, "assets", "tiny-seekable.mp4")).toString("base64");

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function setup(page: Page) {
  const username = `expand_${rand()}`;
  const password = `Pw_${rand()}!`;
  const reg = await page.request.post("/api/auth/register", { data: { username, password } });
  expect(reg.ok()).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  await page.addInitScript((t) => window.localStorage.setItem("token", t as string), token);
  return { Authorization: `Bearer ${token}` };
}

async function createTile(
  request: APIRequestContext,
  headers: Record<string, string>,
  data: Record<string, unknown>,
): Promise<number> {
  const res = await request.post("/api/tiles", { data, headers });
  expect(res.ok(), `create tile failed: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { id: number }).id;
}

const expanded = (page: Page, id: number) =>
  page.locator(`[data-testid="tile-host-${id}"][data-expanded="true"]`);
// The visible panel (the host is a full-viewport backdrop when expanded).
const frame = (page: Page, id: number) =>
  page.locator(`[data-testid="tile-host-${id}"][data-expanded="true"] > .tile-expand-frame`);

// Count browser notifications (the timer's alert channel) deterministically.
async function stubNotifications(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __notifications: string[] };
    w.__notifications = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission() {
        return Promise.resolve("granted");
      }
      constructor(title: string) {
        w.__notifications.push(title);
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  });
}

test("default-off tiles never expand; enabled app tile expands without navigating", async ({ page }) => {
  const h = await setup(page);
  const off = await createTile(page.request, h, { name: "Plain", url: "https://example.com", gridX: 0, gridY: 0, gridW: 3, gridH: 3 });
  const on = await createTile(page.request, h, {
    name: "Expandable", url: "https://example.com", gridX: 4, gridY: 0, gridW: 3, gridH: 3,
    tileSettings: { openExpanded: true },
  });
  const spacer = await createTile(page.request, h, {
    name: "Full row spacer", integration: "spacer", gridX: 0, gridY: 4, gridW: 12, gridH: 1,
    tileSettings: { openExpanded: true },
  });
  const divider = await createTile(page.request, h, {
    name: "Full row divider", integration: "divider", gridX: 0, gridY: 5, gridW: 12, gridH: 1,
    tileSettings: { openExpanded: true },
  });
  const metricsOff = await createTile(page.request, h, {
    name: "Metrics default off", integration: "truenas", gridX: 0, gridY: 6, gridW: 3, gridH: 3,
  });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByTestId(`button-expand-tile-${off}`)).toHaveCount(0);
  await expect(page.getByTestId(`button-expand-tile-${spacer}`)).toHaveCount(0);
  await expect(page.getByTestId(`button-expand-tile-${divider}`)).toHaveCount(0);
  await expect(page.getByTestId(`button-expand-tile-${metricsOff}`)).toHaveCount(0);

  const popupPromise = page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
  await page.getByTestId(`tile-host-${on}`).click();
  await expect(expanded(page, on)).toBeVisible();
  await page.screenshot({ path: "test-results/expanded-panels-signed-in.png", fullPage: true });
  expect(await popupPromise).toBeNull();
  // Top layer, not a z-index overlay.
  expect(await page.getByTestId(`tile-host-${on}`).evaluate((el) => el.matches(":popover-open"))).toBe(true);
  // Focus moved into the panel, explicit link remains.
  await expect(page.getByTestId(`button-panel-close-${on}`)).toBeFocused();
  await expect(page.getByTestId(`button-panel-open-link-${on}`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(expanded(page, on)).toHaveCount(0);

  // Keyboard path via the explicit trigger restores focus to it.
  const trigger = page.getByTestId(`button-expand-tile-${on}`);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(expanded(page, on)).toBeVisible();
  await page.getByTestId(`button-panel-close-${on}`).click();
  await expect(trigger).toBeFocused();

  // Background is actually inert while open (not just aria-modal).
  await trigger.click();
  await expect(expanded(page, on)).toBeVisible();
  expect(
    await page.evaluate(() => !!document.querySelector('[data-testid="device-mode-trigger"]')?.closest("[inert]")),
  ).toBe(true);
  expect(await page.getByTestId(`tile-host-${off}`).evaluate((el) => el.closest("[inert]") !== null)).toBe(true);
  expect(await page.getByTestId(`tile-host-${on}`).evaluate((el) => el.closest("[inert]") === null)).toBe(true);
  // Tab cycles within the panel only.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate((id) => !!document.querySelector(`[data-testid="tile-host-${id}"]`)?.contains(document.activeElement), on)).toBe(true);
  }
  // Backdrop click (outside the frame, lands on the full-viewport host).
  const fb = (await frame(page, on).boundingBox())!;
  expect(fb.y).toBeGreaterThan(4);
  await page.mouse.click(fb.x + fb.width / 2, 3);
  await expect(expanded(page, on)).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
});

test("same media element, note draft and running timer survive expand/collapse", async ({ page }) => {
  const h = await setup(page);
  const video = await createTile(page.request, h, {
    name: "Video", integration: "videoplayer", gridX: 0, gridY: 0, gridW: 4, gridH: 4,
    tileSettings: {
      openExpanded: true, videoMuted: true, videoSource: "urls",
      videoUrls: [PLAYBACK_FIXTURE], videoPlayMode: "single",
    },
  });
  const note = await createTile(page.request, h, {
    name: "Note", integration: "note", gridX: 5, gridY: 0, gridW: 4, gridH: 4,
    tileSettings: { openExpanded: true },
  });
  const timer = await createTile(page.request, h, {
    name: "Timer", integration: "timer", gridX: 10, gridY: 0, gridW: 4, gridH: 4,
    tileSettings: { openExpanded: true, timerMode: "countup", timerRunning: true, timerStartedAt: Date.now() - 5000 },
  });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  // --- Media identity: tag the live <video> node, toggle, assert same node.
  const vHost = page.getByTestId(`tile-host-${video}`);
  const mediaSel = "video, iframe";
  await vHost.locator(mediaSel).first().waitFor({ timeout: 15000 });
  const videoNode = vHost.locator('[data-testid="videoplayer-video"]');
  await expect.poll(() => videoNode.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2), { timeout: 15000 }).toBe(true);
  await vHost.locator(mediaSel).first().evaluate((el) => ((el as unknown as { __tag: string }).__tag = "original"));
  const timeBefore = await videoNode.evaluate((el: HTMLVideoElement) => el.currentTime);
  await page.getByTestId(`button-expand-tile-${video}`).click();
  await expect(expanded(page, video)).toBeVisible();
  expect(await vHost.locator(mediaSel).count()).toBe(1);
  expect(await page.locator(mediaSel).evaluateAll((els) => els.filter((e) => (e as unknown as { __tag?: string }).__tag === "original").length)).toBe(1);
  await page.waitForTimeout(500);
  const playback = await videoNode.evaluate((el: HTMLVideoElement) => ({ time: el.currentTime, duration: el.duration, paused: el.paused }));
  expect(playback.paused).toBe(false);
  expect((playback.time - timeBefore + playback.duration) % playback.duration).toBeGreaterThan(0.15);
  const box = await frame(page, video).boundingBox();
  expect(box!.width).toBeGreaterThan(600); // actually larger than the 4-col tile
  await page.keyboard.press("Escape");
  expect(await vHost.locator(mediaSel).first().evaluate((el) => (el as unknown as { __tag?: string }).__tag)).toBe("original");

  // --- Note draft: type, expand, draft still there and same node.
  const nHost = page.getByTestId(`tile-host-${note}`);
  const editor = nHost.locator("textarea").first();
  await editor.click();
  await page.keyboard.type("draft survives");
  await editor.evaluate((el) => ((el as unknown as { __tag: string }).__tag = "n"));
  await page.getByTestId(`button-expand-tile-${note}`).click();
  await expect(expanded(page, note)).toBeVisible();
  await expect(nHost.locator("textarea").first()).toHaveValue(/draft survives/);
  expect(await nHost.locator("textarea").first().evaluate((el) => (el as unknown as { __tag?: string }).__tag)).toBe("n");
  await page.keyboard.press("Escape");
  await expect(nHost.locator("textarea").first()).toHaveValue(/draft survives/);

  // --- Chat composer draft and node survive (do not submit / call an AI API).
  const chat = await createTile(page.request, h, {
    name: "Chat", integration: "aichat", gridX: 15, gridY: 0, gridW: 4, gridH: 4,
    tileSettings: { openExpanded: true },
  });
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  const cHost = page.getByTestId(`tile-host-${chat}`);
  const composer = cHost.getByRole("textbox", { name: "Chat message" });
  await composer.fill("unsent chat draft");
  await composer.evaluate((el) => ((el as unknown as { __tag: string }).__tag = "chat"));
  await page.getByTestId(`button-expand-tile-${chat}`).click();
  await expect(expanded(page, chat)).toBeVisible();
  await expect(cHost.getByRole("textbox", { name: "Chat message" })).toHaveValue("unsent chat draft");
  expect(await composer.evaluate((el) => (el as unknown as { __tag?: string }).__tag)).toBe("chat");
  await page.keyboard.press("Escape");

  // --- Timer: exactly one live instance, keeps advancing through toggles.
  const tHost = page.getByTestId(`tile-host-${timer}`);
  const before = await tHost.innerText();
  await page.getByTestId(`button-expand-tile-${timer}`).click();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId(`tile-host-${timer}`)).toHaveCount(1);
  const during = await tHost.innerText();
  expect(during).not.toBe(before);
  await page.keyboard.press("Escape");
});

test("email nested dialog portals into the panel, stacks above it and closes first", async ({ page }) => {
  const h = await setup(page);
  // No mail account -> the tile renders the known demo messages.
  const id = await createTile(page.request, h, {
    name: "Mail", integration: "email", gridX: 0, gridY: 0, gridW: 3, gridH: 3,
    tileSettings: { openExpanded: true },
  });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  // Message rows keep their own action in compact mode (no expansion).
  await page.getByTestId(`button-expand-tile-${id}`).click();
  await expect(expanded(page, id)).toBeVisible();
  const host = page.getByTestId(`tile-host-${id}`);
  const row = host.getByRole("button", { name: /Build #142 passed/ });
  await row.click();
  const nested = page.getByRole("dialog", { name: /Build #142 passed/ });
  await expect(nested).toBeVisible();
  await expect(nested.getByText(/All checks have passed/)).toBeVisible();
  expect(await nested.evaluate((el, hid) => !!document.querySelector(`[data-testid="tile-host-${hid}"]`)?.contains(el), id)).toBe(true);
  // Topmost at its center point: the nested dialog, not the panel underneath.
  const nb = (await nested.boundingBox())!;
  expect(await page.evaluate(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit?.closest('[role="dialog"][data-state="open"]');
  }, [nb.x + nb.width / 2, nb.y + nb.height / 2])).toBe(true);
  await page.keyboard.press("Escape");
  await expect(nested).toHaveCount(0);
  await expect(expanded(page, id)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(expanded(page, id)).toHaveCount(0);
});

test("countdown expiring across expand/collapse fires exactly one alert", async ({ page }) => {
  await stubNotifications(page);
  const h = await setup(page);
  const id = await createTile(page.request, h, {
    name: "Tea", integration: "timer", gridX: 0, gridY: 0, gridW: 3, gridH: 3,
    tileSettings: {
      openExpanded: true, timerMode: "countdown", timerDuration: 4, timerAlertEnabled: true,
      timerRunning: true, timerStartedAt: Date.now(), timerAccumulatedMs: 0,
    },
  });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByTestId(`tile-host-${id}`)).toHaveCount(1);
  // Toggle repeatedly around the expiry moment.
  for (let i = 0; i < 4; i++) {
    await page.getByTestId(`button-expand-tile-${id}`).click();
    await expect(expanded(page, id)).toBeVisible();
    await page.waitForTimeout(700);
    await page.keyboard.press("Escape");
    await expect(expanded(page, id)).toHaveCount(0);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1500);
  const notes = await page.evaluate(() => (window as unknown as { __notifications: string[] }).__notifications);
  expect(notes).toHaveLength(1);
});

test("panel dismisses when its page, device mode, variant or tile goes away", async ({ page }) => {
  const h = await setup(page);
  // Two pages; land on the second so deleting it switches the active page.
  const pages0 = (await (await page.request.get("/api/pages", { headers: h })).json()) as { id: number }[];
  const second = await page.request.post("/api/pages", { data: { name: "Second" }, headers: h });
  expect(second.ok()).toBeTruthy();
  const p2 = ((await second.json()) as { id: number }).id;
  const tileOnP2 = await createTile(page.request, h, {
    name: "OnSecond", integration: "clock", pageId: p2, gridX: 0, gridY: 0, gridW: 3, gridH: 3,
    tileSettings: { openExpanded: true },
  });
  await page.addInitScript((pid) => window.localStorage.setItem("activePageId", String(pid)), p2);
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  // Page change (active page removed elsewhere -> app falls back to page 1).
  await page.getByTestId(`button-expand-tile-${tileOnP2}`).click();
  await expect(expanded(page, tileOnP2)).toBeVisible();
  // Switching the active page in the dashboard is the direct scope-dismissal
  // path; deletion is then separately verified against fresh server state.
  await page.getByRole("button", { name: "Home" }).click();
  await expect(expanded(page, tileOnP2)).toHaveCount(0);
  expect((await page.request.delete(`/api/pages/${p2}`, { headers: h })).ok()).toBeTruthy();
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByRole("button", { name: "Second" })).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);

  // Tile deleted elsewhere.
  const t = await createTile(page.request, h, {
    name: "Doomed", integration: "clock", pageId: pages0[0]!.id, gridX: 0, gridY: 0, gridW: 3, gridH: 3,
    tileSettings: { openExpanded: true },
  });
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  await page.getByTestId(`button-expand-tile-${t}`).click();
  await expect(expanded(page, t)).toBeVisible();
  expect((await page.request.delete(`/api/tiles/${t}`, { headers: h })).ok()).toBeTruthy();
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByTestId(`tile-host-${t}`)).toHaveCount(0);

  // Device mode change (active mode removed elsewhere -> falls back).
  const mres = await page.request.post("/api/device-modes", { data: { name: "Phone" }, headers: h });
  expect(mres.ok()).toBeTruthy();
  const mode = ((await mres.json()) as { id: number }).id;
  const tm = await createTile(page.request, h, {
    name: "InMode", integration: "clock", pageId: pages0[0]!.id, deviceModeId: mode,
    gridX: 0, gridY: 0, gridW: 3, gridH: 3, tileSettings: { openExpanded: true },
  });
  await page.evaluate((m) => window.localStorage.setItem("activeDeviceModeId", String(m)), mode);
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  await page.getByTestId(`button-expand-tile-${tm}`).click();
  await expect(expanded(page, tm)).toBeVisible();
  expect((await page.request.delete(`/api/device-modes/${mode}`, { headers: h })).ok()).toBeTruthy();
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByTestId(`tile-host-${tm}`)).toHaveCount(0);

  // Adaptive variant change: seed the exact active variant scope so this
  // coverage cannot silently skip due to creating a base-layout tile.
  const put = await page.request.put(`/api/pages/${pages0[0]!.id}`, { data: { layoutPreset: "adaptive" }, headers: h });
  expect(put.ok(), `PUT page failed: ${put.status()}`).toBeTruthy();
  expect(((await put.json()) as { layoutPreset?: string }).layoutPreset).toBe("adaptive");
  const tv = await createTile(page.request, h, {
    name: "Adaptive", integration: "clock", pageId: pages0[0]!.id, gridX: 0, gridY: 0, gridW: 3, gridH: 3,
    variant: "fhd-landscape",
    tileSettings: { openExpanded: true },
  });
  await page.evaluate(() => window.localStorage.removeItem("activeDeviceModeId"));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  const trig = page.getByTestId(`button-expand-tile-${tv}`);
  await expect(trig).toHaveCount(1);
  await trig.click();
  await expect(expanded(page, tv)).toBeVisible();
  await page.setViewportSize({ width: 700, height: 1100 });
  await expect(page.locator('[data-expanded="true"]')).toHaveCount(0);
});

test("edit mode dismisses and disables expansion; setting toggle persists", async ({ page }) => {
  const h = await setup(page);
  const id = await createTile(page.request, h, {
    name: "Clock", integration: "clock", gridX: 0, gridY: 0, gridW: 3, gridH: 3,
    tileSettings: { openExpanded: true },
  });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await page.getByTestId(`button-expand-tile-${id}`).click();
  await expect(expanded(page, id)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await expect(page.getByTestId(`button-expand-tile-${id}`)).toHaveCount(0);
  // Editor exposes the option, prechecked.
  await page.getByRole("button", { name: "Edit tile" }).first().click();
  await expect(page.getByTestId("checkbox-open-expanded")).toHaveAttribute("data-state", "checked");
  await page.getByTestId("checkbox-open-expanded").click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByTestId(`button-expand-tile-${id}`)).toHaveCount(0);
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await page.getByRole("button", { name: "Edit tile" }).first().click();
  await expect(page.getByTestId("checkbox-open-expanded")).toHaveAttribute("data-state", "unchecked");
  await page.getByTestId("checkbox-open-expanded").click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByTestId(`button-expand-tile-${id}`)).toHaveCount(1);
});

test("fixed-scale page and mobile viewport keep the panel viewport-bounded", async ({ page }) => {
  const h = await setup(page);
  const pages = (await (await page.request.get("/api/pages", { headers: h })).json()) as { id: number }[];
  const put = await page.request.put(`/api/pages/${pages[0]!.id}`, { data: { layoutPreset: "uhd", layoutOrientation: "landscape" }, headers: h });
  expect(put.ok(), `PUT page failed: ${put.status()}`).toBeTruthy();
  expect(((await put.json()) as { layoutPreset?: string }).layoutPreset).toBe("uhd");
  const id = await createTile(page.request, h, {
    name: "News", integration: "news", gridX: 0, gridY: 0, gridW: 3, gridH: 3,
    tileSettings: { openExpanded: true },
  });
  for (const vp of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    await page.goto("/");
    await page.locator(".react-grid-layout").waitFor();
    await page.getByTestId(`button-expand-tile-${id}`).click({ force: true });
    const host = frame(page, id);
    await expect(host).toBeVisible();
    const b = (await host.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 1);
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 1);
    // Content-sized rather than a near-full-screen empty frame; still unscaled.
    expect(b.width).toBeCloseTo(Math.min(640, vp.width - (vp.width <= 640 ? 16 : 32)), 0);
    await expect(page.getByTestId(`panel-header-${id}`).getByRole("heading", { name: "News" })).toHaveCount(1);
    await page.keyboard.press("Escape");
  }
});
