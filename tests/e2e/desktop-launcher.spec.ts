import { test, expect } from "./fixtures";

// Isolated API/Vite fixture only. The companion below is an HTTP test client;
// it never starts a process, opens an application, or touches real devices.
test("desktop launcher pairing, binding, one-shot approval, recovery and revoke", async ({
  page,
}) => {
  const password = "Disposable-owner-password-123!";
  const registration = await page.request.post("/api/auth/register", {
    data: { username: "launcher_owner", password },
  });
  expect(registration.status()).toBe(201);
  const { token: ownerToken } = await registration.json();
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` };
  await page.addInitScript((token) => localStorage.setItem("token", token), ownerToken);

  // Pairing code and instance are issued by the settings UI. This is the
  // explicit local-approval endpoint, not a physical companion interaction.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings");
  const desktopSectionAgain = page.getByRole("button", { name: "Desktop", exact: true });
  if ((await desktopSectionAgain.getAttribute("aria-expanded")) !== "true") await desktopSectionAgain.click();
  await expect(page.getByTestId("card-desktop-launcher")).toBeVisible();
  await page.getByTestId("button-pair-launcher").click();
  await expect(page.getByTestId("panel-launcher-pairing")).toBeVisible();
  const code = (await page.getByTestId("text-pairing-code").innerText()).trim();
  const instanceId = (await page.getByTestId("text-launcher-instance").innerText()).trim();
  await expect(page.getByTestId("panel-launcher-pairing")).toContainText("Pairing for launcher_owner");
  expect(code).toBeTruthy();
  expect(instanceId).toBeTruthy();
  await page.screenshot({ path: "test-results/desktop-launcher-settings.png", fullPage: true });

  const actions = [{ id: "editor", name: "Test editor" }];
  const approval = await page.request.post("/api/launcher/pairings/approve", {
    data: { code, instanceId, approved: true, name: "Test desktop", actions },
  });
  expect(approval.status()).toBe(200);
  const { deviceId, token: deviceToken } = await approval.json();
  const companionHeaders = {
    Authorization: `Bearer ${deviceToken}`,
    "X-Launcher-Instance": instanceId,
  };
  const hello = await page.request.post("/api/launcher/companion/hello", {
    headers: companionHeaders, data: { actions },
  });
  expect(hello.status()).toBe(200);
  let { session } = await hello.json();
  const companionPoll = (approvedActions: typeof actions) =>
    page.request.post("/api/launcher/companion/poll", {
      headers: companionHeaders, data: { session, actions: approvedActions },
    });

  const row = page.getByTestId(`row-launcher-device-${deviceId}`);
  await expect(row).toContainText("Test desktop");
  await expect(page.getByTestId(`status-launcher-device-${deviceId}`)).toHaveText("Online");
  await page.getByTestId(`button-rename-launcher-device-${deviceId}`).click();
  await page.getByTestId(`input-launcher-device-name-${deviceId}`).fill("Renamed desktop");
  await page.getByTestId(`button-save-launcher-device-${deviceId}`).click();
  await expect(page.getByTestId(`text-launcher-device-name-${deviceId}`)).toHaveText("Renamed desktop");

  // Create and bind the tile through the dashboard's integration picker.
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await page.getByRole("button", { name: "Add tile", exact: true }).click();
  await page.getByRole("button", { name: /Browse/ }).click();
  await page.getByRole("button", { name: /Desktop Launcher/ }).click();
  const deviceSelect = page.getByTestId("select-launcher-device");
  await deviceSelect.click();
  await page.getByRole("option", { name: /Renamed desktop/ }).click();
  const actionSelect = page.getByTestId("select-launcher-action");
  await actionSelect.click();
  await page.getByRole("option", { name: "Test editor", exact: true }).click();
  await page.getByRole("button", { name: "Add tile", exact: true }).last().click();
  await page.getByRole("button", { name: /^Done$/ }).click();
  const launchButton = page.locator('[data-testid^="button-launch-"]');
  await expect(launchButton).toBeVisible();
  const tileId = (await launchButton.getAttribute("data-testid"))!.replace("button-launch-", "");
  const tile = page.getByTestId(`tile-launcher-${tileId}`);
  await expect(tile).toContainText("Renamed desktop");
  await page.screenshot({ path: "test-results/desktop-launcher-tile.png", fullPage: true });

  // The test companion only accepts the exact pending command. Assert one
  // successful accept; a second accept for the same ID must be rejected.
  await launchButton.click();
  const pendingText = page.getByTestId(`status-launcher-${tileId}`);
  await expect(pendingText).toContainText("Waiting for companion");
  let commands: Array<{ id: string; actionId: string }> = [];
  for (let attempt = 0; attempt < 5 && commands.length === 0; attempt++) {
    const poll = await companionPoll(actions);
    expect(poll.status()).toBe(200);
    commands = (await poll.json()).commands;
    if (commands.length === 0) await page.waitForTimeout(1000);
  }
  expect(commands).toHaveLength(1);
  const accepted = await page.request.post("/api/launcher/companion/accept", {
    headers: companionHeaders, data: { session, id: commands[0].id },
  });
  expect(accepted.status()).toBe(200);
  const duplicateAccept = await page.request.post("/api/launcher/companion/accept", {
    headers: companionHeaders, data: { session, id: commands[0].id },
  });
  expect(duplicateAccept.status()).toBe(409);
  await expect(pendingText).toContainText("Accepted by companion", { timeout: 5000 });

  await companionPoll([]);
  await expect(tile).toContainText("Action missing", { timeout: 7000 });
  await companionPoll(actions);
  await expect(tile).toContainText("on Renamed desktop", { timeout: 7000 });

  // Let the 8s server lease expire; the UI refreshes device status every 3s.
  await page.waitForTimeout(9500);
  await expect(tile).toContainText("Device offline", { timeout: 7000 });
  const reconnect = await page.request.post("/api/launcher/companion/hello", {
    headers: companionHeaders, data: { actions },
  });
  expect(reconnect.status()).toBe(200);
  session = (await reconnect.json()).session;
  const noStaleCommand = await companionPoll(actions);
  expect((await noStaleCommand.json()).commands).toHaveLength(0);

  await page.goto("/settings");
  const desktopSection = page.getByRole("button", { name: "Desktop", exact: true });
  if ((await desktopSection.getAttribute("aria-expanded")) !== "true") await desktopSection.click();
  await page.getByTestId(`button-revoke-launcher-device-${deviceId}`).click();
  await expect(page.getByRole("dialog")).toContainText("Revoke Renamed desktop?");
  await page.getByTestId(`button-confirm-revoke-${deviceId}`).click();
  await expect(page.getByTestId(`status-launcher-device-${deviceId}`)).toHaveText("Revoked");
  const revokedHello = await page.request.post("/api/launcher/companion/hello", {
    headers: companionHeaders, data: { actions },
  });
  expect(revokedHello.status()).toBe(401);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const revokedTile = page.getByTestId(`tile-launcher-${tileId}`);
  await expect(revokedTile).toContainText("Device revoked", { timeout: 7000 });

  // Profile exports never carry a companion secret; importing even the same
  // profile intentionally strips the authority-bearing tile binding.
  const exported = await page.request.get("/api/profile/export", { headers: ownerHeaders });
  expect(exported.status()).toBe(200);
  const profile = await exported.json();
  expect(JSON.stringify(profile)).not.toContain(deviceToken);
  const scoped = profile.pages.flatMap((p: any) =>
    p.layouts.flatMap((layout: any) => layout.tiles.map((t: any) => ({ layout, tile: t }))),
  ).find(({ tile }: any) => tile.integration === "desktoplauncher");
  expect(scoped).toBeTruthy();
  expect(scoped.layout.deviceMode).toBe("Default");
  expect(scoped.tile.tileSettings).toMatchObject({
    launcherInstanceId: instanceId,
    launcherDeviceId: deviceId,
    launcherActionId: "editor",
  });
  const imported = await page.request.post("/api/profile/import", {
    headers: ownerHeaders, data: { ...profile, mode: "replace" },
  });
  expect(imported.ok()).toBeTruthy();
  const reexported = await page.request.get("/api/profile/export", { headers: ownerHeaders });
  const importedExport = JSON.stringify(await reexported.json());
  expect(importedExport).not.toContain("launcherDeviceId");
  expect(importedExport).not.toContain(deviceToken);
  await page.reload();
  const importedTile = page.locator('[data-testid^="tile-launcher-"]');
  await expect(importedTile).toBeVisible();
  await expect(importedTile).toContainText("Not bound");
});

test("launcher editor resets binding draft for each open, create, and imported unbound tile", async ({
  page,
}) => {
  const registration = await page.request.post("/api/auth/register", {
    data: { username: "launcher_editor_owner", password: "Disposable-owner-password-123!" },
  });
  expect(registration.status()).toBe(201);
  const { token } = await registration.json();
  const auth = { Authorization: `Bearer ${token}` };
  await page.addInitScript((t) => localStorage.setItem("token", t), token);

  // Seed two disposable device catalogs with different actions. The editor
  // only needs the approved catalog; no companion polling/native launch occurs.
  const createDevice = async (name: string, actions: Array<{ id: string; name: string }>) => {
    const pairingResponse = await page.request.post("/api/launcher/pairings", {
      headers: auth, data: {},
    });
    expect(pairingResponse.status()).toBe(200);
    const pairing = await pairingResponse.json();
    const approved = await page.request.post("/api/launcher/pairings/approve", {
      data: {
        code: pairing.code, instanceId: pairing.instanceId,
        approved: true, name, actions,
      },
    });
    expect(approved.status()).toBe(200);
    return { ...(await approved.json()), instanceId: pairing.instanceId };
  };
  const deviceA = await createDevice("Workstation A", [
    { id: "editor_a", name: "Editor A" },
    { id: "viewer_a", name: "Viewer A" },
  ]);
  const deviceB = await createDevice("Workstation B", [
    { id: "editor_b", name: "Editor B" },
  ]);

  const createBoundTile = async (
    name: string, x: number, device: typeof deviceA, actionId: string,
  ) => {
    const response = await page.request.post("/api/tiles", {
      headers: auth,
      data: {
        type: "app", integration: "desktoplauncher", name,
        gridX: x, gridY: 0, gridW: 4, gridH: 4,
        tileSettings: {
          launcherInstanceId: device.instanceId,
          launcherDeviceId: device.deviceId,
          launcherActionId: actionId,
        },
      },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const tileA = await createBoundTile("Bound A", 0, deviceA, "editor_a");
  const tileB = await createBoundTile("Bound B", 4, deviceB, "editor_b");
  const expectedA = {
    launcherInstanceId: deviceA.instanceId,
    launcherDeviceId: deviceA.deviceId,
    launcherActionId: "editor_a",
  };
  const expectedB = {
    launcherInstanceId: deviceB.instanceId,
    launcherDeviceId: deviceB.deviceId,
    launcherActionId: "editor_b",
  };
  const getTile = async (id: number) => {
    const response = await page.request.get(`/api/tiles/${id}`, { headers: auth });
    expect(response.status()).toBe(200);
    return response.json();
  };

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.reload();
  await page.getByRole("button", { name: /^Edit$/ }).click();
  const openTileEditor = async (id: number) => {
    const tile = page.getByTestId(`tile-launcher-${id}`);
    const gridItem = tile.locator('xpath=ancestor::div[contains(@class,"react-grid-item")]');
    await gridItem.getByRole("button", { name: "Edit tile" }).click();
    return page.getByRole("dialog");
  };
  const expectBinding = async (deviceName: string, actionName: string) => {
    await expect(page.getByTestId("select-launcher-device")).toContainText(deviceName);
    await expect(page.getByTestId("select-launcher-action")).toContainText(actionName);
  };
  const chooseBinding = async (deviceName: string, actionName: string) => {
    await page.getByTestId("select-launcher-device").click();
    await page.getByRole("option", { name: new RegExp(deviceName) }).click();
    await page.getByTestId("select-launcher-action").click();
    await page.getByRole("option", { name: actionName, exact: true }).click();
  };

  // Reopening after a page reload and changing only the title must preserve
  // the full stored authority-bearing tuple.
  let dialog = await openTileEditor(tileA.id);
  await expectBinding("Workstation A", "Editor A");
  await dialog.getByPlaceholder("My App").fill("Bound A renamed");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await getTile(tileA.id)).tileSettings).toMatchObject(expectedA);
  expect(await getTile(tileA.id)).toMatchObject({ name: "Bound A renamed" });

  // Switching between editor sessions restores the other tile's device/action,
  // then restores A again rather than leaking the previous tile's selection.
  dialog = await openTileEditor(tileB.id);
  await expectBinding("Workstation B", "Editor B");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  dialog = await openTileEditor(tileA.id);
  await expectBinding("Workstation A", "Editor A");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Draft a different binding on A and cancel. A later create session must
  // initialize to unbound rather than inheriting that uncommitted selection.
  dialog = await openTileEditor(tileA.id);
  await chooseBinding("Workstation B", "Editor B");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await getTile(tileA.id)).tileSettings).toMatchObject(expectedA);

  await page.getByRole("button", { name: "Add tile", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("My App").fill("Fresh unbound");
  await dialog.getByRole("button", { name: /Browse/ }).click();
  await page.getByRole("button", { name: /Desktop Launcher/ }).click();
  await expect(page.getByTestId("text-launcher-no-devices")).toHaveCount(0);
  await expect(page.getByTestId("select-launcher-device")).toBeVisible();
  await expect(page.getByTestId("select-launcher-device")).toContainText("Choose a computer");
  await dialog.getByRole("button", { name: "Add tile", exact: true }).click();
  let tiles = await (await page.request.get("/api/tiles", { headers: auth })).json();
  const fresh = tiles.find((t: any) => t.name === "Fresh unbound");
  expect(fresh).toBeTruthy();
  expect(fresh.tileSettings?.launcherInstanceId ?? null).toBeNull();
  expect(fresh.tileSettings?.launcherDeviceId ?? null).toBeNull();
  expect(fresh.tileSettings?.launcherActionId ?? null).toBeNull();

  // Round-trip the unbound tile through profile import, then rename-only edit
  // it. Import and the next modal opening must not resurrect the cancelled draft.
  const exported = await page.request.get("/api/profile/export", { headers: auth });
  expect(exported.status()).toBe(200);
  const profile = await exported.json();
  const imported = await page.request.post("/api/profile/import", {
    headers: auth, data: { ...profile, mode: "replace" },
  });
  expect(imported.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: /^Edit$/ }).click();
  tiles = await (await page.request.get("/api/tiles", { headers: auth })).json();
  const importedFresh = tiles.find((t: any) => t.name === "Fresh unbound");
  expect(importedFresh).toBeTruthy();
  dialog = await openTileEditor(importedFresh.id);
  await expect(page.getByTestId("select-launcher-device")).toContainText("Choose a computer");
  await dialog.getByPlaceholder("My App").fill("Imported still unbound");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  const savedImported = await getTile(importedFresh.id);
  expect(savedImported.name).toBe("Imported still unbound");
  expect(savedImported.tileSettings?.launcherInstanceId ?? null).toBeNull();
  expect(savedImported.tileSettings?.launcherDeviceId ?? null).toBeNull();
  expect(savedImported.tileSettings?.launcherActionId ?? null).toBeNull();
});
