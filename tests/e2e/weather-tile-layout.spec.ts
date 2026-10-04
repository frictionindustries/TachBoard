import { test, expect, type Page, type Locator } from "./fixtures";

// ---------------------------------------------------------------------------
// Weather tile responsive layout (side-by-side forecast on wide tiles).
//
// The weather tile switches between two layouts based on the measured tile
// body ("density"):
//   - "row" mode (bodyWidth >= 340 AND bodyWidth > bodyHeight * 1.2): the
//     multi-day forecast renders as a vertical list to the RIGHT of the
//     current-conditions block, and the day count is driven by available
//     HEIGHT (capped at what the API returned).
//   - "col" mode (everything else): the pre-existing layout — a horizontal
//     forecast strip below the current conditions.
//
// jsdom cannot observe this (no real layout measurements), so this is an e2e
// check in a real browser. The weather API response is intercepted so the test
// is deterministic and needs no network/geolocation.
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Six upcoming days after "today" — the maximum the server returns
// (forecast_days: 7 → today + 6).
const MOCK_WEATHER = {
  name: "Testville",
  temp: 21.4,
  feels: 20.1,
  code: 1,
  isDay: true,
  high: 24,
  low: 12,
  forecast: [
    { date: "2026-07-11", code: 1, high: 24, low: 12 },
    { date: "2026-07-12", code: 2, high: 25, low: 13 },
    { date: "2026-07-13", code: 3, high: 22, low: 11 },
    { date: "2026-07-14", code: 61, high: 19, low: 10 },
    { date: "2026-07-15", code: 0, high: 26, low: 14 },
    { date: "2026-07-16", code: 95, high: 18, low: 9 },
    { date: "2026-07-17", code: 71, high: 15, low: 5 },
  ],
};

async function assertNoOverflow(tile: Locator, label: string): Promise<void> {
  const overflow = await tile.evaluate((el) => {
    const bad: string[] = [];
    const nodes = [el, ...Array.from(el.querySelectorAll<HTMLElement>("*"))];
    for (const n of nodes) {
      // Allow 1px of sub-pixel rounding slack.
      if (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1) {
        const cls = typeof n.className === "string" ? n.className : "";
        // Elements that intentionally truncate text report scrollWidth >
        // clientWidth; that's clipping by design, not layout overflow. Same
        // for leading-none text, whose glyph box slightly exceeds the
        // line-height by design.
        if (cls.includes("truncate") || cls.includes("leading-none")) continue;
        bad.push(
          `${n.tagName}.${cls.slice(0, 60)} sw=${n.scrollWidth}/cw=${n.clientWidth} sh=${n.scrollHeight}/ch=${n.clientHeight}`,
        );
      }
    }
    return bad;
  });
  expect(overflow, `${label}: unexpected overflow in ${overflow.join(" | ")}`).toEqual([]);
}

