# winget manifests

Templates for the `Tachboard.Tachboard` package wrapping the portable
`tachboard-windows-x64.zip` bundle (`NestedInstallerType: portable` — winget
extracts the zip and puts a `tachboard` alias for `start.bat` on PATH).
Users install with:

```powershell
winget install Tachboard.Tachboard
```

## Publishing

The release workflow's `packaging` job renders the three manifests with the
real version + sha256 into
`manifests/t/Tachboard/Tachboard/<version>/` inside the `packaging-manifests`
artifact. Submit them to https://github.com/microsoft/winget-pkgs by PR —
easiest with [wingetcreate](https://github.com/microsoft/winget-create):

```powershell
wingetcreate update Tachboard.Tachboard `
  --version <version> `
  --urls https://github.com/<owner>/<repo>/releases/download/v<version>/tachboard-windows-x64.zip `
  --submit
```

The first submission must be a manual PR (new package); winget moderators
also run SmartScreen checks — the zip is unsigned, which is allowed for
portable packages but can add review time (see RELEASE.md's signing note).
