import { test, expect, type Page } from "./fixtures";

// ---------------------------------------------------------------------------
// AI Chat Markdown legibility across dashboard themes.
//
// Markdown chat styling leans on foreground/background-derived tokens
// (`bg-foreground/10` for code blocks, `bg-muted` for the assistant bubble)
// that resolve to very different colors per theme. This spec seeds an AI Chat
// tile with a Markdown reply, activates a dark theme (nebula) and a light
// theme (hearth) via the same persisted key the theme picker writes
// (localStorage "homehub:theme", applied as a data-theme attribute before
// paint), and asserts for each:
//   - the code block's composited background is visibly distinct from the
//     bubble background (i.e. code doesn't blend into plain text), and
//   - body text and code text keep sufficient WCAG contrast against the
//     surfaces they actually sit on.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

const MARKDOWN_REPLY = [
  "Here is the summary:",
  "",
  "Use `docker ps` to list containers.",
  "",
  "```bash",
  "docker compose up -d",
  "```",
  "",
  "> Remember to back up first.",
].join("\n");

type Rgb = [number, number, number];

// WCAG relative luminance + contrast ratio.
function luminance([r, g, b]: Rgb): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Euclidean RGB distance — used to prove two surfaces are visibly different.
function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

interface ThemeSample {
  dataTheme: string | null;
  bubbleBg: Rgb;
  preBg: Rgb;
  textColor: Rgb;
  codeColor: Rgb;
}

// Reads the *composited* colors straight from the live DOM: alpha backgrounds
// (bg-foreground/10, bg-muted with translucency, etc.) are blended over every
// opaque ancestor background so the numbers reflect what a user actually sees.
async function sampleColors(page: Page): Promise<ThemeSample> {
  return page.evaluate(() => {
    // Chrome serializes alpha colors in modern spaces (oklab(...)), so parse
    // ANY css color by painting it onto a 1x1 canvas and reading the pixel.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d canvas context");
    const parse = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      const alpha = a / 255;
      if (alpha === 0) return [0, 0, 0, 0];
      // getImageData is non-premultiplied in spec, but round-tripping through
      // fill can lose precision at low alpha; that's fine for our thresholds.
      return [r, g, b, alpha];
    };
    const over = (
      top: [number, number, number, number],
      bottom: [number, number, number],
    ): [number, number, number] => {
      const a = top[3];
      return [
        Math.round(top[0] * a + bottom[0] * (1 - a)),
        Math.round(top[1] * a + bottom[1] * (1 - a)),
        Math.round(top[2] * a + bottom[2] * (1 - a)),
      ];
    };
    // Effective opaque background behind (and including) `el`.
    const effectiveBg = (el: Element): [number, number, number] => {
      const stack: Array<[number, number, number, number]> = [];
      let node: Element | null = el;
      while (node) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg[3] > 0) {
          stack.push(bg);
          if (bg[3] >= 1) break;
        }
        node = node.parentElement;
      }
      let result: [number, number, number] = [255, 255, 255];
      for (let i = stack.length - 1; i >= 0; i--) result = over(stack[i], result);
      return result;
    };

    const markdown = document.querySelector(".chat-markdown");
    if (!markdown) throw new Error("no .chat-markdown found");
    const bubble = markdown.parentElement as HTMLElement;
    const pre = markdown.querySelector("pre");
    const p = markdown.querySelector("p");
    const code = markdown.querySelector("pre code");
    if (!pre || !p || !code) throw new Error("markdown structure missing");

    const toRgb = (css: string): [number, number, number] => {
      const [r, g, b] = parse(css);
      return [r, g, b];
    };

    return {
      dataTheme: document.documentElement.getAttribute("data-theme"),
      bubbleBg: effectiveBg(bubble),
      preBg: effectiveBg(pre),
      textColor: toRgb(getComputedStyle(p).color),
      codeColor: toRgb(getComputedStyle(code).color),
    };
  });
}

async function seedTileAndTheme(page: Page, theme: string): Promise<void> {
  const username = `aitheme_${rand()}`;
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

  await page.addInitScript(
    ({ t, id, reply, th }) => {
      window.localStorage.setItem("token", t);
      window.localStorage.setItem("homehub:theme", th);
      window.localStorage.setItem(
        `homehub:aichat:${id}`,
        JSON.stringify([
          { role: "user", content: "How do I start it?" },
          { role: "assistant", content: reply },
        ]),
      );
    },
    { t: token, id: tileId, reply: MARKDOWN_REPLY, th: theme },
  );

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".chat-markdown")).toBeVisible();
  await expect(page.locator(".chat-markdown pre code")).toContainText(
    "docker compose up -d",
  );
}

// One dark and one light built-in theme; friction is the default dark-blue
// theme so nebula + hearth exercise both a different dark palette and a
// light palette where foreground/background flip.
const THEMES: Array<{ theme: string; kind: "dark" | "light" }> = [
  { theme: "nebula", kind: "dark" },
  { theme: "hearth", kind: "light" },
];

for (const { theme, kind } of THEMES) {
  test(`AI chat Markdown stays legible in the ${kind} "${theme}" theme`, async ({
    page,
  }) => {
    await seedTileAndTheme(page, theme);

    const sample = await sampleColors(page);
    expect(sample.dataTheme, "theme was not applied").toBe(theme);

    // The theme really is what it claims: light themes have a light bubble
    // surface, dark themes a dark one.
    const bubbleLum = luminance(sample.bubbleBg);
    if (kind === "light") {
      expect(bubbleLum, "expected a light bubble surface").toBeGreaterThan(0.3);
    } else {
      expect(bubbleLum, "expected a dark bubble surface").toBeLessThan(0.3);
    }

    // Code block background must be visibly distinct from the bubble
    // background — otherwise code renders indistinguishable from plain text.
    const dist = rgbDistance(sample.preBg, sample.bubbleBg);
    expect(
      dist,
      `code block background rgb(${sample.preBg}) blends into bubble rgb(${sample.bubbleBg})`,
    ).toBeGreaterThan(8);

    // Body text must contrast against the bubble it sits on (WCAG AA for
    // normal text is 4.5:1).
    const textRatio = contrastRatio(sample.textColor, sample.bubbleBg);
    expect(
      textRatio,
      `body text rgb(${sample.textColor}) on bubble rgb(${sample.bubbleBg}) ratio ${textRatio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(4.5);

    // Code text must contrast against the code block's own background.
    const codeRatio = contrastRatio(sample.codeColor, sample.preBg);
    expect(
      codeRatio,
      `code text rgb(${sample.codeColor}) on code bg rgb(${sample.preBg}) ratio ${codeRatio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(4.5);
  });
}
