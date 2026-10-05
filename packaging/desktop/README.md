# Desktop launcher companion (preview)

This outbound-only companion lets the **instance owner's** Tachboard tiles open
locally approved applications on a signed-in Windows, macOS, or Linux desktop.
The same code works with a Pi-hosted Tachboard and with TrueNAS-hosted Tachboard
plus a Pi kiosk. It never launches on the server/Pi unless that machine is itself
explicitly paired as a desktop. No inbound desktop listener/firewall port is needed.

This is source distribution, not a signed native installer. Obtain the
`packaging/desktop` directory from **the same trusted source checkout/archive as
your server**. Copy that directory onto each desktop; no Tachboard server,
Node.js, compiler, or database is required there. No release publication is
needed. Verify the source/archive provenance before running it.

## Dependencies and first run

Python **3.10 or later**, the `requirements.txt` packages, and a working native
credential vault are required. The companion deliberately refuses plaintext
keyring backends. No administrator/root privileges are needed to run it.

Run from a terminal opened in your signed-in graphical desktop, not a system
service, SSH-only session, root shell, or Windows Administrator terminal.
Background apps remain open when the companion stops.

### Windows 10/11

Install Python for your user from python.org (or an existing trusted Python).
In a **non-Administrator PowerShell** in the copied folder:

```powershell
py -3 -m pip install --user -r requirements.txt
notepad "$HOME\.tachboard-actions.json"
```

Example config (adjust to the actual installed executable):

```json
{"actions":[{"id":"notepad","name":"Notepad","executable":"C:\\Windows\\System32\\notepad.exe","args":[]}]}
```

```powershell
py -3 companion.py check
py -3 companion.py pair --server https://tachboard.example.net --name "Office PC"
py -3 companion.py run
```

Credentials go in Windows Credential Manager. Only `.exe` actions are allowed;
`.bat`, `.cmd`, shortcuts and script associations are not executed.

### macOS

Use a supported Python from python.org or your existing package manager. If your
Python disallows user packages, install dependencies in a user-owned Python
environment according to that distribution's instructions (do not use sudo pip).
In Terminal in the copied folder:

```sh
python3 -m pip install --user -r requirements.txt
```

Save `~/.tachboard-actions.json`:

```json
{"actions":[{"id":"calculator","name":"Calculator","app":"/System/Applications/Calculator.app"}]}
```

```sh
chmod 600 ~/.tachboard-actions.json
python3 companion.py check
python3 companion.py pair --server https://tachboard.example.net --name "Mac"
python3 companion.py run
```

Approve Keychain access when prompted by macOS. The `.app` adapter invokes
`/usr/bin/open -a` with the fixed local path, without a shell. Absolute executable
paths with fixed `args` are also supported.

### Linux desktop

Use your distribution's Python 3 and `python3-keyring` (25.x) package, plus a
running/unlocked Secret Service such as GNOME Keyring. On distributions permitting
user pip installs, `python3 -m pip install --user -r requirements.txt` also works.
If packages are missing, ask the machine administrator to install them; the
companion itself must run as the ordinary desktop user. Do not configure a
plaintext keyring fallback. A headless server is not a graphical desktop.

Save `~/.tachboard-actions.json` (adjust executable to your installed app):

```json
{"actions":[{"id":"editor","name":"Text Editor","executable":"/usr/bin/gedit","args":[]}]}
```

```sh
chmod 600 ~/.tachboard-actions.json
python3 companion.py check
python3 companion.py pair --server https://tachboard.example.net --name "Linux desktop"
python3 companion.py run
```

Run from your graphical session so DISPLAY/WAYLAND_DISPLAY and the session D-Bus
are present. This version does not install autostart, a daemon, or a tray.

## Trusted transport: choose before pairing

**Never use plain HTTP across the LAN for desktop control.** The client refuses
it before sending a code/token. Browser launcher UI is disabled on non-loopback
HTTP. Do not disable TLS checks, use `-k`, or set global trust-proxy merely to make
this feature work. Existing dashboard authentication remains required.

### Recommended: HTTPS reverse proxy

Use a dedicated HTTPS hostname with a trusted certificate (public CA, or a
private CA installed on all browsers and desktops). Forward to Tachboard's
existing server port. The backend port must be accessible **only by the proxy**;
firewall it, bind it locally, or use a private container network as appropriate.
Set these variables on the Tachboard server, not the desktop:

```text
LAUNCHER_HTTPS_ORIGIN=https://tachboard.example.net
LAUNCHER_TRUSTED_PROXY_IP=<exact proxy peer address as seen by Node's socket>
```

The IP must be a single exact address, not a subnet or `*`; IPv4 may be represented
as `::ffff:127.0.0.1`. Do not guess it or trust arbitrary forwarded IP headers.
The proxy must **overwrite** Host to the public hostname and X-Forwarded-Proto to
`https`, not append or pass client-provided values. Example nginx location inside
your already configured TLS virtual host:

```nginx
location / {
    proxy_pass http://127.0.0.1:20028;
    proxy_set_header Host tachboard.example.net;
    proxy_set_header X-Forwarded-Proto https;
}
```

Use the actual backend port. Serve the dashboard itself at the same HTTPS origin;
an insecure dashboard could steal the owner's login even if the desktop uses TLS.
Tachboard checks socket peer, Host, forwarding scheme, and browser Origin for
launcher routes only; it does not weaken global authentication or TLS validation.
An incorrectly configured proxy produces a visible HTTP 426, not an insecure fallback.

- **Pi-hosted mode:** configure the proxy on the Pi or another trusted LAN host,
  and point both the Pi kiosk and desktop at its HTTPS hostname. Use the existing
  [Pi installer](../pi/README.md); this feature does not change it.
