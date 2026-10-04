import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// AI Chat tile: Markdown rendering inside a real tile.
//
// Seeds saved history (localStorage `homehub:aichat:<tileId>`) with an
// assistant reply containing lists, inline code, a long fenced code block and
// a link, then asserts the reply renders as real elements (ul/ol/pre/code/a),
// not raw Markdown text, and that the chat bubble never overflows the tile
// horizontally (the code block scrolls internally instead).
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

const LONG_CODE = `docker run -d --name tachboard --restart unless-stopped -p 8080:8080 -v tachboard-data:/data ghcr.io/example/tachboard:latest --log-level debug`;

const MARKDOWN_REPLY = [
  "Here is what I found:",
  "",
  "- First bullet item",
  "- Second bullet with `inline code`",
  "",
  "1. Step one",
  "2. Step two",
  "",
  "```bash",
  LONG_CODE,
  "```",
  "",
  "More info at [the docs](https://example.com/docs).",
].join("\n");

test("AI Chat tile renders Markdown history as elements without bubble overflow", async ({
  page,
}) => {
  const username = `aimd_${rand()}`;
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
      gridH: 10,
      integration: "aichat",
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  const tileId = ((await res.json()) as { id: number }).id;

  // Auth + seeded Markdown history before first load.
  await page.addInitScript(
    ({ t, id, reply }) => {
      window.localStorage.setItem("token", t);
      window.localStorage.setItem(
        `homehub:aichat:${id}`,
        JSON.stringify([
          { role: "user", content: "How do I run it?" },
          { role: "assistant", content: reply },
        ]),
      );
    },
    { t: token, id: tileId, reply: MARKDOWN_REPLY },
  );

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();

  const tile = page.locator(".react-grid-item", { hasText: "Assistant" });
  await expect(tile).toBeVisible();
  await expect(tile.getByText("How do I run it?")).toBeVisible();

  const markdown = tile.locator(".chat-markdown");
  await expect(markdown).toBeVisible();

  // Structured elements exist — the reply is not raw Markdown text.
  await expect(markdown.locator("ul > li")).toHaveCount(2);
  await expect(markdown.locator("ol > li")).toHaveCount(2);
  await expect(markdown.locator("ul code", { hasText: "inline code" })).toBeVisible();
  await expect(markdown.locator("pre code")).toContainText("docker run -d");
  const link = markdown.locator("a", { hasText: "the docs" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://example.com/docs");
  await expect(link).toHaveAttribute("target", "_blank");

  // No raw Markdown markers leaked into the rendered text.
  const rendered = (await markdown.innerText()).replace(LONG_CODE, "");
  expect(rendered).not.toContain("- First bullet");
  expect(rendered).not.toContain("```");
  expect(rendered).not.toContain("`inline code`");
  expect(rendered).not.toContain("[the docs](");

  // Bubble stays within the tile: no horizontal overflow anywhere up the
  // chain. The long code line must scroll INSIDE the <pre>, not widen it.
  const overflow = await markdown.evaluate((el) => {
    const results: Array<{ tag: string; scroll: number; client: number }> = [];
    let node: HTMLElement | null = el;
    while (node && !node.classList.contains("react-grid-item")) {
      results.push({
        tag: `${node.tagName.toLowerCase()}.${node.className
          .toString()
          .slice(0, 40)}`,
        scroll: node.scrollWidth,
        client: node.clientWidth,
      });
      node = node.parentElement;
    }
    return results;
  });
  for (const box of overflow) {
    expect(
      box.scroll,
      `horizontal overflow on ${box.tag}: scrollWidth ${box.scroll} > clientWidth ${box.client}`,
    ).toBeLessThanOrEqual(box.client + 1);
  }

  const pre = markdown.locator("pre");
  const preScrolls = await pre.evaluate(
    (el) => el.scrollWidth > el.clientWidth,
  );
  expect(preScrolls, "long code line should scroll inside <pre>").toBe(true);
  await expect(pre).toHaveCSS("overflow-x", "auto");
});
