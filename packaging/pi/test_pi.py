"""Portable tests: no system services, package installs, or shared app data."""
import argparse
from contextlib import ExitStack, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from config import atomic_write, autostart_text, paths, server_unit, unit_quote, validate_url
import install
import kiosk


class ConfigTests(unittest.TestCase):
    def test_remote_urls(self):
        self.assertEqual(validate_url("https://nas.example/tachboard/"), "https://nas.example/tachboard/")
        self.assertEqual(validate_url("http://192.168.1.2:20029", True), "http://192.168.1.2:20029")
        for url in ("http://nas/", "file:///etc/passwd", "https://user:pass@nas/",
                    "https://nas/?token=secret", "https://nas/#secret", "https://nas/\n",
                    "https://nas:99999/", "--remote-debugging-port=9222", "https://nas/\\bad"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_url(url)

    def test_autostart_preserves_desktop_and_other_commands(self):
        first = autostart_text("", Path("/home/user/.local/share/tachboard-pi/runtime"))
        self.assertIn(". /etc/xdg/labwc/autostart", first)
        second = autostart_text(first, Path("/home/user/.local/share/tachboard-pi/runtime"))
        self.assertEqual(first, second)
        custom = "custom-panel &\n" + first
        removed = autostart_text(custom, Path("/tmp"), False)
        self.assertIn("custom-panel &", removed)
        self.assertNotIn("--session", removed)
        with self.assertRaises(ValueError):
            autostart_text("# BEGIN TACHBOARD PI\nbroken", Path("/tmp"))

    def test_safe_unit_and_browser_arguments(self):
        p = paths("/home/user space%")
        unit = server_unit(p, 20028)
        self.assertIn("user space%%", unit)
        self.assertIn("Restart=on-failure", unit)
        self.assertEqual(unit_quote("$HOME"), '"$$HOME"')
        config = {"browser": "/usr/bin/chromium", "url": "https://nas/;touch"}
        args = kiosk.browser_args(config, p["root"], True)
        self.assertEqual(args[-1], config["url"])
        self.assertNotIn("--no-sandbox", args)
        self.assertNotIn("--ignore-certificate-errors", args)
        self.assertTrue(kiosk.browser_args(config, p["root"], False)[-1].endswith("offline.html"))

    def test_atomic_write_permissions_and_symlink_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            atomic_write(path, "first")
            atomic_write(path, "second")
            self.assertEqual(path.read_text(), "second")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            path.with_name("config.json.tmp").symlink_to(path)
            with self.assertRaises(FileExistsError):
                atomic_write(path, "bad")
            self.assertEqual(path.read_text(), "second")

    def test_reachability(self):
        with patch.object(kiosk, "urlopen", side_effect=OSError("offline")):
            self.assertFalse(kiosk.reachable("https://nas"))

    def test_kiosk_offline_recovery_and_browser_crash(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            p = paths(directory)
            atomic_write(p["config"], json.dumps({"kiosk_enabled": True, "browser": "/usr/bin/chromium",
                                                 "url": "https://nas/"}))
            stack.enter_context(patch.object(kiosk, "paths", return_value=p))
            stack.enter_context(patch("sys.argv", ["kiosk.py"]))
            stack.enter_context(patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-0"}))
            signals = {}
            stack.enter_context(patch.object(kiosk.signal, "signal",
                                            side_effect=lambda sig, cb: signals.update({sig: cb})))
            stack.enter_context(patch.object(kiosk, "reachable", side_effect=[False, True, True]))
            children = []

            def spawn(_args):
                child = MagicMock()
                # Second browser simulates a crash on the third loop.
                child.poll.return_value = 1 if len(children) == 1 else None
                children.append(child)
                return child

            popen = stack.enter_context(patch.object(kiosk.subprocess, "Popen", side_effect=spawn))
            sleeps = 0

            def sleep(_):
                nonlocal sleeps
                sleeps += 1
                if sleeps == 21:
                    signals[kiosk.signal.SIGTERM]()

            stack.enter_context(patch.object(kiosk.time, "sleep", side_effect=sleep))
            kiosk.main()
            self.assertEqual(popen.call_count, 3)
            self.assertTrue(popen.call_args_list[0].args[0][-1].endswith("offline.html"))
            self.assertEqual(popen.call_args_list[1].args[0][-1], "https://nas/")
            children[0].terminate.assert_called_once()
            children[2].terminate.assert_called_once()


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.p = paths(self.home)
        self.bundle = self.home / "source-bundle"
        for name in ("bin/node", "server/index.mjs", "frontend-dist/index.html"):
            file = self.bundle / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("test fixture")
        (self.bundle / "node_modules").mkdir()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(redirect_stdout(io.StringIO()))
        self.commands = []
        self.stack.enter_context(patch.object(install, "run", side_effect=lambda *a: self.commands.append(a)))
        self.stack.enter_context(patch.object(install.subprocess, "run"))
        self.stack.enter_context(patch.object(install, "platform_check", return_value="/usr/bin/chromium"))
        self.stack.enter_context(patch.object(install, "bundle_check"))
        self.stack.enter_context(patch.object(install, "available_port"))
        self.stack.enter_context(patch.object(install, "reachable", return_value=True))
        self.stack.enter_context(patch.dict(os.environ, {"WAYLAND_DISPLAY": ""}))

    def args(self, mode="standalone", **kwargs):
        values = dict(mode=mode, url=None if mode == "standalone" else "https://nas.example/",
                      allow_http=False, port=20028, enable_boot=False, dry_run=False,
                      yes=True, bundle=str(self.bundle))
        values.update(kwargs)
        return argparse.Namespace(**values)

    def test_standalone_install_and_reinstall_preserve_data(self):
        install.install(self.args(enable_boot=True), self.p)
        self.assertTrue(self.p["current"].is_symlink())
        self.assertIn(("systemctl", "--user", "enable", "--now", install.SERVER), self.commands)
        self.assertTrue(any(c[:3] == ("sudo", "loginctl", "enable-linger") for c in self.commands))
        sentinel = self.p["data"] / "test-data"
        sentinel.write_text("keep")
        install.install(self.args(), self.p)
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual(self.p["autostart"].read_text().count("# BEGIN TACHBOARD PI"), 1)
        self.assertEqual(json.loads(self.p["config"].read_text())["url"], "http://127.0.0.1:20028/")

    def test_remote_install_and_reinstall_never_start_server(self):
        install.install(self.args("remote"), self.p)
        install.install(self.args("remote"), self.p)
        self.assertFalse(self.p["current"].exists())
        self.assertFalse((self.p["units"] / install.SERVER).exists())
        self.assertFalse(any(install.SERVER in c for c in self.commands))

    def test_switch_both_directions_preserves_local_data(self):
        install.install(self.args(), self.p)
        sentinel = self.p["data"] / "test-data"
        sentinel.write_text("keep")
        install.install(self.args("remote"), self.p)
        self.assertIn(("systemctl", "--user", "disable", "--now", install.SERVER), self.commands)
        self.assertFalse((self.p["units"] / install.SERVER).exists())
        install.install(self.args(), self.p)
        self.assertEqual(sentinel.read_text(), "keep")

    def test_disable_and_uninstall_preserve_data_and_unrelated_autostart(self):
        install.install(self.args(), self.p)
        sentinel = self.p["data"] / "test-data"
        sentinel.write_text("keep")
        with self.p["autostart"].open("a") as stream:
            stream.write("other-app &\n")
        install.manage(argparse.Namespace(action="disable-kiosk"), self.p)
        self.assertFalse(json.loads(self.p["config"].read_text())["kiosk_enabled"])
        self.assertTrue((self.p["units"] / install.SERVER).exists())
        install.manage(argparse.Namespace(action="uninstall", yes=True), self.p)
        self.assertFalse((self.p["units"] / install.SERVER).exists())
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertIn("other-app &", self.p["autostart"].read_text())
        self.commands.clear()
        install.install(self.args("remote"), self.p)
        self.assertFalse(any(install.SERVER in c for c in self.commands))
        self.assertEqual(sentinel.read_text(), "keep")

    def test_dry_run_has_no_writes_or_commands(self):
        install.install(self.args("remote", dry_run=True), self.p)
        self.assertFalse(self.p["root"].exists())
        self.assertEqual(self.commands, [])

    def test_bad_remote_configuration_does_not_stop_existing_server(self):
        install.install(self.args(), self.p)
        self.commands.clear()
        with self.assertRaises(ValueError):
            install.install(self.args("remote", url="http://nas/"), self.p)
        self.assertEqual(self.commands, [])
        self.assertEqual(json.loads(self.p["config"].read_text())["mode"], "standalone")

    def test_bad_bundle_does_not_stop_existing_server(self):
        install.install(self.args(), self.p)
        self.commands.clear()
        with patch.object(install, "bundle_check", side_effect=ValueError("bad bundle")):
            with self.assertRaises(ValueError):
                install.install(self.args(), self.p)
        self.assertEqual(self.commands, [])


if __name__ == "__main__":
    unittest.main()