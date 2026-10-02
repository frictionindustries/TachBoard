# Threat Model

## Project Overview

Tachboard is a self-hostable homelab dashboard with a React frontend and an Express backend. Users create local accounts, store dashboard pages and tiles, upload tile images, and connect the server to home-lab services and external providers such as Plex, Jellyfin, Sonarr, Radarr, Pi-hole, Spotify, Gmail, Google Calendar, IMAP, and CalDAV. The production app serves the SPA from the API server, persists data in SQLite under `DATA_DIR`, and authenticates API requests with JWT bearer tokens.

## Assets

- **User accounts and sessions** — local usernames, password hashes, and JWT bearer tokens. Compromise allows impersonation and access to a user's dashboard data.
- **Private dashboard data** — per-user pages, tiles, uploaded images, and tile settings. These may reveal personal infrastructure, habits, or links.
- **Integration credentials and tokens** — API keys, passwords, OAuth client secrets, refresh tokens, and access tokens for home-lab and cloud services. Compromise can expose third-party accounts and internal infrastructure.
- **Fetched service data** — email contents, calendar events, media metadata, service health, and other information retrieved from connected systems. This data may be sensitive even when the dashboard is private.
- **Application secrets and local state** — the JWT signing secret, SQLite database, and files stored under `DATA_DIR`.

## Trust Boundaries

