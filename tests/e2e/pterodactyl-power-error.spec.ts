import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Pterodactyl tile: power action failure path.
//
// The demo spec covers the happy no-op toast; this one covers a configured
// panel rejecting the action. The /api/widgets/pterodactyl/power route is
// mocked to return 502 (what the API server sends when the real panel
// rejects a power signal), and the tile must surface the destructive
// "Could not start server" toast and clear the row's pending spinner so the
// power buttons come back.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("a 502 from the power route shows the error toast and restores the buttons", async ({
  page,
}) => {
  const username = `pteroerr_${rand()}`;
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

  // Simulate a configured panel rejecting the action: the browser's power
  // request fails with the API server's configured-failure shape (502).
  await page.route("**/api/widgets/pterodactyl/power", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Pterodactyl rejected the power action" }),
    }),
  );

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  // Sample data still serves the widget itself; "Ark Survival" is offline so
  // it exposes a one-click Start button.
  const tile = page.locator(".react-grid-item", { hasText: "Ark Survival" });
  await expect(tile).toBeVisible();

  const startButton = tile.getByRole("button", { name: "Start Ark Survival" });
  await startButton.click();

  // The mutation's onError fires the destructive toast with the upstream
  // reason in the description.
  await expect(
    page.getByText("Could not start server", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/Pterodactyl rejected the power action/).first(),
  ).toBeVisible();

  // The row's pending spinner must be cleaned up — the Start button returns
  // instead of a stuck spinner. Other sample servers can legitimately be
  // transitioning, so scope the spinner check to Ark's row.
  await expect(startButton).toBeVisible();
  const arkRow = tile
    .locator("div.rounded-md")
    .filter({ hasText: "Ark Survival" });
  await expect(arkRow.locator(".animate-spin")).toHaveCount(0);
});
