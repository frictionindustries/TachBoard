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
- **Production vs dev-only artifacts** — production scope is the Express API and served SPA. `artifacts/mockup-sandbox` and other development-only surfaces are out of scope unless demonstrated to be reachable in production.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/routes/*`.
- Highest-risk code areas: auth (`src/lib/auth.ts`, `src/routes/auth.ts`), shared credential storage (`src/lib/db.ts`, `src/lib/google.ts`, `src/lib/spotify.ts`, `src/lib/mailAccounts.ts`), widget proxy routes (`src/routes/widgets.ts`), and connection management (`src/routes/connections.ts`).
- Public surfaces: `/api/auth/register`, `/api/auth/login`, unauthenticated OAuth callback routes, and production static asset serving.
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
- **IMAP/CalDAV/GameDig outbound paths bypass the `httpClient` SSRF guard** (raw imapflow/tsdav/gamedig sockets). They permit internal-network reachability by design of those protocols; keep them in mind for SSRF scope.
- Access control for tiles/pages/layout/device-modes/uploads/profile is correctly user-scoped (every lookup uses `findById(id, userId)` / user-scoped statements). SQLi is not present (all statements parameterized). Uploads are byte-sniffed + SVG-sanitized and served with nosniff+strict CSP.
