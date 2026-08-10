---
name: Release update check
description: How version stamping + the once-a-day GitHub release check work
---
- Version/repo are stamped at build time via esbuild `define` (`__APP_VERSION__`/`__APP_REPO__`) from env `APP_VERSION`/`APP_REPO`; release workflow sets them from the git tag + `github.repository` (both bundle jobs and Docker build-args). Runtime env vars override; unset → "dev" and check auto-disabled.
- **Why:** dev builds and tests have no defines, so code must guard with `typeof __APP_VERSION__ !== "undefined"` (esbuild replaces typeof correctly) and fall back to env.
- Check lives in api-server `lib/updateCheck.ts`: caches success 24h / failure 1h, dedupes concurrent callers on an inflight promise, never throws; opt-out `UPDATE_CHECK_DISABLED=1|true|yes`. Exposed via unauthenticated `GET /api/version`; Settings shows an About footer (`AboutSection` in Settings.tsx).
- **How to apply:** unparseable versions (e.g. "dev", prerelease suffixes) never flag an update — keep tags plain `vX.Y.Z`.
