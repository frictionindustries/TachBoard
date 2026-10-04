---
name: Playwright e2e setup (NixOS / Replit)
description: How to run the checked-in Playwright e2e suite on Replit's NixOS env and how it authenticates against the dashboard
---

# Playwright e2e suite

Server-targeting instructions below are historical and superseded by
[E2E account isolation](e2e-data-isolation.md). Do not set E2E_BASE_URL or use
the shared development database for checked-in browser regression tests.

Root config `playwright.config.ts` + specs under `tests/e2e/`; run with `pnpm run test:e2e`.

## Browser libs on NixOS
- `pnpm exec playwright install chromium` downloads the browser, but it won't launch out of the box — NixOS has no `/usr/lib`, so it fails on missing `libglib-2.0.so.0`, then `libgbm.so.1`, etc.
- Fix: install the deps via the package-management skill's `installSystemDependencies` (Nix attrs, NOT apt names). Needed set includes: glib, nss, nspr, atk, at-spi2-atk, at-spi2-core, cups, dbus, expat, libdrm, libxkbcommon, mesa, alsa-lib, pango, cairo, gtk3, gdk-pixbuf, fontconfig, freetype, libglvnd, **libgbm** (separate package — provides libgbm.so.1), and the xorg.* libs (libX11, libXcomposite, libXdamage, libXext, libXfixes, libXrandr, libxcb, libXrender, libXtst, libXi, libXcursor, libXScrnSaver). `libxshmfence` is NOT in the rippkgs index — omit it. Also `systemdLibs` (provides libudev.so.1). Browsers install under `$PWD/.cache/ms-playwright` (workspace-local), not `~/.cache` — check `ldd` there.

## Pointing the suite at a server
- Default `baseURL` is `http://localhost:3000` and the config auto-boots `pnpm run dev:local` as a webServer (CI path; off-Replit the Vite `/api` proxy is ON).
- **On Replit the Vite `/api` proxy is OFF** (gated on REPL_ID), so localhost:3000 has no API. To verify locally here, run against the platform-proxied dev domain which path-routes `/api` to the API server: `E2E_BASE_URL="https://$REPLIT_DEV_DOMAIN" pnpm exec playwright test` (setting E2E_BASE_URL skips the embedded webServer) — but this needs a running workflow, else 502.
- **Plain `pnpm exec playwright test <spec>` now works on Replit**: the Playwright webServer command sets `VITE_FORCE_API_PROXY=1`, which overrides the REPL_ID gate in the dashboard vite config and re-enables the `/api`→localhost proxy. (Older alternative: `env -u REPL_ID pnpm exec playwright test <spec>`.) Unsetting REPL_ID also turns the Vite `/api` proxy back ON, and Playwright's embedded webServer (`pnpm run dev:local`, boots api:5000 + web:3000) inherits the env, so localhost:3000 serves both app and API. Playwright manages the server lifecycle (no flaky manual nohup). chromium must be installed first (`pnpm exec playwright install chromium` + `installSystemDependencies` — param is `packages`, not `dependencies`).

## Startup theme checks

Do not use DOMContentLoaded as evidence that React has not run; deferred modules execute before it.
**Why:** React can repair missing inline startup theme application and hide a flash regression.
**How to apply:** Hold the entry-module request, check the parsed empty root and theme state, then release it for hydration. Finish the held route continuation before removing its handler; otherwise Playwright may auto-continue the request twice.

## Auth in tests (NOT cookies)
- Auth is a **Bearer JWT**: `POST /api/auth/register` (or `/login`) returns `{ token, user }`; the web app stores it in `localStorage["token"]` and sends `Authorization: Bearer <token>`.
- In a spec: register via `page.request`, then (a) pass `{ Authorization: 'Bearer '+token }` on API calls like `POST /api/tiles`, and (b) `page.addInitScript(t => localStorage.setItem('token', t), token)` BEFORE the first `goto('/')` so the browser app is authed on load.

## API readiness
- Playwright webServer now waits on `http://localhost:3000/api/healthz` (API health through the Vite proxy), not the web root — the web dev server boots before the API's first build, and waiting only on `/` let the first spec hit warm-up 500s on `/api/auth/register`.

## Sticky-column guides & coordinate clicks
- In the ErsatzTV guide grid, programme blocks near "now" sit partly under the sticky channel column / header on narrow viewports; Playwright's real `click()` retries forever ("subtree intercepts pointer events"). Use `locator.dispatchEvent("click")` to open the popover, then keep real clicks for the popover's own buttons (z-40, above the grid).
- Real-pointer clicking a programme AFTER a horizontal scroll: `locator.click()` auto-scrolls the element into view, which re-aligns its left edge back UNDER the sticky column and re-intercepts. Instead: wheel-scroll the grid by a computed delta (`blockBox.x - stickyRight - 8`), re-measure the box, and `page.mouse.click()` at raw coordinates (no auto-scroll). See "phone: scrolling…" test in ersatztv-tile-guide.spec.ts.
- On a 400px viewport a gridW=6 tile is only ~150px wide — the sticky channel column alone fills it, so no timeline is ever clickable. Seed gridW=12 (full width) for phone-interaction tests.

## Background servers from the bash tool
- `setsid`/`nohup` background processes (dev servers, playwright runs) get reaped between bash tool invocations — don't rely on them. To run e2e on Replit: start the artifact workflows (`artifacts/api-server: API Server`, `artifacts/homelab-dashboard: web`) and run `E2E_BASE_URL="https://$REPLIT_DEV_DOMAIN" pnpm exec playwright test <spec>`. Also `localhost` resolves to ::1 (EAFNOSUPPORT) — the dev-domain route avoids it.
