import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// AI Chat tile: real browser flow in demo (unconfigured) mode.
//
// No routes are mocked — the freshly registered user has no AI accounts, so
// the tile shows a canned sample conversation and POST /api/widgets/ai/chat
// answers with a sample reply. This exercises the tile render, the locked-mode
// input, the real chat endpoint, per-tile localStorage history, and the clear
// action end to end.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("AI Chat tile chats in demo mode and persists + clears history", async ({
  page,
}) => {
  const username = `aichat_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };

  const res = await page.request.post("/api/tiles", {
    data: {
      name: "Assistant",
      gridX: 0,
      gridY: 0,
      gridW: 8,
      gridH: 8,
      integration: "aichat",
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  const tileId = ((await res.json()) as { id: number }).id;

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  const tile = page.locator(".react-grid-item", { hasText: "Assistant" });
  await expect(tile).toBeVisible();

  // Unconfigured tile: Sample badge + canned demo conversation.
  await expect(tile.getByText("Sample", { exact: true })).toBeVisible();
  await expect(tile.getByText("What can you do?")).toBeVisible();

  // Send a message in locked mode; the server answers with a demo reply.
  const input = tile.getByRole("textbox", { name: "Chat message" });
  await input.fill("Hello from the e2e test");
  await tile.getByRole("button", { name: "Send message" }).click();

  await expect(tile.getByText("Hello from the e2e test")).toBeVisible();
  await expect(tile.getByText(/demo reply/i)).toBeVisible();

  // History persists per tile under the legacy localStorage prefix.
  const stored = await page.evaluate(
    (id) => window.localStorage.getItem(`homehub:aichat:${id}`),
    tileId,
  );
  expect(stored).toBeTruthy();
  const parsed = JSON.parse(stored!) as Array<{ role: string; content: string }>;
  expect(parsed.some((m) => m.content === "Hello from the e2e test")).toBe(true);

  // Reload: the conversation comes back from localStorage.
  await page.reload();
  await page.locator(".react-grid-layout").waitFor();
  await expect(tile.getByText("Hello from the e2e test")).toBeVisible();

  // Clear conversation wipes the visible chat and the stored history.
  await tile.getByRole("button", { name: "Clear conversation" }).click();
  await expect(tile.getByText("Hello from the e2e test")).not.toBeVisible();
  const cleared = await page.evaluate(
    (id) => window.localStorage.getItem(`homehub:aichat:${id}`),
    tileId,
  );
  expect(cleared).toBe("[]");
});
