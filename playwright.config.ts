import { defineConfig, devices } from "@playwright/test";

// E2E config for the homelab dashboard.
//
// By default the suite boots the full local dev stack (`pnpm run dev:local`,
// which serves the web app on :20026 and proxies `/api` to the API server on
// :20027) and runs the browser against it. Set `E2E_BASE_URL` to point the suite
// at an already-running server instead (e.g. the Replit dev domain), in which
// case the embedded web server is skipped.
//
// Browsers: run `pnpm exec playwright install chromium` once before the first
// run (CI must do the same).
const baseURL = process.env.E2E_BASE_URL || "http://localhost:20026";
const useEmbeddedServer = !process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: useEmbeddedServer
    ? {
        // VITE_FORCE_API_PROXY turns the web app's `/api`→localhost proxy on
        // even when REPL_ID is present, so the suite runs unchanged both on
        // and off Replit.
        command: "VITE_FORCE_API_PROXY=1 pnpm run dev:local",
        // Wait on the API health endpoint *through* the Vite proxy: the web
        // dev server comes up before the API's first build finishes, and
        // waiting only on the web root lets specs start while /api still 500s.
        url: "http://localhost:20026/api/healthz",
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : undefined,
});
