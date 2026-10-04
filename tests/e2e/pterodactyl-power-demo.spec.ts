import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Pterodactyl tile: power buttons in the real browser flow (demo mode).
//
// No routes are mocked here — the freshly registered user has no Pterodactyl
// connection, so the widget endpoint serves the built-in sample servers and
// the power endpoint acknowledges actions as a demo no-op ({ok, demo:true}).
// Clicking Start on the sample offline server must surface the "Demo mode"
// toast, which exercises the real route path, auth, and toast wiring end to
// end.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("Start on the sample offline server shows the Demo mode toast", async ({
  page,
}) => {
  const username = `pterodemo_${rand()}`;
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

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  // The unconfigured widget serves sample data including "Ark Survival",
  // which is offline and therefore shows a one-click Start button.
  const tile = page.locator(".react-grid-item", { hasText: "Ark Survival" });
  await expect(tile).toBeVisible();

  await tile.getByRole("button", { name: "Start Ark Survival" }).click();

  // The real power endpoint replies {ok, demo:true} and the tile surfaces it
  // as a toast instead of pretending the server is starting.
  await expect(page.getByText("Demo mode", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Connect Pterodactyl in Settings to control real servers.", {
      exact: true,
    }),
  ).toBeVisible();

  // Demo no-op: the row must NOT get stuck in a pending/transitioning state —
  // the Start button comes right back.
  await expect(
    tile.getByRole("button", { name: "Start Ark Survival" }),
  ).toBeVisible();
});