test("weather tile forecast sits beside current conditions on wide tiles, below on tall ones", async ({
  page,
}) => {
  const username = `weathertest_${rand()}`;
  const password = `Pw_${rand()}!`;

  const reg = await page.request.post("/api/auth/register", {
    data: { username, password },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Four weather tiles covering all three layout modes. Sizes chosen from the
  // fixed grid resolution (col ≈ 52px + 12px margin, row = 40px + 12px margin,
  // 45px header):
  //   - Wide:      10w×4h → body ≈ 628×151 → row mode (forecast beside).
  //   - Tall:       4w×7h → body ≈ 244×307 → list mode (vertical days below).
  //   - Very wide: 14w×6h → body ≈ 872×255 → row mode, all 6 days fit.
  //   - Squarish:   5w×6h → body ≈ 308×255 → col mode (horizontal strip).
  const tiles = [
    { name: "Weather Wide", gridX: 0, gridY: 0, gridW: 10, gridH: 4 },
    { name: "Weather Tall", gridX: 10, gridY: 0, gridW: 4, gridH: 7 },
    { name: "Weather XWide", gridX: 0, gridY: 7, gridW: 14, gridH: 6 },
    { name: "Weather Square", gridX: 14, gridY: 0, gridW: 5, gridH: 6 },
  ];
  for (const t of tiles) {
    const res = await page.request.post("/api/tiles", {
      data: {
        ...t,
        integration: "weather",
        tileSettings: {
          weatherAutoLocate: false,
          weatherLocation: "Testville",
          weatherUnits: "c",
        },
      },
      headers: authHeaders,
    });
    expect(res.ok(), `tile create failed: ${res.status()}`).toBeTruthy();
  }

  // Deterministic weather data — no network, no geolocation.
  await page.route("**/api/widgets/weather*", (route) =>
    route.fulfill({ json: MOCK_WEATHER }),
  );

  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.locator(".react-grid-layout").waitFor();
  await expect(page.locator(".react-grid-item")).toHaveCount(4);

  const wide = page.locator(".react-grid-item", { hasText: "Weather Wide" });
  const tall = page.locator(".react-grid-item", { hasText: "Weather Tall" });
  const xwide = page.locator(".react-grid-item", { hasText: "Weather XWide" });
  const square = page.locator(".react-grid-item", { hasText: "Weather Square" });

  // --- Wide tile: side-by-side (row) layout ---------------------------------
  const wideRow = wide.getByTestId("weather-forecast-row");
  await expect(wideRow).toBeVisible();
  await expect(wide.getByTestId("weather-forecast-col")).toHaveCount(0);

  // The forecast column really sits to the RIGHT of the temperature block.
  const tempBox = await wide.getByText("21°C").boundingBox();
  const rowBox = await wideRow.boundingBox();
  expect(tempBox && rowBox).toBeTruthy();
  expect(rowBox!.x).toBeGreaterThan(tempBox!.x + tempBox!.width);
  // And vertically overlaps it (beside, not below).
  expect(rowBox!.y).toBeLessThan(tempBox!.y + tempBox!.height);

  // Day count driven by height: mirrors the component's formula
  // min(6, max(2, floor((bodyHeight - 20) / 26))) using the real rendered body
  // height (the row layout's outer container is the h-full tile body).
  const wideBodyH = await wideRow.evaluate(
    (el) => el.parentElement!.clientHeight,
  );
  const expectedRows = Math.min(6, Math.max(2, Math.floor((wideBodyH - 20) / 26)));
  expect(expectedRows).toBeGreaterThanOrEqual(4);
  await expect(wideRow.locator("> div")).toHaveCount(expectedRows);

  // --- Tall tile: vertical day list fills the height below ------------------
  const tallList = tall.getByTestId("weather-forecast-list");
  await expect(tallList).toBeVisible();
  await expect(tall.getByTestId("weather-forecast-row")).toHaveCount(0);
  await expect(tall.getByTestId("weather-forecast-col")).toHaveCount(0);

  // The list sits BELOW the temperature block.
  const tallTempBox = await tall.getByText("21°C").boundingBox();
  const listBox = await tallList.boundingBox();
  expect(tallTempBox && listBox).toBeTruthy();
  expect(listBox!.y).toBeGreaterThan(tallTempBox!.y + tallTempBox!.height);

  // Height-driven day count: mirrors min(6, max(3, floor((bodyHeight-150)/30))).
  const tallBodyH = await tallList.evaluate(
    (el) => el.parentElement!.clientHeight,
  );
  const expectedListRows = Math.min(
    6,
    Math.max(3, Math.floor((tallBodyH - 150) / 30)),
  );
  expect(expectedListRows).toBeGreaterThanOrEqual(4);
  await expect(tallList.locator("> div")).toHaveCount(expectedListRows);

  // The list stretches to fill the tile: its bottom edge reaches near the
  // tile body's bottom instead of leaving a large empty band.
  const tallBodyBox = await tallList.evaluate((el) => {
    const r = el.parentElement!.getBoundingClientRect();
    return { y: r.y, height: r.height };
  });
  expect(listBox!.y + listBox!.height).toBeGreaterThan(
    tallBodyBox.y + tallBodyBox.height - 24,
  );

  // --- Very wide tile: all six upcoming days appear -------------------------
  const xwideRow = xwide.getByTestId("weather-forecast-row");
  await expect(xwideRow).toBeVisible();
  await expect(xwideRow.locator("> div")).toHaveCount(6);

  // Row layout fills the width: the forecast half extends near the tile's
  // right edge (temps are pushed to the row's right side via ml-auto).
  const xwideRowBox = await xwideRow.boundingBox();
  const xwideBodyBox = await xwideRow.evaluate((el) => {
    const r = el.parentElement!.getBoundingClientRect();
    return { x: r.x, width: r.width };
  });
  expect(xwideRowBox!.x + xwideRowBox!.width).toBeGreaterThan(
    xwideBodyBox.x + xwideBodyBox.width - 24,
  );

  // --- Squarish tile: the original horizontal strip layout ------------------
  const squareCol = square.getByTestId("weather-forecast-col");
  await expect(squareCol).toBeVisible();
  await expect(square.getByTestId("weather-forecast-row")).toHaveCount(0);
  await expect(square.getByTestId("weather-forecast-list")).toHaveCount(0);

  // Width-driven day count: body ≈ 308px → floor((308-8)/54) = 5 days.
  await expect(squareCol.locator("> div")).toHaveCount(5);

  // --- No clipping/overflow at any of these shapes --------------------------
  await assertNoOverflow(wide, "wide tile");
  await assertNoOverflow(tall, "tall tile");
  await assertNoOverflow(xwide, "very wide tile");
  await assertNoOverflow(square, "squarish tile");
});
