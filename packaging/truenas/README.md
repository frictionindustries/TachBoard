# TrueNAS SCALE community app catalog entry

`tachboard/` is a catalog entry for the [truenas/apps](https://github.com/truenas/apps)
community train (SCALE 24.10+ app format). It runs the multi-arch GHCR image
with the persistent `/data` volume (ixVolume by default, host path optional)
and exposes the WebUI on port 20028.

Files use `__OWNER__`/`__REPO__`/`__VERSION__` placeholders; the release
workflow renders concrete copies into the `packaging-manifests` artifact via
`scripts/render-packaging.mjs`.

## Submitting / updating

1. Fork https://github.com/truenas/apps.
2. Copy the **rendered** `tachboard/` directory to `ix-dev/community/tachboard/`.
3. Check the library version: set `lib_version` in `app.yaml` to the newest
   `library/2.x.x` in the truenas/apps repo and re-run their
   `python3 tools/render.py` (it fills `lib_version_hash`). The
   `templates/docker-compose.yaml` here follows their v2 render library
   conventions but must be validated against the exact library version.
4. Run their test suite: `python3 tools/test.py --app tachboard --train community`.
5. Open a PR. On later releases, bump `app_version` + image `tag` and increment
   the catalog `version` field (semver of the catalog entry itself).

Until the catalog PR is merged, TrueNAS users can install Tachboard as a
**Custom App** with the same image/port/volume — documented in INSTALL.md.