- **Browser to API** — every request from the SPA crosses from an untrusted client into the backend. Authentication, authorization, and input validation must be enforced server-side.
- **Authenticated user to other authenticated users** — the app supports multiple local accounts, so every route that exposes stored state or upstream data must preserve per-user isolation unless the feature is intentionally instance-global and clearly constrained.
- **API to SQLite / filesystem** — the backend can read and write all persisted user data, uploads, and stored credentials. Authorization bugs or unsafe file handling here expose the whole instance.
- **API to third-party and homelab services** — the server makes outbound requests with stored secrets to local services and internet APIs. User-controlled target selection or token reuse can turn the backend into a proxy for unauthorized access.
- **Instance owner vs non-owner users** — the earliest account (`userStmts.findFirst`) is treated as the instance owner. Only the owner's authenticated outbound context may reach RFC1918/ULA/loopback destinations through `httpClient`; all other users and all identity-less background work are forced public-only (fail-closed).
- **Production vs dev-only artifacts** — production scope is the Express API and served SPA. `artifacts/mockup-sandbox` and other development-only surfaces are out of scope unless demonstrated to be reachable in production.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/routes/*`.
- Highest-risk code areas: auth (`src/lib/auth.ts`, `src/routes/auth.ts`, `src/lib/authResources.ts`), shared credential storage (`src/lib/db.ts`, `src/lib/google.ts`, `src/lib/spotify.ts`, `src/lib/mailAccounts.ts`), widget proxy routes (`src/routes/widgets.ts`), connection management (`src/routes/connections.ts`), and the outbound/SSRF stack (`src/lib/http.ts`, `src/lib/serviceUrl.ts`, `src/lib/outboundPolicy.ts`, `src/lib/outboundContext.ts`).
- Public surfaces: `/api/auth/register`, `/api/auth/login`, unauthenticated OAuth callback routes, and production static asset serving. Uploaded files under `/api/uploads/files/*` are also public and same-origin with the SPA, so file-type confusion there is XSS-relevant rather than a pure content-hosting concern.
- Authenticated surfaces: tiles/pages/layout, uploads, connections, widget data, Spotify control, Gmail/Calendar/IMAP access.
- Usually ignore as dev-only: `artifacts/mockup-sandbox`, tests, and local-only workflow helpers unless production reachability is proven.

## Threat Categories

### Spoofing

The application relies on long-lived JWT bearer tokens for API access. Protected routes must reject missing, malformed, expired, or forged tokens, and any top-level OAuth navigation that cannot carry the bearer token must use a robust single-use anti-CSRF mechanism. Secrets used to sign JWTs must remain unpredictable across production restarts.

### Tampering

Authenticated users can mutate tiles, pages, uploads, connections, and linked external accounts. The backend must ensure that state-changing requests only affect the caller's own resources unless a feature is intentionally instance-global and protected accordingly. User-controlled URLs and connection parameters used for outbound requests must not let an attacker repurpose the server to attack internal or third-party systems.

### Information Disclosure

The backend stores service passwords, API keys, OAuth client secrets, refresh tokens, and data fetched from connected services such as email and calendars. These values and derived data must never be exposed to other authenticated users, unauthenticated visitors, logs, or client-visible error messages. Uploaded files and exported dashboard state must not leak information across user boundaries.

### Denial of Service

Public auth endpoints, file uploads, and expensive widget fetches can be abused to consume CPU, memory, disk, or outbound network capacity. Production routes must bound request size and work performed per request, and repeated authentication attempts or expensive upstream fetches should not let an attacker degrade service for other users.

### Elevation of Privilege

Because the app supports multiple local accounts but also holds shared integration state, broken authorization can let one user gain access to another user's secrets, upstream accounts, or connected infrastructure. Any route that returns stored credentials, issues OAuth-derived access, proxies commands, or uses server-held tokens to access third-party data must enforce the intended ownership boundary explicitly.

## Current Scan Notes

- Treat self-registration as production-reachable unless deployment settings prove otherwise. Any issue reachable after creating a normal account is in scope.
- Shared integration storage is the highest-risk architectural seam in this codebase and should be re-checked on future scans whenever connection, widget, Google, Spotify, IMAP, or CalDAV code changes.
- Server-side fetch features are only acceptable when destination trust is explicit. Any new route that accepts a user-controlled URL or reuses saved connection URLs should be reviewed for SSRF and cross-user abuse.

## Scan Notes — Task 515 (full scan, 2026)

- **Shared env-credential fallback pattern** (`widgets.ts`): widget routes resolve `saved.url || process.env[...]` and `saved.apiKey || process.env[...]` independently. A user who saves only a URL (no key) causes a shared deployment env credential to be sent to that user-chosen URL. Re-check any new widget that follows this fallback pattern.
- **Process-global upstream caches**: the qBittorrent SID cache and NPM token cache are keyed by URL+username only (no userId/password), so a cached session can be reused across Tachboard users. Any new cross-request caching of upstream auth must include the owning userId in the key.
- **OAuth state binding**: Google/Spotify state is single-use and account-bound but NOT browser-bound; account-linking CSRF is possible. Future OAuth work should bind state to the initiating browser (e.g. a cookie) and re-verify on callback.
- **IMAP/CalDAV/GameDig outbound paths bypass the `httpClient` SSRF guard** (raw imapflow/tsdav/gamedig sockets). They permit internal-network reachability by design of those protocols; keep them in mind for SSRF scope. NOTE (Task 525): these raw-socket paths are NOT covered by the new owner-only outbound-context guard, so a non-owner user with their own IMAP/CalDAV/gamedig connection can still reach LAN via those protocols. This remains design-accepted (user supplies their own creds for their own account), but should be revisited if these protocols ever proxy on shared/owner credentials.
- Access control for tiles/pages/layout/device-modes/uploads/profile is correctly user-scoped (every lookup uses `findById(id, userId)` / user-scoped statements). SQLi is not present (all statements parameterized). Uploads are byte-sniffed + SVG-sanitized and served with nosniff+strict CSP.

## Scan Notes — Task 522 (full scan, baseline==HEAD bf0e7d6)

- No incremental diff (baseline SHA equals HEAD). Full re-review performed. Prior-hardened seams verified clean: JWT secret persistence, bcrypt cost 12, OAuth browser-bound state, user-scoped tiles/pages/uploads/profile, parameterized SQL, upstream session caches isolated by user+creds, upload byte-sniff + SVG sanitize + strict CSP.
- NEW: TrueNAS diagnostics (`widgets.ts` `/truenas/diagnostics`) concatenates the saved service URL with fixed suffixes; a `base?`-style URL turns it into an arbitrary-path internal HTTP reader returning raw bodies. `httpClient` permits RFC1918/ULA by default (`ssrfPublicOnly` off) — intentional for the owner, but a lower-priv registered user gains an internal-network read primitive. Re-check any diagnostics/proxy route that returns raw upstream bodies and does not opt into `ssrfPublicOnly`.
- NEW: DoS — `uniquePageName` in `pages.ts` is O(N²) on duplicate names; `/api/pages/import` has no page-count cap (5mb body). Also `/api/auth/register` is unauthenticated with no rate limit and no username length cap.
- Confirmed design-accepted (not re-reported): private-range reachability by design; `saved.url || env` fallback did NOT leak shared env creds (atomic connection selection).

## Scan Notes — Task 525 (incremental, baseline==HEAD 483445f; reviewed diff since last-scan bf0e7d6)

All changes since the previous scan are security hardening commits (`08895d6`, `483445f`) that remediate the Task-522 findings. No new vulnerabilities were found and `.local/existing_vulnerabilities/` was empty (nothing to re-state). Verified remediations:

- **Cross-user internal-network read (Task 522 TrueNAS/SSRF) — FIXED.** New `outboundContext` (AsyncLocalStorage) + `runAsOutboundUser` enforce owner-only LAN access. `httpClient` now computes `publicOnly = ssrfPublicOnly === true || publicOnlyOutboundRequired()`, so any request without an owner outbound context (non-owner users, identity-less background work) is forced public-only and fails closed. `requireAuth` (`lib/auth.ts:90`), the ErsatzTV stream auth (`widgets.ts:5328`), and background health checks (`healthCheck.ts:39`) all establish the context. Private ranges are now off-limits to non-owners even for widget/diagnostics routes.
- **Service-URL confusion — FIXED.** `validateServiceBaseUrl` (`lib/serviceUrl.ts`) rejects queries, fragments, credentials, control chars, backslashes, and encoded/plain path traversal, and is applied at connection write (`connections.ts`), read (`widgets.ts getSavedConnection`), env fallback, media-server resolution, and profile import. The TrueNAS `base?`-suffix-swallow primitive is no longer possible.
- **httpClient hardening — verified.** Protocol restricted to http/https, DNS pinned onto the connecting socket, `maxRedirects = 0` (unconditional), and `config.proxy = false` to defeat HTTP(S)_PROXY-based destination substitution.
- **Auth DoS — FIXED.** `createAuthIngress` mounts before the 5mb JSON parser with a 4KB body cap, content-type allowlist, and per-source/global request + bcrypt rate limits with bounded concurrency (`lib/authResources.ts`); registration enforces username/password length bounds and a 32-account cap inside a serialized `BEGIN IMMEDIATE` transaction.
- **Import DoS — FIXED.** `importBudgetError` caps pages/layouts/tiles/connections/device-modes before schema parsing in both `pages.ts` and `profile.ts` import handlers; `createPageNameAllocator` replaces the O(N²) `uniquePageName` scan.

SAST leads reviewed and dismissed as non-issues (all pre-existing, unchanged by this diff): `subsonic.ts` MD5 is mandated by the Subsonic auth protocol; `uploads.ts:229` writes a server-generated `Date.now()-random.ext` filename (ext derived from byte-sniffing), so no attacker-controlled path component; `spotify.ts` callback redirects target the app's own origin via server-side, single-use, browser-bound OAuth state (`pending.returnTo`/`originFromRequest`), not an attacker-controlled destination.
