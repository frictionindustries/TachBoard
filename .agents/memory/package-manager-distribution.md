---
name: Package-manager distribution
description: How Tachboard's Homebrew/winget/TrueNAS packaging templates are rendered and published
---

Templates live in `packaging/` with `__OWNER__`/`__REPO__`/`__VERSION__`/`__SHA_*__` placeholders; `scripts/render-packaging.mjs` renders them in the release workflow's `packaging` job (needs all five bundle archives — fails on any missing so manifests can't point at nonexistent assets).

**Rules:**
- New bundle targets must be added to `ARCHIVES` in render-packaging.mjs or the render fails.
- Homebrew formula auto-pushes to `<owner>/homebrew-tachboard` tap only when `HOMEBREW_TAP_TOKEN` secret exists; winget (Tachboard.Tachboard, portable zip) and TrueNAS (truenas/apps community train) are external PRs — steps in each packaging/*/README.md.
- winget locale manifest deliberately omits LicenseUrl (repo has no LICENSE file, only package.json "MIT").
- TrueNAS templates/docker-compose.yaml follows their v2 render library; must be re-validated against the exact `lib_version` at submission time.
**Why:** external catalogs can't be published from CI alone; the render step keeps checksums honest per tag.
