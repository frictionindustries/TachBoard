#!/usr/bin/env python3
"""Tachboard outbound-only desktop companion. Python 3.10+, keyring 25.x."""
import argparse
import ctypes
import getpass
import hashlib
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SERVICE = "Tachboard Desktop Companion v1"
MAX_RESPONSE = 65536


def server_url(value):
    u = urllib.parse.urlsplit(value)
    if (u.username or u.password or u.query or u.fragment or u.path not in ("", "/")
            or not u.hostname):
        raise ValueError("Use a server origin without credentials, path, query, or fragment")
    if u.scheme != "https" and not (u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("HTTPS is required. HTTP is only allowed for a local SSH tunnel.")
    return value.rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Redirect refused; use the exact trusted server origin")


class Transport:
    def __init__(self, server, credentials=None, ca=None):
        self.server = server_url(server)
        self.credentials = credentials
        # Explicit trust roots supported; certificate/hostname checks stay on.
        context = ssl.create_default_context(cafile=ca)
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect(),
            urllib.request.HTTPSHandler(context=context))

    def call(self, route, body=None):
        headers = {"Content-Type": "application/json"}
        if self.credentials:
            if self.credentials["server"] != self.server:
                raise ValueError("Credentials belong to another server origin")
            headers["Authorization"] = "Bearer " + self.credentials["token"]
            headers["X-Launcher-Instance"] = self.credentials["instanceId"]
        request = urllib.request.Request(self.server + "/api/launcher/" + route,
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers=headers)
        with self.opener.open(request, timeout=3) as response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise ValueError("Server response too large")
            return json.loads(data)


def vault():
    import keyring
    backend = keyring.get_keyring()
    # Refuse plaintext, null, fallback/chained or third-party backends. Keyring
    # selects a native backend only if its OS credential store is usable.
    allowed = {
        "keyring.backends.Windows.WinVaultKeyring",
        "keyring.backends.macOS.Keyring",
        "keyring.backends.SecretService.Keyring",
    }
    name = type(backend).__module__ + "." + type(backend).__name__
    if name not in allowed:
        raise RuntimeError("No supported secure OS vault. Enable Windows Credential Manager, macOS Keychain, or Linux Secret Service.")
    return backend


def account(config):
    return hashlib.sha256(str(config.resolve()).encode()).hexdigest()


def load_actions(config):
    if config.stat().st_size > 65536:
        raise ValueError("Action configuration is too large")
    raw = json.loads(config.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or set(raw) != {"actions"} or not isinstance(raw["actions"], list):
        raise ValueError('Config must contain an "actions" array')
    if len(raw["actions"]) > 50:
        raise ValueError("At most 50 actions are supported")
    import re
    actions = {}
    for item in raw["actions"]:
        if not isinstance(item, dict) or set(item) - {"id", "name", "executable", "args", "app"}:
            raise ValueError("Unknown action fields")
        id_ = item.get("id", "")
        if not isinstance(id_, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", id_) or id_ in actions:
            raise ValueError("Action IDs must be unique, 1–64 letters, digits, underscore or hyphen")
        if not isinstance(item.get("name"), str) or not 1 <= len(item["name"].strip()) <= 100:
            raise ValueError("Each action needs a friendly name")
        args = item.get("args", [])
        if not isinstance(args, list) or len(args) > 32 or any(not isinstance(a, str) or len(a) > 4096 or "\0" in a for a in args):
            raise ValueError("Arguments must be a bounded list of literal strings")
        if "app" in item:
            if "executable" in item or args or not isinstance(item["app"], str) or not Path(item["app"]).is_absolute() or not item["app"].endswith(".app"):
                raise ValueError("macOS app must be an absolute .app path, without arguments")
        elif not isinstance(item.get("executable"), str) or not Path(item["executable"]).is_absolute() or "\0" in item["executable"]:
            raise ValueError("Executable must be an absolute local path")
        actions[id_] = item
    return actions


def advertised(actions):
    return [{"id": id_, "name": a["name"]} for id_, a in actions.items()]


def check_session():
    if sys.platform == "win32":
        if ctypes.windll.shell32.IsUserAnAdmin():
            raise RuntimeError("Run without Administrator privileges")
        session = ctypes.c_ulong()
        if not ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)) or session.value == 0:
            raise RuntimeError("Run in your signed-in graphical session, not as a service")
    else:
        if os.geteuid() == 0:
            raise RuntimeError("Run as your desktop user, never root or sudo")
        if sys.platform == "darwin":
            if os.stat("/dev/console").st_uid != os.getuid():
                raise RuntimeError("Sign in to the macOS desktop first")
        elif sys.platform.startswith("linux"):
            if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
                raise RuntimeError("Run from a terminal in your graphical desktop session")
        else:
            raise RuntimeError("Unsupported operating system")


def launch(action, platform=None):
    """Transport-independent adapter. Input comes ONLY from the local allowlist."""
    platform = platform or sys.platform
    if "app" in action:
        if platform != "darwin":
            raise ValueError(".app actions are only supported on macOS")
        argv = ["/usr/bin/open", "-a", action["app"]]
    else:
        executable = action["executable"]
        if platform == "win32" and not executable.lower().endswith(".exe"):
            raise ValueError("Windows actions must be .exe files, not batch/script files")
        argv = [executable, *action.get("args", [])]
    # No shell, PATH search, supplied environment, cwd, or dashboard arguments.
    return subprocess.Popen(argv, shell=False, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            close_fds=True)


