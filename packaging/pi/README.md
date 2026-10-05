# Tachboard Pi edition

One download, two modes:

| Mode | Dashboard server | Pi display |
| --- | --- | --- |
| Standalone | Runs on the Pi; no TrueNAS or Docker required | Opens its local server |
| Remote kiosk | Your existing TrueNAS or other Tachboard server | Opens that server's URL |

Standalone and TrueNAS installations can coexist on the same network. Each
server has its own database. Point all your displays at the same server if
you want the same dashboard; there is no automatic data synchronization.

## Supported baseline

- Raspberry Pi 4 or 5, **64-bit Raspberry Pi OS Desktop Trixie**, labwc/Wayland.
- A screen (touchscreen optional), power supply, and network connection.
- Python 3, Chromium, systemd, and enough storage for the bundle plus your data.
- Use the normal desktop account, **not root**. This is not an OS image and
  does not install or replace Linux.

Bookworm and 32-bit OS releases are deliberately rejected: native server
dependencies are built on Ubuntu 24.04 ARM64 and may need newer glibc than
Bookworm supplies. Pi OS Lite, X11 desktops, and other boards are not part
of the initial supported baseline.

The installer and lifecycle are covered by portable automated tests.
Real Pi boot, touchscreen, display power management, and native hardware
performance still require hardware verification; this is an initial test edition.

If missing, install prerequisites on the Pi:

```bash
sudo apt update
sudo apt install python3 chromium
```

## Download

After a release containing this feature is published, download
`tachboard-pi-arm64.tar.gz` and `tachboard-pi-arm64.tar.gz.sha256` from the
same [GitHub release](https://github.com/frictionindustries/TachBoard/releases).

For **testing** builds, use GitHub Actions → **Testing Docker image** →
the successful run → **Artifacts** → **pi-edition-testing**. Unzip that
artifact to obtain the tarball and checksum. This artifact is separate from
the TrueNAS testing Docker image and does not publish a stable release.

On the Pi, in the download directory:

```bash
sha256sum -c tachboard-pi-arm64.tar.gz.sha256
tar -xzf tachboard-pi-arm64.tar.gz
cd tachboard-pi
```

Only extract trusted release artifacts. The checksum detects corruption;
it is not a signature from an independent publisher.

## Option A: host on this Pi

```bash
python3 install.py install --mode standalone --enable-boot
```

This validates the bundled Node runtime and native dependencies, installs
the server under your user account, and starts it on port **20028**. The
explicit `--enable-boot` option runs `sudo loginctl enable-linger` for this
user so the server can start at boot without a desktop login.

- On the Pi: `http://127.0.0.1:20028/`
- From another LAN device: `http://<pi-address>:20028/`

Use `--port 20029` if port 20028 is already occupied. The kiosk URL follows
the chosen port. Register the first account yourself before sharing access;
that account owns private-network integrations. Keep the service on a trusted
LAN and do not forward this port to the internet. Use a trusted HTTPS reverse
proxy if the network is untrusted.

## Option B: use TrueNAS or another server

For an HTTPS server:

```bash
python3 install.py install --mode remote --url https://tachboard.example/
```

For your existing LAN-only TrueNAS test instance:

```bash
python3 install.py install --mode remote \
  --url http://192.168.1.100:20029/ --allow-http
```

Replace the address with your actual server. HTTP is an explicit opt-in
because it sends login traffic unencrypted. For HTTPS, use a certificate
trusted by both the Pi's system trust store and Chromium; certificate checking
is never disabled. Do not put passwords, tokens, or login links in the URL.

Remote mode never installs or starts a local Tachboard server. It does not
change anything on TrueNAS. Switching from standalone to remote stops only
the Pi's managed server and retains all of its data.

## Boot straight to the dashboard

Run `sudo raspi-config` and select **System Options → Boot / Auto Login →
Desktop Autologin** (wording can vary). Reboot after setup. The installer adds
a marked block to your user's labwc autostart file; existing commands are
preserved, and system desktop defaults are retained when creating a new file.

The server starts independently when lingering is enabled; the browser
starts only inside the desktop session. Without Desktop Autologin, the
kiosk starts after you log into the desktop manually.

For an always-on display, disable Screen Blanking in Raspberry Pi's desktop
settings or `raspi-config`. The installer does not override your display's
power settings or touch calibration.

The dedicated Chromium profile preserves your dashboard login. A signed-in
kiosk gives anyone with physical access the privileges of that account;
browser kiosk mode is not a security boundary.

Chromium restarts after a crash. When the dashboard is unreachable, a local
retry screen is shown; recovery reopens the dashboard without clearing the
browser profile. An outage may interrupt unsaved form edits.

## Exit, diagnose, disable, or uninstall

Use SSH as the same desktop user, or a local terminal (Ctrl+Alt+F2 opens a
text console on typical Pi OS setups). Enable SSH deliberately through Pi
settings if you want remote maintenance.

Temporarily stop the kiosk until the next desktop login:

```bash
systemctl --user stop tachboard-pi-kiosk
```

Do not just close Chromium: its supervisor will reopen it.

Commands available even after deleting the downloaded installer folder:

```bash
python3 ~/.local/share/tachboard-pi/runtime/install.py status
python3 ~/.local/share/tachboard-pi/runtime/install.py disable-kiosk
journalctl --user -u tachboard-pi-server -n 80
journalctl --user -u tachboard-pi-kiosk -n 80
```

To remove services and kiosk autostart, **while keeping data**:

```bash
python3 ~/.local/share/tachboard-pi/runtime/install.py uninstall
```

The installer never deletes your database, uploads, login secret, browser
profile, or previous installed versions. It also does not disable user
lingering, since other user services may depend on it.

## Change modes and update

Run either install command again from a freshly extracted Pi download. It
stops managed Pi services during reconfiguration, preserves data, and replaces
only its own autostart block. If run over SSH, log out and back into the
desktop afterward to resume the kiosk.

In standalone mode, stop the server and back up
`~/.local/share/tachboard-pi/data/` **before upgrading**. This folder contains
the SQLite database, uploaded files, and generated login secret. Keep backups
private. Restart after backup if you are not immediately upgrading.

```bash
systemctl --user stop tachboard-pi-server
# Copy the entire data directory to your private backup location while stopped.
```

Reinstalling an older Pi download selects that code version, but does not undo
database migrations. Restore a matching data backup when required. Previous
program files are retained in `~/.local/share/tachboard-pi/releases/`; remove
unused versions manually only after confirming the new version works.

Preview a configuration without writing anything:

```bash
python3 install.py install --mode standalone --dry-run
python3 install.py install --mode remote --url https://tachboard.example/ --dry-run
```

Updates are manual. This first deliverable does **not** include USB transport,
a flashable SD image, or the desktop companion for launching PC/Mac apps.
Those do not come from a browser kiosk alone.

## Development checks

From the repository root:

```bash
python3 -m unittest discover -s packaging/pi -p 'test_*.py' -v
```

Build the normal Linux ARM64 bundle and smoke-test it on an ARM64 runner,
then run `node scripts/package-pi.mjs release`. Both release and testing
workflows perform these steps before publishing the Pi artifact.

Reference: [Raspberry Pi's labwc kiosk guide](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/).