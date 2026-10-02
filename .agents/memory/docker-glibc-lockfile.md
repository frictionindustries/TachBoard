---
name: Self-hosted Docker must use glibc base image
description: Preserve native dependencies for all release platforms and keep Docker on glibc
---

# Self-hosted Docker base image must be glibc, not Alpine

The original template excluded every platform-specific binary except Linux
glibc x64. This is not compatible with cross-platform releases: preserve the
native esbuild, Rollup, Lightning CSS, and Tailwind Oxide optional dependencies
for Linux x64/arm64 (glibc), macOS x64/arm64, and Windows x64.

**Why:** frozen installs cannot recover packages explicitly removed by overrides.
The first cross-platform release passed Linux x64 but failed every other bundle
and ARM Docker at missing Rollup modules. Fixing only Rollup would leave the
other native build tools missing next.

**How to apply:** keep Docker on Debian/glibc (`node:*-slim`) and align its Node
major with CI. Do not restore template exclusions for supported release targets.
Regenerate the lockfile after override changes, and check both package entries
and parent optional-dependency links for every target. Exclusions for unsupported
targets, including musl, may remain. Cross-platform execution still requires
the actual GitHub runners; a local Linux build alone is not proof.
