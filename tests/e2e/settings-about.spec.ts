import { test, expect, type Page } from "@playwright/test";
import type { VersionInfo } from "@workspace/api-client-react";

// Older version responses may omit releaseNotes altogether.
type VersionResponse = Omit<VersionInfo, "releaseNotes"> &
  Partial<Pick<VersionInfo, "releaseNotes">>;

const UPDATE: VersionResponse = {
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  updateAvailable: true,
  checkEnabled: true,
  releaseUrl: "https://github.com/example/tachboard/releases/tag/v1.1.0",
};

const NOTES = [
  "## Release highlights",
  "",
  "- Added **dashboard backups**",
  "- Fixed `tile layout`",
  "",
  "[Read the guide](https://example.com/guide)",
  "",
  '<script>window.__releaseNotesScriptRan = true; /* unsafe-release-script */</script>',
  '<img alt="Release illustration" onerror="window.__releaseNotesHandlerRan = true">',
  '<a href="javascript:window.__releaseNotesLinkRan=true">Unsafe link</a>',
].join("\n");

// Exercise the real Settings page and API query, without creating accounts or
// depending on GitHub's latest release or the host's saved connections.
async function openSettings(page: Page, version: VersionResponse | null) {
  await page.addInitScript(() => localStorage.setItem("token", "about-test-token"));
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: 1, username: "about-test" } }),
  );
  await page.route("**/api/connections", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/connections/*/accounts", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/connections/*/status", (route) =>
    route.fulfill({ json: { connected: false, configured: false } }),
  );
  await page.route("**/api/version", (route) => {
    expect(route.request().method()).toBe("GET");
    return version === null
      ? route.fulfill({ status: 503, json: { error: "Version check unavailable" } })
      : route.fulfill({ json: version });
  });
  const versionResponse = page.waitForResponse("**/api/version");
  await page.goto("/settings");
  const response = await versionResponse;
  expect(response.status()).toBe(version === null ? 503 : 200);
  await response.finished();
  await expect(page.getByRole("banner").getByText("Settings", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toBeEnabled();
  const build = page.getByTestId("text-app-version");
  await expect(build).toHaveText(version === null ? "Version …" : "Version 1.0.0");
  await build.scrollIntoViewIfNeeded();
  await expect(build).toBeVisible();
  await expect(build.locator("..").getByText("Tachboard", { exact: true })).toBeVisible();
  if (version?.checkEnabled === false) {
    await expect(page.getByText("Update checks are disabled.", { exact: true })).toBeVisible();
  } else {
    await expect(page.getByText("Update checks are disabled.", { exact: true })).toHaveCount(0);
  }
}

test("About update link and What's new expand sanitized Markdown and collapse again", async ({ page }) => {
  await openSettings(page, { ...UPDATE, releaseNotes: NOTES });

  const update = page.getByTestId("link-update-available");
  await expect(update).toBeVisible();
  await expect(update).toHaveText("Update available: 1.1.0");
  await expect(update).toHaveAttribute("href", UPDATE.releaseUrl!);
  await expect(update).toHaveAttribute("target", "_blank");
  await expect(update).toHaveAttribute("rel", /noreferrer/);

  const toggle = page.getByTestId("button-toggle-release-notes");
  const panel = page.getByTestId("release-notes");
  await expect(toggle).toHaveText("What's new");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Release highlights" })).toBeVisible();
  await expect(panel.locator("ul > li")).toHaveCount(2);
  await expect(panel.locator("strong")).toHaveText("dashboard backups");
  await expect(panel.locator("code")).toHaveText("tile layout");
  const guide = panel.getByRole("link", { name: "Read the guide" });
  await expect(guide).toHaveAttribute("href", "https://example.com/guide");
  await expect(guide).toHaveAttribute("target", "_blank");
  await expect(guide).toHaveAttribute("rel", "noopener noreferrer");

  // Assert removal, not just non-execution: scripts inserted with innerHTML
  // don't normally execute even when a sanitizer is accidentally bypassed.
  await expect(panel.locator("script, [onerror], [onclick]")).toHaveCount(0);
  await expect(panel).not.toContainText("unsafe-release-script");
  await expect(panel.getByText("Unsafe link", { exact: true })).not.toHaveAttribute("href");
  await expect(panel.getByAltText("Release illustration")).toBeVisible();
  expect(await page.evaluate(() =>
    Object.keys(window).filter((key) => key.startsWith("__releaseNotes")),
  )).toEqual([]);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator("strong")).toHaveText("dashboard backups");
});

for (const [name, notes] of [
  ["missing", undefined],
  ["null", null],
  ["empty", ""],
  ["whitespace-only", " \n\t "],
] as const) {
  test(`About hides the notes toggle for ${name} release notes`, async ({ page }) => {
    const version = { ...UPDATE };
    if (notes !== undefined) version.releaseNotes = notes;
    await openSettings(page, version);
    await expect(page.getByTestId("link-update-available")).toBeVisible();
    await expect(page.getByTestId("button-toggle-release-notes")).toHaveCount(0);
    await expect(page.getByTestId("release-notes")).toHaveCount(0);
  });
}

test("About hides the update link and notes when already up to date", async ({ page }) => {
  await openSettings(page, {
    ...UPDATE,
    updateAvailable: false,
    releaseNotes: NOTES,
  });
  await expect(page.getByTestId("link-update-available")).toHaveCount(0);
  await expect(page.getByTestId("button-toggle-release-notes")).toHaveCount(0);
  await expect(page.getByTestId("release-notes")).toHaveCount(0);
});

test("About keeps Settings and the footer usable when update checks are disabled", async ({ page }) => {
  await openSettings(page, {
    currentVersion: "1.0.0",
    latestVersion: null,
    updateAvailable: false,
    checkEnabled: false,
    releaseUrl: null,
    releaseNotes: null,
  });
  await expect(page.getByTestId("link-update-available")).toHaveCount(0);
  await expect(page.getByTestId("button-toggle-release-notes")).toHaveCount(0);
  await expect(page.getByTestId("release-notes")).toHaveCount(0);
});

test("About keeps Settings and the footer usable when the version request fails", async ({ page }) => {
  await openSettings(page, null);
  await expect(page.getByTestId("link-update-available")).toHaveCount(0);
  await expect(page.getByTestId("button-toggle-release-notes")).toHaveCount(0);
  await expect(page.getByTestId("release-notes")).toHaveCount(0);
});