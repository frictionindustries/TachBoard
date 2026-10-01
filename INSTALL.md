# Installing Tachboard

Tachboard is a self-hosted dashboard: one server process, accessed from your
browser. Pick the option for your platform. In every case, after starting it
open **http://localhost:20028** (or `http://<host-ip>:20028` from another
device) and register your account on first run.

**What persists where (all platforms):** the SQLite database, uploaded
images, and the auto-generated auth secret live in the *data directory*.
Back it up; deleting it resets the app. If you don't set `JWT_SECRET`, a
strong random secret is generated on first run and saved to
`<data dir>/jwt-secret` so logins survive restarts.

---

## Linux / TrueNAS SCALE — Docker (recommended)

The image is multi-arch (`amd64` + `arm64`), so it runs on typical TrueNAS
hardware and ARM boxes alike.

```bash
docker run -d --name tachboard \
  -p 20028:20028 \
  -v tachboard-data:/data \
  --restart unless-stopped \
  ghcr.io/frictionindustries/tachboard:latest
```

Or with the repo's `docker-compose.yml`: `docker compose up -d`
(optionally copy `.env.example` → `.env` first). Data dir: the `/data`
volume.

**TrueNAS SCALE:** once the community catalog entry is merged
(`packaging/truenas/`), install from **Apps → Discover → Tachboard** — the
wizard sets up the port and the `/data` ixVolume for you. Until then, add it
as a **Custom App** with the same image, port `20028`, and a host-path or
ix-volume mounted at `/data`.

## macOS / Linux — Homebrew (one-liner)

```bash
brew install frictionindustries/tachboard/tachboard
tachboard            # or: brew services start tachboard
```

Data dir: `$(brew --prefix)/var/tachboard` (override with `DATA_DIR`).
Upgrades: `brew upgrade tachboard`. No Gatekeeper prompt — Homebrew
downloads aren't quarantined.

## Windows — winget (one-liner)

```powershell
winget install Tachboard.Tachboard
tachboard
```

winget extracts the portable bundle and puts a `tachboard` alias for
`start.bat` on your PATH. Data dir: the `data` folder next to the installed
bundle (override with `DATA_DIR`). Upgrades: `winget upgrade Tachboard.Tachboard`.

> Both one-liners become available once the tap/manifest submissions from
> `packaging/` are published — until then use the manual installs below.

## Windows (x64) — manual zip (no Docker, no Node needed)

1. Download `tachboard-windows-x64.zip` from the release page.
2. (Recommended) Right-click the zip → Properties → check **Unblock** → OK.
3. Extract it anywhere (e.g. `C:\Tachboard`) and run **start.bat**.
4. If SmartScreen appears ("Windows protected your PC"): **More info →
   Run anyway**. The bundle is not code-signed — see RELEASE.md for why.

Data dir: the `data` folder next to `start.bat` (override with the
`DATA_DIR` environment variable; `PORT` overrides the port).

## macOS (Apple Silicon or Intel) — manual tarball (no Docker, no Node needed)

1. Download `tachboard-macos-arm64.tar.gz` (Apple Silicon) or
   `tachboard-macos-x64.tar.gz` (Intel) from the release page.
2. Extract and clear the download quarantine once (the bundle is not
   notarized — see RELEASE.md):
   ```bash
   tar xzf tachboard-macos-arm64.tar.gz
   xattr -dr com.apple.quarantine tachboard-macos-arm64
   ```
3. Run it:
   ```bash
   cd tachboard-macos-arm64 && ./start.sh
   ```

Data dir: the `data` folder next to `start.sh` (`DATA_DIR` / `PORT`
environment variables override).

## Linux without Docker (x64 / arm64)

```bash
tar xzf tachboard-linux-x64.tar.gz
cd tachboard-linux-x64 && ./start.sh
```

To run it as a service, a minimal systemd unit:

```ini
[Unit]
Description=Tachboard
After=network.target

[Service]
ExecStart=/opt/tachboard/start.sh
Environment=DATA_DIR=/var/lib/tachboard
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## Reference

| Setting | Default | Notes |
|---|---|---|
| `PORT` | `20028` | Port the server listens on |
| `DATA_DIR` | `./data` next to launcher (bundles) / `/data` (Docker) | SQLite DB, uploads, jwt-secret |
| `JWT_SECRET` | auto-generated + persisted in `DATA_DIR/jwt-secret` | set your own to override |
| `UPLOADS_MAX_TOTAL_BYTES` | 5 GB | cap on total uploaded media |

Upgrading a bundle: stop the server, replace the bundle folder with the new
release, keep your data folder, start again. Upgrading Docker: pull the new
tag and recreate the container; the `/data` volume carries everything over.

## Resource limits (single-process homelab deployments)

These fixed safeguards require no environment settings or extra signup steps:

- **Accounts:** at most **32 stored users** can be registered. The quota is
  counted from SQLite, survives restarts, and is rechecked under a write
  transaction after password hashing. Account/default-page initialization is
  atomic. Existing accounts, including installations already above the limit,
  can still log in; no existing data is deleted.
- **Signup credentials:** username **3–64 UTF-16 code units**, password at least
  **6 UTF-16 code units** and at most **72 UTF-8 bytes** (bcrypt's effective
  limit). Names are not trimmed, lowercased, or otherwise normalized.
- **Legacy login:** nonempty string username/password, username at most
  **256 UTF-16 code units**, password at most **1024 UTF-8 bytes**. Old short
  credentials and bcrypt's historical 72-byte password truncation still work
  within these bounds. Previously accepted values beyond these limits are
  rejected; new signups cannot create silently truncated passwords.
- **Auth bodies:** login/register accept uncompressed JSON or URL-encoded
  `username`/`password` only, with a **4096-byte** body cap applied before the
  general **5 MiB** JSON parser. Form bodies allow only **2 parameters**.
  Compressed bodies and unsupported content types return HTTP 415; oversized
  bodies return 413 and invalid credentials/body shapes return 400.
- **Auth abuse protection:** login/register share fixed **60-second** windows:
  **30 requests per socket source / 120 globally**, and **10 bcrypt starts per
  source / 20 globally**. Only **2 bcrypt operations** may run concurrently;
  excess work is rejected, not queued. HTTP 429 includes `Retry-After`.
  Successes do not reset allowances. State is bounded to **1024 source
  buckets**, expired buckets are pruned, and live buckets are not evicted to
  make room for new sources. These request/CPU counters reset on server
  restart; the account quota does not.
- **Reverse proxies:** rate-limit identity is the TCP socket's remote address,
  never `X-Forwarded-For`, `X-Real-IP`, or Express's trusted-proxy IP. Clients
  behind the same proxy therefore intentionally share a source allowance.
  Global limits also cover attacks that rotate IPs. Keep the deployment to one
  server process for the documented CPU/request ceilings; multiple processes
  each have their own counters (the SQLite account quota remains shared).
- **Page/profile imports:** before schema parsing, each request is limited to
  **100 pages**, **500 total layouts**, and **4000 total tile entries**. Both
  tile copies in v2 exports count toward the total. Profile imports also allow
  at most **100 device modes** and **200 connections**, so profile import
  cannot bypass the page-import budget. Excess imports are rejected before
  database writes. Name collision allocation is amortized linear rather than
  repeated unbounded suffix searches.

These caps bound application work; they are not a substitute for network-level
connection/body-timeout limits or access controls when exposing a homelab to the
public internet.
