"""Shared Pi configuration helpers (standard library only)."""
import json
import os
from pathlib import Path
import re
import shlex
from urllib.parse import urlsplit

BEGIN = "# BEGIN TACHBOARD PI"
END = "# END TACHBOARD PI"


def paths(home=None):
    home = Path(home or Path.home())
    root = home / ".local/share/tachboard-pi"
    return {
        "root": root, "config": root / "config.json", "data": root / "data",
        "current": root / "current", "runtime": root / "runtime",
        "units": home / ".config/systemd/user",
        "autostart": home / ".config/labwc/autostart",
    }


def validate_url(value, allow_http=False):
    if not value or any(ord(c) < 33 or ord(c) == 127 for c in value):
        raise ValueError("URL must not contain whitespace or control characters.")
    parsed = urlsplit(value)
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise ValueError("Use a complete http:// or https:// dashboard URL.")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Do not put credentials in the dashboard URL.")
    if parsed.query or parsed.fragment or "\\" in value:
        raise ValueError("Use the dashboard base URL without a query or fragment.")
    # Accessing port also validates its range and syntax.
    _ = parsed.port
    if parsed.scheme == "http" and not allow_http:
        raise ValueError("HTTP exposes login traffic. Use HTTPS or explicitly pass --allow-http on a trusted LAN.")
    return value


def atomic_write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    # Never follow a pre-existing temporary symlink.
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def unit_quote(value):
    # systemd performs specifier and environment expansion even inside quotes.
    return json.dumps(str(value).replace("%", "%%").replace("$", "$$"))


def autostart_text(previous, runtime, enable=True):
    if previous.count(BEGIN) != previous.count(END) or previous.count(BEGIN) > 1:
        raise ValueError("Malformed Tachboard autostart block; repair it before continuing.")
    cleaned = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", previous, flags=re.S)
    if not enable:
        return cleaned
    if not cleaned.strip():
        # A user file overrides labwc's system file; retain the desktop defaults.
        cleaned = '#!/bin/sh\n[ ! -f /etc/xdg/labwc/autostart ] || . /etc/xdg/labwc/autostart\n'
    return cleaned.rstrip() + "\n\n" + BEGIN + "\n" + (
        "/usr/bin/python3 " + shlex.quote(str(runtime / "kiosk.py")) + " --session &\n"
    ) + END + "\n"


def server_unit(p, port):
    return f"""[Unit]
Description=Tachboard Pi server
After=network.target

[Service]
Type=simple
WorkingDirectory={unit_quote(p['current'])}
Environment=NODE_ENV=production
Environment=PORT={port}
Environment={unit_quote('DATA_DIR=' + str(p['data']))}
Environment={unit_quote('FRONTEND_DIST=' + str(p['current'] / 'frontend-dist'))}
ExecStart={unit_quote(p['current'] / 'bin/node')} --enable-source-maps {unit_quote(p['current'] / 'server/index.mjs')}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
"""


def kiosk_unit(p):
    return f"""[Unit]
Description=Tachboard Pi kiosk
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/bin/python3 {unit_quote(p['runtime'] / 'kiosk.py')}
Restart=always
RestartSec=5
KillMode=control-group
UMask=0077
"""