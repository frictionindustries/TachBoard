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

## Testing on TrueNAS with live data

The separate `.github/workflows/testing.yml` workflow runs on pushes to the
`testing` branch. It runs the API and Pi installer tests, then builds and publishes the
multi-arch Docker image (amd64 + arm64) and a separate ARM64 Pi installer
download named `pi-edition-testing` in the run's artifacts. It does not build Windows/macOS bundles,
create a GitHub Release, or update stable version tags or `latest`.

Published image references:

- `ghcr.io/frictionindustries/tachboard:testing` — most recently published test build.
- `ghcr.io/frictionindustries/tachboard:testing-<full-commit-sha>` — select a
  particular commit for testing or rollback. For an exact immutable image,
  use `ghcr.io/frictionindustries/tachboard@sha256:<digest>`.

The workflow's GitHub Actions summary lists the tags and image digest.
Rebuilding the same commit can refresh its commit tag, so keep the digest
when exact reproducibility matters.

### First-time setup

1. Commit the new workflow and configuration, then push those changes to a
   GitHub branch named `testing`. If that branch does not exist, create it
   from the commit you want to test. No release tag is needed.
2. Wait for **Actions → Testing Docker image** to finish successfully. The
   `testing` image does not exist until the first successful publication.
3. On TrueNAS SCALE 24.10+, create a **separate** dataset, for example
   `/mnt/tank/apps/tachboard-testing`.
4. Install a separate Custom App named `tachboard-testing` using
   [`packaging/truenas/testing-compose.yaml`](packaging/truenas/testing-compose.yaml).
   Replace its example host path with your dataset path. Leave the internal
   `/data` mount and port `20028` unchanged.
5. Open `http://<truenas-ip>:20029`, register your owner account first, then
   import your profile or configure your real service connections. Keep any
   export containing credentials private.

Never share the stable app's data directory with the test app. Test data,
accounts, and uploads must be separate. Both instances can read the same
live services, but service-changing actions (such as playback controls)
still affect those real services. Use read-only credentials where supported
and keep the test app on your LAN.

### Daily testing and rollback

1. Commit and push a batch of changes to `testing`.
2. Wait for the workflow to pass and publish.
3. In TrueNAS, explicitly pull/update the test app's image and redeploy it.
   The YAML uses `pull_policy: always` so Compose pulls when applying the
   configuration; merely restarting an existing container may reuse its old
   image. If your TrueNAS UI does not offer a pull/update action, edit the
   image to the new commit-specific tag from the workflow summary and save.
4. Test on port `20029`. Your stable app on `20028` stays unchanged.

Updates are manual, not scheduled. Snapshot the test dataset before trying
builds that might change the database. To roll back, edit the test app's
image to an earlier commit tag or digest and redeploy. An older image does
not undo database migrations; restore its matching dataset snapshot if needed.

When satisfied, merge the tested changes into `main` and follow the normal
release process below. A manual run of **Release** remains a dry run, not a
testing-image publication. **Testing Docker image** also supports manual
dispatch with the `testing` branch selected; runs on other branches skip
publication. GitHub only shows its manual Run workflow button after the
workflow file is present on the default branch.

## Pi edition downloads

The Linux ARM64 release job additionally packages `tachboard-pi-arm64.tar.gz`
and its SHA-256 file after the server bundle smoke test. These are attached
to tagged GitHub releases and uploaded as the `pi-edition` workflow artifact.
The Pi package reuses the same server code; it is not a separate fork.

The testing workflow creates `pi-edition-testing` without a GitHub Release.
See [the Pi guide](packaging/pi/README.md) for standalone and remote-kiosk
installation. Neither pipeline configures hardware or updates running Pis.

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

## Package-manager distribution

The `packaging` job in the release workflow renders `packaging/`'s templates
(via `scripts/render-packaging.mjs`) with the tag's version and the sha256 of
every bundle, and uploads them as the `packaging-manifests` artifact:

- **Homebrew** (`packaging/homebrew/`) — formula wrapping the macOS/Linux
  tarballs. Auto-pushed to the `<owner>/homebrew-tachboard` tap on each tag
  when the `HOMEBREW_TAP_TOKEN` secret is set; otherwise commit the rendered
  formula manually. Install: `brew install <owner>/tachboard/tachboard`.
- **winget** (`packaging/winget/`) — portable-zip manifests for
  `Tachboard.Tachboard`. Each version is a PR to microsoft/winget-pkgs
  (first one manual; afterwards `wingetcreate update --submit`).
- **TrueNAS SCALE** (`packaging/truenas/`) — community catalog entry for
  truenas/apps pointing at the GHCR image with the `/data` volume. Submitted
  and version-bumped by PR to their repo.

Each subdirectory's README.md has the exact submission steps. New bundle
targets must be added to `ARCHIVES` in `scripts/render-packaging.mjs` (the
render fails if any archive is missing, so a dropped target can't silently
ship stale manifests).

## Version support notes

- Bundles pin Node via `NODE_VERSION` in the workflow (currently 22 LTS);
  the Docker image uses `node:20-slim`. Both are independent because each
  artifact ships/contains its own runtime.
- Keep `RUNTIME_EXTERNALS` in `scripts/package-release.mjs` in sync with the
  intersection of `artifacts/api-server/build.mjs` `external` list and the
  api-server's real `dependencies` — that's the set that must live in the
  bundle's `node_modules`.
