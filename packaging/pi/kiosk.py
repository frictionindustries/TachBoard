#!/usr/bin/env python3
"""labwc session bootstrap and connectivity-aware Chromium supervisor."""
import argparse
import json
import os
import signal
import subprocess
import time
from urllib.error import URLError
from urllib.request import urlopen

from config import paths


def reachable(url):
    try:
        with urlopen(url, timeout=4) as response:
            return 200 <= response.status < 400
    except (URLError, OSError, ValueError):
        return False


def browser_args(config, root, online):
    target = config["url"] if online else (root / "runtime/offline.html").as_uri()
    return [
        config["browser"], "--ozone-platform=wayland", "--kiosk",
        "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble",
        "--user-data-dir=" + str(root / "browser-profile"), target,
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", action="store_true")
    args = parser.parse_args()
    p = paths()
    config = json.loads(p["config"].read_text())
    if not config["kiosk_enabled"]:
        return
    if args.session:
        # Do not import the entire login environment (it may contain secrets).
        names = [key for key in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
                                  "DBUS_SESSION_BUS_ADDRESS") if key in os.environ]
        if names:
            subprocess.run(["systemctl", "--user", "import-environment", *names], check=True)
        subprocess.run(["systemctl", "--user", "restart", "tachboard-pi-kiosk.service"], check=True)
        return
    if not os.environ.get("WAYLAND_DISPLAY"):
        raise RuntimeError("No Wayland graphical session; start through labwc autostart.")
    browser = None
    last_online = None
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    def close_browser():
        if browser and browser.poll() is None:
            browser.terminate()
            try:
                browser.wait(timeout=8)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping:
            online = reachable(config["url"])
            if stopping:
                break
            if browser is None or browser.poll() is not None or online != last_online:
                close_browser()
                browser = subprocess.Popen(browser_args(config, p["root"], online))
                last_online = online
            # A lost connection shows a local retry page; recovery reopens the
            # dashboard with the same profile/session. Do not clear login data.
            for _ in range(10):
                if stopping:
                    break
                time.sleep(0.5)
    finally:
        close_browser()


if __name__ == "__main__":
    main()