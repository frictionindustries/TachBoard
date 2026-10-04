import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Email tile detail pop-out + archive action.
//
// Every message row opens an in-app detail dialog. The dialog carries an
// Archive button for real messages, but demo/sample data must HIDE it (there
// is nothing to archive) and show only the message details.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("email rows open the detail pop-out; demo data hides the Archive action", async ({
  page,
}) => {
  const username = `emailtest_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Seed an email tile (renders demo messages when no mail account exists).
  const res = await page.request.post("/api/tiles", {
    data: {
      name: "Mail",
      type: "integration",
      integration: "email",
      gridX: 0,
      gridY: 0,
      gridW: 6,
      gridH: 6,
    },
    headers: authHeaders,
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  // Demo inbox renders; click the first known demo message row.
  const row = page.getByRole("button", { name: /Build #142 passed/ });
  await row.waitFor();
  await row.click();

  // The pop-out shows the message details…
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("[homelab] Build #142 passed")).toBeVisible();
  await expect(dialog.getByText(/From: GitHub/)).toBeVisible();
  await expect(dialog.getByText(/All checks have passed/)).toBeVisible();

  // …but demo data must not offer Archive (nothing real to archive) nor an
  // external open link (demo messages have no link).
  await expect(dialog.getByRole("button", { name: /Archive/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Open in Gmail|Open webmail/ })).toHaveCount(0);

  // Closes cleanly.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  // The archive endpoint itself refuses demo ids with a clear error.
  const archive = await page.request.post("/api/widgets/email/archive", {
    data: { id: "demo:0" },
    headers: authHeaders,
  });
  expect(archive.status()).toBe(400);
  const body = (await archive.json()) as { error: string };
  expect(body.error).toMatch(/demo/i);
});
