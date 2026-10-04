import { defineConfig, devices } from "@playwright/test";

// Registration tests must never target an existing development/production DB.
if (process.env.E2E_BASE_URL) {
  throw new Error("E2E_BASE_URL is no longer supported: browser tests use disposable local servers and databases.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [["list"]],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});