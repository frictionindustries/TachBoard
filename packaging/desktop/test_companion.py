import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch, Mock

import companion as C


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = Path(self.tmp.name) / "actions.json"
        self.action = {"id": "test", "name": "Test", "executable": sys.executable, "args": ["-c", "pass"]}
        self.config.write_text(json.dumps({"actions": [self.action]}))

    def test_transport_blocks_lan_http_and_redirects(self):
        for value in ("http://192.168.1.2", "http://example.test", "https://user:pass@example.test", "https://example.test/other", "file:///tmp/test"):
            with self.assertRaises(ValueError):
                C.Transport(value)
        self.assertEqual(C.server_url("http://127.0.0.1:20029"), "http://127.0.0.1:20029")
        with self.assertRaises(ValueError):
            C.NoRedirect().redirect_request(None, None, 302, "", {}, "http://evil")

    def test_credential_origin_binding(self):
        client = C.Transport("https://other.example", {"server": "https://original.example"})
        with self.assertRaisesRegex(ValueError, "another server"):
            client.call("companion/hello", {})

    def test_validation_and_literal_arguments(self):
        self.assertEqual(C.load_actions(self.config)["test"], self.action)
        bad = {**self.action, "args": "echo shell"}
        self.config.write_text(json.dumps({"actions": [bad]}))
        with self.assertRaises(ValueError):
            C.load_actions(self.config)
        with patch.object(C.subprocess, "Popen") as spawn:
            action = {**self.action, "args": [";touch /tmp/not-run", "$(evil)", "&calc"]}
            C.launch(action, "linux")
            self.assertEqual(spawn.call_args.args[0], [sys.executable, *action["args"]])
            self.assertIs(spawn.call_args.kwargs["shell"], False)

    def test_all_os_adapters(self):
        with patch.object(C.subprocess, "Popen") as spawn:
            C.launch({"executable": "C:\\Windows\\notepad.exe", "args": []}, "win32")
            self.assertEqual(spawn.call_args.args[0], ["C:\\Windows\\notepad.exe"])
            C.launch({"app": "/Applications/Test.app"}, "darwin")
            self.assertEqual(spawn.call_args.args[0], ["/usr/bin/open", "-a", "/Applications/Test.app"])
            C.launch({"executable": "/usr/bin/editor"}, "linux")
            self.assertEqual(spawn.call_args.args[0], ["/usr/bin/editor"])
            with self.assertRaises(ValueError):
                C.launch({"executable": "C:\\bad.cmd"}, "win32")

    def test_native_process_smoke(self):
        # Actual current-OS child execution, not proof of GUI/session integration.
        child = C.launch(self.action)
        self.assertEqual(child.wait(timeout=5), 0)

    def test_removed_or_expired_never_launch(self):
        client = Mock()
        command = {"id": "request", "actionId": "missing"}
        with patch.object(C, "launch") as launch:
            C.process_command(client, "session", command, self.config, time.monotonic() + 1)
            C.process_command(client, "session", {**command, "actionId": "test"}, self.config, time.monotonic() - 1)
            launch.assert_not_called()
            self.assertTrue(all(c.args[0] == "companion/failed" for c in client.call.call_args_list))

    def test_lost_accept_response_never_launches_or_retries(self):
        client = Mock()
        client.call.side_effect = OSError("response lost")
        with patch.object(C, "launch") as launch, self.assertRaises(OSError):
            C.process_command(client, "s", {"id": "q", "actionId": "test"}, self.config, time.monotonic() + 1)
        launch.assert_not_called()
        self.assertEqual(client.call.call_count, 1)

    def test_local_removal_during_authorization_wins(self):
        client = Mock()
        def accept(*_):
            self.config.write_text('{"actions":[]}')
            return {"id": "q", "actionId": "test"}
        client.call.side_effect = accept
        with patch.object(C, "launch") as launch:
            C.process_command(client, "s", {"id": "q", "actionId": "test"}, self.config, time.monotonic() + 1)
            launch.assert_not_called()

    def test_rejects_wrong_grant_and_launch_errors_report_failure(self):
        client = Mock()
        client.call.return_value = {"id": "other", "actionId": "test"}
        with patch.object(C, "launch") as launch:
            C.process_command(client, "s", {"id": "q", "actionId": "test"}, self.config, time.monotonic() + 1)
            launch.assert_not_called()
        client.call.return_value = {"id": "q", "actionId": "test"}
        with patch.object(C, "launch", side_effect=OSError("missing")):
            C.process_command(client, "s", {"id": "q", "actionId": "test"}, self.config, time.monotonic() + 1)
        self.assertEqual(client.call.call_args.args[0], "companion/failed")

    def test_vault_fails_closed(self):
        fake = Mock()
        fake.get_keyring.return_value = object()
        with patch.dict(sys.modules, {"keyring": fake}), self.assertRaisesRegex(RuntimeError, "secure OS vault"):
            C.vault()


if __name__ == "__main__":
    unittest.main()
