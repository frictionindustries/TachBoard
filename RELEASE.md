# Release Pipeline

Tachboard ships three ways. Docker is the primary path (Linux + TrueNAS
SCALE); self-contained bundles cover Windows/macOS (and non-Docker Linux)
self-hosters who don't want to install Node or Docker.

| Platform | Artifact | Native modules |
|---|---|---|
| Linux / TrueNAS SCALE | Multi-arch Docker image on GHCR (`linux/amd64` + `linux/arm64`) | built inside the image |
| Windows x64 | `tachboard-windows-x64.zip` | built natively on a Windows runner |
| macOS arm64 / x64 | `tachboard-macos-{arm64,x64}.tar.gz` | built natively on macOS runners |
| Linux x64 / arm64 (no Docker) | `tachboard-linux-{x64,arm64}.tar.gz` | built natively on Linux runners |

## Cutting a release

1. Make sure `main` is green (typecheck + tests).
2. Tag and push:
   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```
3. `.github/workflows/release.yml` then:
   - builds and pushes the multi-arch Docker image to
     `ghcr.io/<owner>/<repo>` tagged `1.2.3`, `1.2`, and `latest`;
   - builds, **smoke-tests**, and attaches the five platform bundles to the
     GitHub Release.

A `workflow_dispatch` run does everything except pushing the image /
attaching to a release — use it as a dry run.

## How the bundles work

`scripts/package-release.mjs` runs **on each target platform** (never
cross-compiled) and stages:

- `server/` — the esbuild output of the API server (`build.mjs`). The native
  and asset-loading packages (`better-sqlite3`, `sharp`, `gamedig`,
  `isomorphic-dompurify`) are externalized there, so they are installed…
- `node_modules/` — …natively via `npm install`, pinned to the exact versions
  the workspace lockfile resolved. npm downloads the prebuilt binaries for
  the host OS/arch/ABI (or compiles them) on the runner itself.
- `bin/node` — a copy of the **exact Node binary** the install ran under, so
  runtime ABI always matches the native modules. Users need no Node install.
- `frontend-dist/` — the production Vite build.
- `start.sh` / `start.bat` — sets `NODE_ENV=production`, defaults
  `PORT=20028` and `DATA_DIR=./data` (next to the launcher), points
  `FRONTEND_DIST` at the bundled frontend, and starts the server.
- `README.txt` — per-platform install/run instructions (see also INSTALL.md).

### Smoke test (release gate)

`scripts/smoke-test-bundle.mjs` runs against every staged bundle with the
*bundled* runtime and fails the release job if any of these break:

1. `better-sqlite3` in-memory roundtrip and `sharp` PNG encode (catches
   wrong-platform / wrong-ABI native binaries).
2. Server boots and `/api/healthz` returns 200.
3. `GET /` serves the SPA `index.html`.
4. Register + login through the real API; the SQLite DB file and the
   auto-generated `jwt-secret` appear in a scratch `DATA_DIR`.

## Code signing decision

**Decision: ship unsigned, with a documented bypass per platform.**
Signing requires paid accounts and secret management (Apple Developer
Program ~$99/yr + notarization; a Windows OV/EV certificate or Azure Trusted
Signing). For a self-hosted OSS server launched from a terminal, the bypass
friction is acceptable:

- **macOS (Gatekeeper):** the bundled `node` binary is a copy of the
  officially signed Node.js build, but the downloaded archive gets the
  quarantine attribute. Documented fix (also in the bundle's README.txt):
  `xattr -dr com.apple.quarantine <extracted folder>`.
- **Windows (SmartScreen):** users may see "Windows protected your PC" on
  first run of `start.bat` → "More info" → "Run anyway" (or Unblock the .zip
  in Properties before extracting). Documented in README.txt.

**Upgrade path (if/when distribution warrants it):** add a `codesign`/
`notarytool` step to the macOS jobs (needs `APPLE_ID`, `APPLE_TEAM_ID`,
app-specific password + Developer ID cert in repo secrets) and a
`signtool`/Azure Trusted Signing step to the Windows job. The workflow is
structured so these slot in between "Package bundle" and "Smoke test".

## Version support notes

- Bundles pin Node via `NODE_VERSION` in the workflow (currently 22 LTS);
  the Docker image uses `node:20-slim`. Both are independent because each
  artifact ships/contains its own runtime.
- Keep `RUNTIME_EXTERNALS` in `scripts/package-release.mjs` in sync with the
  intersection of `artifacts/api-server/build.mjs` `external` list and the
  api-server's real `dependencies` — that's the set that must live in the
  bundle's `node_modules`.
