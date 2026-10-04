import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Pterodactyl tile: stop/restart confirmation when players are online.
//
// A stray click on Stop or Restart while players are connected kicks everyone
// instantly, so those actions ask first — an inline confirm replaces the row's
// buttons. Start, and stop/restart on empty servers, stay one-click.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

const MOCK_WIDGET = {
  servers: [
    {
      id: "busy1",
      name: "Busy SMP",
      state: "running",
      cpuPercent: 40,
      memUsedMb: 2048,
      memLimitMb: 8192,
      players: { current: 3, max: 20 },
    },
    {
      id: "empty1",
      name: "Empty Server",
      state: "running",
      cpuPercent: 5,
      memUsedMb: 512,
      memLimitMb: 4096,
      players: { current: 0, max: 10 },
    },
  ],
};

test("stop on a populated server asks first; empty servers stay one-click", async ({
  page,
}) => {
  const username = `pterotest_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };

  const res = await page.request.post("/api/tiles", {
    data: {
      name: "Game Servers",
      gridX: 0,
      gridY: 0,
      gridW: 8,
      gridH: 8,
      integration: "pterodactyl",
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.route("**/api/widgets/pterodactyl", (route) =>
    route.fulfill({ json: MOCK_WIDGET }),
  );
  const powerCalls: Array<{ serverId: string; signal: string }> = [];
  await page.route("**/api/widgets/pterodactyl/power", async (route) => {
    powerCalls.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  const tile = page.locator(".react-grid-item", { hasText: "Busy SMP" });
  await expect(tile).toBeVisible();

  // --- Populated server: Stop asks first ------------------------------------
  await tile.getByRole("button", { name: "Stop Busy SMP" }).click();
  // Nothing sent yet; the inline confirm is showing instead.
  expect(powerCalls).toHaveLength(0);
  await expect(tile.getByText("Stop? 3 online")).toBeVisible();

  // Cancel restores the normal buttons without sending anything.
  await tile.getByRole("button", { name: "Cancel stop Busy SMP" }).click();
  await expect(tile.getByText("Stop? 3 online")).toHaveCount(0);
  await expect(tile.getByRole("button", { name: "Stop Busy SMP" })).toBeVisible();
  expect(powerCalls).toHaveLength(0);

  // --- Restart asks too, and confirming sends the signal --------------------
  await tile.getByRole("button", { name: "Restart Busy SMP" }).click();
  await expect(tile.getByText("Restart? 3 online")).toBeVisible();
  await tile.getByRole("button", { name: "Confirm restart Busy SMP" }).click();
  await expect.poll(() => powerCalls.length).toBe(1);
  expect(powerCalls[0]).toEqual({ serverId: "busy1", signal: "restart" });

  // --- Empty server: Stop stays one-click -----------------------------------
  await tile.getByRole("button", { name: "Stop Empty Server" }).click();
  await expect.poll(() => powerCalls.length).toBe(2);
  expect(powerCalls[1]).toEqual({ serverId: "empty1", signal: "stop" });
});