def process_command(client, session, command, config, deadline):
    """At-most-once grant. Never retry a consumed grant after errors/reconnect."""
    actions = load_actions(config)
    action = actions.get(command.get("actionId"))
    payload = {"session": session, "id": command["id"]}
    if not action or time.monotonic() >= deadline:
        client.call("companion/failed", payload)
        return None
    granted = client.call("companion/accept", payload)
    # Re-read after authorization: a local removal/redefinition always wins.
    if (granted.get("id") != command["id"] or granted.get("actionId") != command["actionId"]
            or time.monotonic() >= deadline or load_actions(config).get(command["actionId"]) != action):
        client.call("companion/failed", payload)
        return None
    try:
        return launch(action)
    except (OSError, ValueError):
        client.call("companion/failed", payload)
        return None


def pair(args):
    check_session()
    actions = load_actions(args.config)
    store = vault()  # fail before consuming an invitation
    if store.get_password(SERVICE, account(args.config)):
        raise ValueError("This profile is already paired. Revoke and forget it first, or use a separate config file.")
    server = server_url(args.server)
    client = Transport(server, ca=args.ca)
    instance = client.call("instance")["instanceId"]
    code = getpass.getpass("Pairing code from Settings (hidden): ").strip()
    info = client.call("pairings/inspect", {"code": code, "instanceId": instance})
    if info.get("instanceId") != instance:
        raise ValueError("Server instance changed during pairing")
    print("Server:", server, "\nInstance:", instance, "\nDashboard owner:", info["owner"])
    print("Locally approved applications:")
    for action in actions.values():
        print(" ", action["name"], "=>", action.get("app") or action["executable"])
    print("Anyone using that owner's signed-in dashboard/kiosk can launch these applications.")
    if input('Type APPROVE to authorize this server: ') != "APPROVE":
        raise ValueError("Pairing cancelled")
    result = client.call("pairings/approve", {
        "code": code, "instanceId": instance, "approved": True,
        "name": args.name or socket.gethostname(), "actions": advertised(actions)})
    if result.get("instanceId") != instance:
        raise ValueError("Server instance changed during approval")
    store.set_password(SERVICE, account(args.config), json.dumps({
        **result, "server": server, "ca": str(Path(args.ca).resolve()) if args.ca else None}))
    print("Paired. Start with: python companion.py run --config", args.config)


def run(args):
    check_session()
    data = vault().get_password(SERVICE, account(args.config))
    if not data:
        raise ValueError("Not paired. Run the pair command first.")
    credentials = json.loads(data)
    client = Transport(credentials["server"], credentials, credentials.get("ca"))
    children = []
    session = None
    while True:
        try:
            actions = load_actions(args.config)
            if session is None:
                result = client.call("companion/hello", {"actions": advertised(actions)})
                if result.get("instanceId") != credentials["instanceId"]:
                    raise ValueError("Server identity changed; revoke and pair explicitly")
                session = result["session"]
                print("Connected to", credentials["server"], flush=True)
            started = time.monotonic()
            result = client.call("companion/poll", {"session": session, "actions": advertised(actions)})
            for command in result["commands"]:
                ttl = min(4, max(0, (command["expiresAt"] - result["serverTime"]) / 1000))
                child = process_command(client, session, command, args.config, started + ttl)
                if child:
                    children.append(child)
            children = [child for child in children if child.poll() is None]
            time.sleep(1)
        except urllib.error.HTTPError as error:
            session = None
            if error.code in (401, 403, 426):
                raise RuntimeError("Computer revoked, server changed, or transport refused; pair again only after checking Settings") from None
            print("Server unavailable or session expired; reconnecting without replay", flush=True)
            time.sleep(3)
        except (OSError, ValueError, KeyError) as error:
            session = None
            # Never log tokens, response bodies, or config arguments.
            print("Connection/configuration error:", type(error).__name__, "; reconnecting without replay", flush=True)
            time.sleep(3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["pair", "run", "forget", "check"])
    parser.add_argument("--config", type=Path, default=Path.home() / ".tachboard-actions.json")
    parser.add_argument("--server", help="Exact HTTPS server origin (pair only)")
    parser.add_argument("--name", help="Friendly computer name (pair only)")
    parser.add_argument("--ca", help="Trusted private CA PEM file (pair only)")
    args = parser.parse_args()
    try:
        if args.command == "check":
            check_session()
            print("Approved actions:", ", ".join(a["name"] for a in load_actions(args.config).values()))
            vault()
            print("Graphical session and secure vault available")
        elif args.command == "pair":
            if not args.server:
                parser.error("--server is required for pairing")
            pair(args)
        elif args.command == "forget":
            vault().delete_password(SERVICE, account(args.config))
            print("Local credentials removed. Also revoke the computer in Settings.")
        else:
            run(args)
    except KeyboardInterrupt:
        print("\nStopped. Computer will show offline within 8 seconds.")
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
