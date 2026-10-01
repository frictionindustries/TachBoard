---
name: Cross-platform release pipeline
description: How Tachboard release bundles are built and the invariants that keep native modules working
---

- Release = tag `v*` → GitHub Actions: multi-arch Docker image to GHCR (amd64+arm64, primary Linux/TrueNAS path) + self-contained bundles for windows-x64, macos-arm64/x64, linux-x64/arm64.
- Bundles are packaged ON each target OS runner (never cross-compiled): stage = esbuild server output + frontend build + `npm install` of the runtime externals (better-sqlite3, sharp, gamedig, isomorphic-dompurify) pinned to workspace-resolved versions + a copy of `process.execPath` as `bin/node` so runtime ABI always matches the installed native binaries.
- **Why:** better-sqlite3/sharp binaries are OS+arch+ABI specific; shipping the exact Node binary the install ran under eliminates every "wrong binary" class of failure.
- **How to apply:** if a new externalized package appears in api-server `dependencies`, add it to `RUNTIME_EXTERNALS` in `scripts/package-release.mjs` or bundles crash at import. Smoke test (`scripts/smoke-test-bundle.mjs`) is the release gate: native probe + healthz + frontend + register/login + jwt-secret persistence.
- Signing decision: ship UNSIGNED; documented bypasses (macOS `xattr -dr com.apple.quarantine`, Windows SmartScreen "Run anyway") in INSTALL.md/README.txt; signing steps slot in between Package and Smoke test if ever adopted.
- ESM resolution makes stage-root node_modules visible to server/index.mjs automatically; FRONTEND_DIST must be set explicitly by the launcher (relative fallback path doesn't match bundle layout).
- Security floors for runtime externals must also reach the standalone npm install; pnpm workspace overrides do not apply there.
  **Why:** fixing the workspace lockfile alone can leave downloaded release bundles with vulnerable transitive packages.
  **How to apply:** review the standalone dependency tree when adding security overrides and carry applicable floors into its package manifest.
