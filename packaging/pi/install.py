#!/usr/bin/env python3
"""Tachboard Pi edition installer. Run as the desktop user, never as root."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import shutil
import socket
import subprocess
import sys
import time

from config import atomic_write, autostart_text, kiosk_unit, paths, server_unit, validate_url
from kiosk import reachable

SOURCE = Path(__file__).resolve().parent
SERVER = "tachboard-pi-server.service"
KIOSK = "tachboard-pi-kiosk.service"


def run(*args):
    subprocess.run(args, check=True)


def systemctl(*args):
    run("systemctl", "--user", *args)


def load_config(p):
    return json.loads(p["config"].read_text()) if p["config"].exists() else None


def platform_check():
    if sys.platform != "linux" or platform.machine() not in ("aarch64", "arm64"):
        raise ValueError("Install on a 64-bit ARM Raspberry Pi, not this platform.")
    release = platform.freedesktop_os_release()
    if release.get("VERSION_CODENAME") != "trixie":
        raise ValueError("This installer targets Raspberry Pi OS Desktop Trixie (64-bit).")
    if not shutil.which("labwc"):
        raise ValueError("labwc desktop is required. Raspberry Pi OS Lite is not supported.")
    browser = shutil.which("chromium") or shutil.which("chromium-browser")
    if not browser:
        raise ValueError("Chromium is missing. Install it first: sudo apt install chromium")
    if os.geteuid() == 0:
        raise ValueError("Run as the normal desktop user, not root or sudo.")
    if not shutil.which("systemctl"):
        raise ValueError("systemd is required.")
    return browser


def bundle_check(bundle):
    for name in ("bin/node", "server/index.mjs", "frontend-dist/index.html", "node_modules"):
        if not (bundle / name).exists():
            raise ValueError(f"Missing {name} in ARM64 bundle: {bundle}")
    # Catches wrong architecture, missing loader, and glibc incompatibility.
    run(str(bundle / "bin/node"), "--version")
    run(str(bundle / "bin/node"), "--input-type=module", "-e",
        "import {createRequire} from 'node:module';"
        "const r=createRequire(process.argv[1]+'/package.json');"
        "const DB=r('better-sqlite3');const d=new DB(':memory:');"
        "d.prepare('select 1').get();d.close();await r('sharp')"
        "({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer();",
        str(bundle))


def available_port(port, old):
    if old and old["mode"] == "standalone" and old["port"] == port:
        return
    with socket.socket() as sock:
        try:
            sock.bind(("0.0.0.0", port))
        except OSError as exc:
            raise ValueError(f"Port {port} is occupied; choose --port with an unused port.") from exc


def install(args, p):
    if args.mode == "remote":
        if not args.url:
            raise ValueError("Remote mode requires --url https://your-server:port/")
        url = validate_url(args.url, args.allow_http)
    else:
        if args.url:
            raise ValueError("--url is only for remote mode.")
        if not 1024 <= args.port <= 65535:
            raise ValueError("Choose a port between 1024 and 65535.")
        url = f"http://127.0.0.1:{args.port}/"
    old = load_config(p)
    print(json.dumps({"mode": args.mode, "url": url, "data": str(p["data"]),
                      "existing_mode": old["mode"] if old else None,
                      "enable_server_at_boot": args.enable_boot}, indent=2))
    if args.dry_run:
        print("Dry run only: no platform checks, services, or files changed.")
        return
    browser = platform_check()
    subprocess.run(["systemctl", "--user", "show-environment"], check=True, stdout=subprocess.DEVNULL)
    if old:
        print("Reconfiguration stops the Pi's existing managed services. Stored data is retained.")
    if not args.yes and input("Install/reconfigure this Pi? [y/N] ").strip().lower() != "y":
        raise ValueError("Cancelled; nothing changed.")
    bundle = Path(args.bundle).resolve() if args.bundle else SOURCE / "bundle"
    if args.mode == "standalone":
        available_port(args.port, old)
        bundle_check(bundle)
    elif args.enable_boot:
        raise ValueError("--enable-boot is only for the standalone server.")
    previous = p["autostart"].read_text() if p["autostart"].exists() else ""
    updated_autostart = autostart_text(previous, p["runtime"])
    if p["current"].exists() and not p["current"].is_symlink():
        raise ValueError(f"Refusing to replace unmanaged directory: {p['current']}")
    if not old and any((p["units"] / unit).exists() for unit in (SERVER, KIOSK)):
        raise ValueError("Existing Pi service files lack a managed config; inspect them before installing.")
    # Build new program files before stopping any existing server.
    p["root"].mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(p["root"], 0o700)
    destination = None
    if args.mode == "standalone":
        digest = hashlib.sha256((bundle / "server/index.mjs").read_bytes()).hexdigest()[:16]
        # Keep previous versions for deliberate recovery; no automatic data rollback.
        destination = p["root"] / "releases" / (digest + "-" + str(time.time_ns()))
        shutil.copytree(bundle, destination, symlinks=True)
    if old:
        if (p["units"] / KIOSK).exists():
            systemctl("stop", KIOSK)
        if (p["units"] / SERVER).exists():
            systemctl("disable", "--now", SERVER)
    if destination:
        temporary = p["root"] / "next"
        if temporary.exists() or temporary.is_symlink():
            raise ValueError(f"Remove unexpected staging path before retrying: {temporary}")
        temporary.symlink_to(destination, target_is_directory=True)
        temporary.replace(p["current"])
        p["data"].mkdir(mode=0o700, exist_ok=True)
        atomic_write(p["units"] / SERVER, server_unit(p, args.port))
    else:
        # Remote-only mode must never start a local server.
        (p["units"] / SERVER).unlink(missing_ok=True)
    p["runtime"].mkdir(parents=True, exist_ok=True)
    for name in ("config.py", "kiosk.py", "offline.html", "install.py"):
        if SOURCE != p["runtime"]:
            shutil.copyfile(SOURCE / name, p["runtime"] / name)
    atomic_write(p["units"] / KIOSK, kiosk_unit(p))
    if p["autostart"].exists() and not p["autostart"].with_suffix(".pre-tachboard").exists():
        shutil.copyfile(p["autostart"], p["autostart"].with_suffix(".pre-tachboard"))
    atomic_write(p["autostart"], updated_autostart, 0o700)
    config = {"mode": args.mode, "url": url, "port": args.port,
              "browser": browser, "kiosk_enabled": True}
    atomic_write(p["config"], json.dumps(config, indent=2) + "\n")
    systemctl("daemon-reload")
    if args.mode == "standalone":
        if args.enable_boot:
            # Explicit opt-in: lingering lets this user's services run before login.
            run("sudo", "loginctl", "enable-linger", pwd.getpwuid(os.getuid()).pw_name)
        systemctl("enable", "--now", SERVER)
        for _ in range(30):
            if reachable(url):
                break
            time.sleep(1)
        else:
            raise ValueError("Server did not become healthy. Inspect: journalctl --user -u tachboard-pi-server -n 80. Data was retained.")
    if os.environ.get("WAYLAND_DISPLAY"):
        run("/usr/bin/python3", str(p["runtime"] / "kiosk.py"), "--session")
    print("Installed. Log in to the labwc desktop to start the kiosk.")
    print("For boot-to-kiosk, enable Desktop Autologin in sudo raspi-config. Register your owner account first.")
    print(f"Dashboard: {url}")
    if args.mode == "standalone":
        print(f"LAN access: http://<pi-address>:{args.port}/ (keep on trusted LAN)")


def manage(args, p):
    config = load_config(p)
    if not config:
        raise ValueError("No Pi installation found for this user.")
    if args.action == "status":
        print(json.dumps(config, indent=2))
        run("systemctl", "--user", "--no-pager", "status",
            KIOSK, *([SERVER] if config["mode"] == "standalone" else []))
        return
    if args.action == "uninstall" and not args.yes:
        if input("Remove Pi services and kiosk startup (keep all data)? [y/N] ").lower() != "y":
            return
    config["kiosk_enabled"] = False
    atomic_write(p["config"], json.dumps(config, indent=2) + "\n")
    previous = p["autostart"].read_text() if p["autostart"].exists() else ""
    atomic_write(p["autostart"], autostart_text(previous, p["runtime"], enable=False), 0o700)
    if (p["units"] / KIOSK).exists():
        systemctl("stop", KIOSK)
    if args.action == "uninstall":
        if (p["units"] / SERVER).exists():
            systemctl("disable", "--now", SERVER)
        for unit in (KIOSK, SERVER):
            (p["units"] / unit).unlink(missing_ok=True)
        systemctl("daemon-reload")
        print("Services removed. Data, browser profile, config, and release files retained at", p["root"])
        print("User lingering was not disabled: other user services may depend on it.")
    else:
        print("Kiosk disabled; local server (if present) is unchanged. Run install again to re-enable.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    setup = commands.add_parser("install")
    setup.add_argument("--mode", choices=("standalone", "remote"), required=True)
    setup.add_argument("--url")
    setup.add_argument("--port", type=int, default=20028)
    setup.add_argument("--bundle", help="Already extracted trusted linux-arm64 bundle")
    setup.add_argument("--allow-http", action="store_true")
    setup.add_argument("--enable-boot", action="store_true")
    setup.add_argument("--dry-run", action="store_true")
    setup.add_argument("--yes", action="store_true")
    commands.add_parser("status")
    commands.add_parser("disable-kiosk")
    remove = commands.add_parser("uninstall")
    remove.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    try:
        if args.action == "install":
            install(args, paths())
        else:
            if os.geteuid() == 0:
                raise ValueError("Run as the desktop user, not root.")
            manage(args, paths())
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()