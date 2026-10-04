import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Coverage for device modes (task #402).
//
// A device mode is a switchable layout profile (e.g. PC vs Phone) with an
// independent tile set on every page. The active mode is remembered per
// browser via localStorage. Guards:
//   1. The default mode's tiles render; the mode switcher shows the mode name.
//   2. Creating a new mode via the UI switches to it and shows an EMPTY page
//      (independent tile set) with a "Copy layout from…" option.
//   3. Copying the layout from the original mode clones the tile.
//   4. Switching back to the original mode still shows its own tile, and the
//      chosen mode survives a reload (localStorage).
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("device modes hold independent tile sets, support copy-from, and persist per browser", async ({
  page,
}) => {
  const username = `modetest_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Seed one tile in the default device mode.
  const res = await page.request.post("/api/tiles", {
    data: { name: "PC Tile", gridX: 0, gridY: 0, gridW: 4, gridH: 4 },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".react-grid-item")).toHaveCount(1);

  // The mode switcher shows the default mode.
  const modeTrigger = page.getByTestId("device-mode-trigger");
  await expect(modeTrigger).toBeVisible();

  // --- Create a second device mode (edit mode exposes management items) -----
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await modeTrigger.click();
  await page.getByRole("menuitem", { name: /New mode/ }).click();
  await page.getByTestId("mode-name-input").fill("Phone");
  await page.getByRole("button", { name: /Create mode/ }).click();

  // The app switches to the new mode: independent (empty) tile set.
  await expect(modeTrigger).toContainText("Phone");
  await expect(page.locator(".react-grid-item")).toHaveCount(0);

  // --- Copy the layout from the original mode --------------------------------
  const copyTrigger = page.getByTestId("copy-layout-trigger");
  await expect(copyTrigger).toBeVisible();
  await copyTrigger.click();
  await page.getByRole("menuitem", { name: /1 tile$/ }).first().click();
  await expect(page.locator(".react-grid-item")).toHaveCount(1);

  // --- Re-copy into the now-populated layout (replace with confirmation) -----
  // The copy action stays available in edit mode even though this layout has
  // tiles; picking a source now asks for confirmation before replacing.
  const headerCopyTrigger = page.getByTestId("copy-layout-trigger");
  await expect(headerCopyTrigger).toBeVisible();
  await headerCopyTrigger.click();
  await page.getByRole("menuitem", { name: /1 tile$/ }).first().click();
  const replaceDialog = page.getByTestId("copy-replace-dialog");
  await expect(replaceDialog).toBeVisible();
  await page.getByTestId("copy-replace-confirm").click();
  await expect(replaceDialog).not.toBeVisible();
  await expect(page.locator(".react-grid-item")).toHaveCount(1);

  // --- Switch back to the original mode: its own tile is untouched -----------
  await modeTrigger.click();
  await page.getByRole("menuitemradio").first().click();
  await expect(page.locator(".react-grid-item")).toHaveCount(1);
  await expect(page.getByText("PC Tile")).toBeVisible();

  // --- Back to Phone; the chosen mode survives a reload (localStorage) -------
  await modeTrigger.click();
  await page.getByRole("menuitemradio", { name: "Phone" }).click();
  await expect(modeTrigger).toContainText("Phone");

  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.getByTestId("device-mode-trigger")).toContainText("Phone");
  await expect(page.locator(".react-grid-item")).toHaveCount(1);
});
