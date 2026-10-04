import { test as base } from "@playwright/test";
import { startIsolatedServer } from "./isolated-server.mjs";

// A fresh server/DB per test (including retries) resets both the account quota
// and in-memory auth limits. Teardown also runs after assertion failures.
export const test = base.extend({
  baseURL: async ({}, use) => {
    const server = await startIsolatedServer();
    try {
      await use(server.baseURL);
    } finally {
      await server.stop();
    }
  },
});
export { expect } from "@playwright/test";
export type { Page, APIRequestContext, Locator } from "@playwright/test";