import { expect, type Page, type Route } from "@playwright/test";

/**
 * Hold Vite's entry module while checking the inline startup script.
 * DOMContentLoaded is too late: deferred modules execute before that event.
 * Use commit + the parsed root instead, and always release the request even
 * when an assertion fails. Routing also disables the browser HTTP cache.
 */
export async function beforeReact(
  page: Page,
  path: string,
  assertTheme: () => Promise<void>,
) {
  const entry = /\/src\/main\.tsx(?:\?.*)?$/;
  let intercepted = false;
  let continuation: Promise<void> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = async (route: Route) => {
    intercepted = true;
    await gate;
    continuation = route.continue();
    await continuation;
  };
  await page.route(entry, hold);
  try {
    await page.goto(path, { waitUntil: "commit" });
    await page.locator("#root").waitFor({ state: "attached" });
    await expect
      .poll(() => intercepted, {
        message:
          "The React entry module must be intercepted before theme assertions",
      })
      .toBe(true);
    await expect(page.locator("#root")).toBeEmpty();
    await assertTheme();
    await expect(page.locator("#root")).toBeEmpty();
  } finally {
    release();
    // Let the held handler finish before unregistering it; unroute can
    // otherwise auto-continue the same request while our handler resumes.
    await gate;
    await continuation;
    await page.unroute(entry, hold);
  }
}
