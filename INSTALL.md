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
  ghcr.io/OWNER/REPO:latest
```

Or with the repo's `docker-compose.yml`: `docker compose up -d`
(optionally copy `.env.example` → `.env` first). Data dir: the `/data`
volume. On TrueNAS SCALE, add it as a Custom App with the same image, port,
and a host-path or ix-volume mounted at `/data`.

## Windows (x64) — no Docker, no Node needed

1. Download `tachboard-windows-x64.zip` from the release page.
2. (Recommended) Right-click the zip → Properties → check **Unblock** → OK.
3. Extract it anywhere (e.g. `C:\Tachboard`) and run **start.bat**.
4. If SmartScreen appears ("Windows protected your PC"): **More info →
   Run anyway**. The bundle is not code-signed — see RELEASE.md for why.

Data dir: the `data` folder next to `start.bat` (override with the
`DATA_DIR` environment variable; `PORT` overrides the port).

## macOS (Apple Silicon or Intel) — no Docker, no Node needed

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
