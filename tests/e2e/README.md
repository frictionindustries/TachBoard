# Browser regression data

Run `pnpm test:e2e`. The global setup builds the API once, then the shared
`fixtures.ts` starts local API/Vite servers and a fresh temporary SQLite data
directory **for each test and retry**. Always import `test` from `./fixtures`,
not directly from Playwright. Both `page.request` and the `request` fixture use
the isolated server.

Teardown stops the servers and removes only the directory allocated by that
fixture, including uploads. It runs for successful and failed tests. A forcibly
killed worker may leave a temporary directory; future runs never reuse it.
No cleanup queries or username-prefix matching run against a user's database.
The normal account cap and rate limits remain enabled and unchanged.

`E2E_BASE_URL` is deliberately rejected: these registration tests must not target
an existing deployment. Local dev servers and `DATA_DIR` are not reused. API
servers do not inherit service credentials from the environment.

`pnpm test:e2e account-lifecycle` checks 33 independent registration lifecycles
without launching a browser. The identical username must work in every test.
Run it with `--repeat-each=2` to check repeated execution.