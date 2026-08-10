# Homebrew tap

`Formula/tachboard.rb.tmpl` wraps the self-contained macOS/Linux bundles in a
formula for a tap repo named `homebrew-tachboard` under the same GitHub owner.
Users then install with:

```bash
brew install __OWNER__/tachboard/tachboard
```

The formula installs the bundle into `libexec` untouched (it ships its own
Node runtime, so Gatekeeper quarantine never applies — Homebrew downloads
aren't quarantined), adds a `tachboard` launcher, defaults `DATA_DIR` to
`$(brew --prefix)/var/tachboard`, and provides a `brew services` definition.

## Publishing

The release workflow's `packaging` job renders the formula with the real
version + sha256s. If the `HOMEBREW_TAP_TOKEN` secret is set (a fine-grained
PAT with write access to `<owner>/homebrew-tachboard`), it commits
`Formula/tachboard.rb` to that tap automatically on every tag. Otherwise grab
the rendered formula from the `packaging-manifests` workflow artifact and
commit it to the tap by hand.

One-time setup: create an empty public repo `<owner>/homebrew-tachboard`
(the `homebrew-` prefix is what makes `brew tap <owner>/tachboard` work).