- **TrueNAS-hosted mode:** configure the same proxy in front of the Tachboard
  container (keep its raw port private). Point the Pi kiosk and desktop at the
  TrueNAS instance's HTTPS hostname. Do not run a second server on the Pi for
  pairing; that would be a different instance.
- **Private CA:** trust it in the browser and OS; Python can additionally use
  `pair --ca /absolute/path/to/trusted-ca.pem`. This path is saved with credentials.
  Verification is still mandatory. Re-pair after intentionally changing origin.

### Alternative: SSH encrypted tunnels

If HTTPS is not yet available, an authenticated SSH tunnel with a verified host
key can carry local HTTP through encryption. On each client (desktop and kiosk):

```sh
ssh -N -L 127.0.0.1:20029:127.0.0.1:20028 your-user@your-server
```

Verify the SSH server fingerprint out-of-band; never disable host key checks.
Keep the tunnel running, browse `http://127.0.0.1:20029`, and pair using
`--server http://127.0.0.1:20029`. Use the same origin thereafter. Do not bind the
tunnel to `0.0.0.0` or expose its local port to your LAN. This works identically
with the Pi server or a TrueNAS host that already permits authorized SSH and can
reach the Tachboard backend. SSH setup/access policy remains the administrator's
responsibility. The HTTP allowance requires the request's **actual socket peer
and Host to be loopback**, with a loopback browser Origin; it is not a LAN exception.

## Pair, launch, stop, recover

1. Sign in as the instance owner (earliest account) and open Settings → Desktop
   computers. Create a pairing invitation. It expires in two minutes, replaces
   any older invitation, and can be used only once.
2. On the target computer, configure only applications you approve. Run `pair`.
   Paste the code at the hidden local prompt. Verify the displayed server origin,
   instance ID and dashboard owner against Settings, inspect the actions, and type
   `APPROVE`. Codes are not command-line arguments or stored in config.
3. Start `run`. In Settings, name the device and confirm it shows online.
4. Add a Desktop Launcher tile, select the computer and one of its approved
   actions, then save. Tapping the launch button displays pending, accepted,
   failure, expiry, or offline status. **Accepted means the one-shot request was
   accepted for launch—not proof that a window opened or the application finished
   starting.** Some OS launches can fail after acceptance.
5. Stop with Ctrl+C; status becomes offline within eight seconds. Restart with
   `run`. Pending work is discarded on reconnect, never replayed.
6. Revoke from Settings to block future authorizations immediately. Already
   authorized/running processes cannot be recalled or terminated. Delete local
   credentials with `python3 companion.py forget` (`py -3` on Windows). Forget
   alone is not server revocation. To switch servers, revoke and forget, then pair
   explicitly; or use a different `--config` path for a separate profile.

Action configuration is re-read each poll and immediately before execution.
Removing an action disables its tiles; changing its ID is treated as removal and
addition. Edit the local file atomically and keep it private to your user.
Only friendly names/IDs leave the desktop, not executable paths or arguments.
No shell expansion, dashboard-provided arguments, app discovery, elevation,
streaming, wake-on-LAN, or USB support is included.

**A logged-in physical kiosk can invoke its account's authorized actions.**
Pair only with a server and account you trust, secure physical access, and lock
or sign out of unattended kiosks. Other dashboard accounts cannot list, pair,
rename, revoke, or send commands in this version.

## Protocol and operational boundaries

- Random 256-bit invitation and device tokens, token hashes only on server disk;
  credentials in the desktop's native vault, scoped to exact origin and random
  persistent server instance ID. Never copy a paired server database into a
  second live instance: that is a clone of its identity. For an intentionally
  independent restore, stop the clone and remove its launcher tables' contents
  (commands, devices, then instance row), then restart and re-pair. Do not do this
  on a running original server.
- Companion-initiated polling; one active session per device. A new session
  cancels outstanding work. Commands expire after four seconds, one pending per
  device, 60 new commands/minute per server. Invitations: five/minute; inspection/
  approval: twenty attempts/minute globally, so spoofed forwarding headers do not
  bypass limits. At most twenty active computers and fifty local actions each.
- Server performs revocation, ownership, session, action and expiry checks at
  authorization time. Each request ID is consumed at most once; response loss
  fails closed rather than re-launching. Companion uses a monotonic deadline
  derived from the server's remaining TTL, not synchronized desktop clocks.
- Request IDs/statuses are retained in SQLite to prevent duplicates across server
  restarts. At 100,000 commands, new requests fail explicitly rather than deleting
  deduplication history. There is no automatic pruning; plan server storage and
  maintenance before high-volume unattended use. Profiles/exports never include
  companion tokens or pairing invitations. Imported tiles always lose launcher
  bindings—even importing back to the same instance—and require explicit selection.
- Back up the server database securely; it contains identity and token hashes.
  OS-vault backup/availability is OS-specific. Losing credentials requires revoke
  and re-pair. Lost approval responses may leave a device listed but unpaired
  locally: revoke that entry before trying again.

## Verification scope

Automated protocol/adapter tests run with disposable databases and simulated
desktop actions. Run them with:

```sh
pnpm --filter @workspace/api-server exec vitest run src/lib/launcher.test.ts
python3 -m unittest discover -s packaging/desktop -p 'test_*.py' -v
```

Tests of process spawning use an inert local Python child, not a real GUI app.
Windows/macOS adapter selection can be checked on Linux but that is **not** a
native OS smoke check. Real Windows/macOS/Linux graphical sessions, OS-vault
prompts, actual Pi hardware/boot/display, and physical TrueNAS/Pi networking
must still be checked on the target machines. No real device configuration or
release publication is performed by this change.
