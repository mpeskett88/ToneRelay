#!/usr/bin/env python3
"""Unit tests for BLE command parsing that do not touch USB."""

import json
import unittest

from protocol import parse_preset_list, handle_command, parse_param_get, parse_state_json


LIST_FIXTURE = """
Connecting to Helix Floor …
Connected to: Helix Floor (VID=0x0E41 PID=0x4248, 128 presets)

  0: US Double Nrm
  1: Essex A30
127: SFX:Ufology

Total: 128 preset(s) read.
"""


class ParseListTests(unittest.TestCase):
    def test_extracts_index_and_name(self):
        presets = parse_preset_list(LIST_FIXTURE)
        self.assertEqual(len(presets), 3)
        self.assertEqual(presets[0], {"index": 0, "name": "US Double Nrm"})
        self.assertEqual(presets[2]["index"], 127)

    def test_ignores_non_preset_lines(self):
        self.assertEqual(parse_preset_list("Total: 128"), [])


class CommandTests(unittest.TestCase):
    def test_ping(self):
        self.assertEqual(handle_command(b'{"op":"ping"}')["pong"], True)

    def test_empty(self):
        self.assertFalse(handle_command(b"")["ok"])

    def test_bad_json(self):
        self.assertFalse(handle_command(b"{")["ok"])

    def test_unknown_op(self):
        self.assertIn("unknown op", handle_command(b'{"op":"wipe"}')["error"])

    def test_select_requires_ints(self):
        r = handle_command(b'{"op":"select_preset"}')
        self.assertFalse(r["ok"])

    def test_select_rejects_bad_setlist(self):
        r = handle_command(b'{"op":"select_preset","bank":0,"preset":1,"setlist":9}')
        self.assertFalse(r["ok"])
        self.assertIn("setlist", r["error"])

    def test_list_presets_rejects_bad_setlist(self):
        r = handle_command(b'{"op":"list_presets","setlist":9}')
        self.assertFalse(r["ok"])
        self.assertIn("setlist", r["error"])

    def test_info_json_roundtrip(self):
        r = handle_command(b'{"op":"info"}')
        json.dumps(r)
        self.assertEqual(r["pid"], "4248")
        self.assertIn("set_param", r["ops"])
        self.assertIn("get_param", r["ops"])
        self.assertIn("get_assign", r["ops"])
        self.assertIn("get_state", r["ops"])
        self.assertIn("topology", r["ops"])
        self.assertIn("preset_info", r["ops"])
        self.assertIn("events", r["ops"])
        self.assertIn("list_setlists", r["ops"])
        self.assertIn("list_irs", r["ops"])
        self.assertIn("list_models", r["ops"])
        self.assertIn("select_snapshot", r["ops"])
        self.assertIn("move_block", r["ops"])
        self.assertIn("set_model", r["ops"])
        self.assertIn("clear_block", r["ops"])
        self.assertIn("save_preset", r["ops"])

    def test_get_param_rejects_bad_block(self):
        r = handle_command(b'{"op":"get_param","block":99,"param":0}')
        self.assertFalse(r["ok"])

    def test_get_assign_rejects_bad_block(self):
        r = handle_command(b'{"op":"get_assign","block":99}')
        self.assertFalse(r["ok"])

    def test_parse_param_get_float_bool_int(self):
        self.assertAlmostEqual(
            parse_param_get("Connecting…\nReading…\n0.33000001311302185\n"),
            0.33,
            places=5,
        )
        self.assertEqual(parse_param_get("true\n"), True)
        self.assertEqual(parse_param_get("Reading…\n3\n"), 3)

    def test_set_param_requires_float(self):
        r = handle_command(b'{"op":"set_param","block":4,"param":0}')
        self.assertFalse(r["ok"])
        self.assertIn("float", r["error"])

    def test_set_param_rejects_bad_block(self):
        r = handle_command(b'{"op":"set_param","block":99,"param":0,"float":0.4}')
        self.assertFalse(r["ok"])

    def test_set_global_rejects_unknown_id(self):
        r = handle_command(b'{"op":"set_global","id":1,"value":0}')
        self.assertFalse(r["ok"])
        self.assertIn("allowlist", r["error"])

    def test_set_bool_rejects_int_value(self):
        r = handle_command(b'{"op":"set_bool","block":5,"param":2,"value":1}')
        self.assertFalse(r["ok"])

    def test_parse_state_json_skips_connect_line(self):
        data = parse_state_json('Connecting…\n{"blocks":[{"block":4,"subslot":0,"params":[0.41]}]}\n')
        self.assertEqual(data["blocks"][0]["block"], 4)


class NewOpsTests(unittest.TestCase):
    def test_select_snapshot_rejects_range(self):
        r = handle_command(b'{"op":"select_snapshot","index":8}')
        self.assertFalse(r["ok"])
        self.assertIn("0-7", r["error"])
        r = handle_command(b'{"op":"select_snapshot"}')
        self.assertFalse(r["ok"])

    def test_move_block_rejects_range(self):
        r = handle_command(b'{"op":"move_block","from":7,"to":40}')
        self.assertFalse(r["ok"])

    def test_save_preset_rejects_bad_setlist(self):
        r = handle_command(b'{"op":"save_preset","setlist":9}')
        self.assertFalse(r["ok"])
        self.assertIn("setlist", r["error"])

    def test_save_preset_ok(self):
        from unittest.mock import patch

        with patch(
            "protocol.run_usb",
            return_value={"ok": True, "op": "save_preset", "setlist": 2, "index": 17, "name": "Essex A30"},
        ) as run_usb:
            r = handle_command(
                b'{"op":"save_preset","setlist":2,"index":17,"name":"Essex A30"}'
            )
            self.assertTrue(r["ok"])
            self.assertEqual(run_usb.call_args[0][0]["name"], "Essex A30")

    def test_list_models_ok(self):
        from unittest.mock import patch

        with patch(
            "protocol.run_usb",
            return_value={
                "ok": True,
                "op": "list_models",
                "categories": [{"id": 1, "name": "Distortion", "paired": False, "models": []}],
            },
        ) as run_usb:
            r = handle_command(b'{"op":"list_models"}')
            self.assertTrue(r["ok"])
            self.assertEqual(run_usb.call_args[0][0]["op"], "list_models")
            self.assertEqual(r["categories"][0]["name"], "Distortion")

    def test_list_setlists_ok(self):
        from unittest.mock import patch

        with patch(
            "protocol.run_usb",
            return_value={
                "ok": True,
                "op": "list_setlists",
                "setlists": [{"index": 0, "name": "Factory 1"}],
            },
        ):
            r = handle_command(b'{"op":"list_setlists"}')
            self.assertTrue(r["ok"])
            self.assertEqual(r["setlists"][0]["name"], "Factory 1")

    def test_list_irs_ok(self):
        from unittest.mock import patch

        with patch(
            "protocol.run_usb",
            return_value={
                "ok": True,
                "op": "list_irs",
                "irs": [{"index": 0, "name": "Essex Cab"}],
            },
        ):
            r = handle_command(b'{"op":"list_irs"}')
            self.assertTrue(r["ok"])
            self.assertEqual(r["irs"][0]["name"], "Essex Cab")

    def test_list_presets_omitted_setlist_passthrough(self):
        from unittest.mock import patch

        with patch("protocol.run_usb") as run_usb:
            run_usb.return_value = {"ok": True, "op": "list_presets", "setlist": 2, "presets": []}
            r = handle_command(b'{"op":"list_presets"}')
            self.assertTrue(r["ok"])
            cmd = run_usb.call_args[0][0]
            self.assertNotIn("setlist", cmd)

    def test_select_snapshot_ok(self):
        from unittest.mock import patch

        with patch("protocol.run_usb", return_value={"ok": True, "op": "select_snapshot", "index": 0}):
            r = handle_command(b'{"op":"select_snapshot","index":0}')
            self.assertTrue(r["ok"])
            self.assertEqual(r["index"], 0)

    def test_set_model_rejects_fixture_and_missing_model(self):
        r = handle_command(b'{"op":"set_model","block":0,"model_id":"HD2_AmpEssexA30"}')
        self.assertFalse(r["ok"])
        self.assertIn("input", r["error"])
        r = handle_command(b'{"op":"set_model","block":3}')
        self.assertFalse(r["ok"])
        self.assertIn("model", r["error"])

    def test_set_model_ok(self):
        from unittest.mock import patch

        with patch(
            "protocol.run_usb",
            return_value={"ok": True, "op": "set_model", "block": 3, "model": 12},
        ) as run_usb:
            r = handle_command(b'{"op":"set_model","block":3,"model_id":"HD2_DistKinkyBoost"}')
            self.assertTrue(r["ok"])
            self.assertEqual(run_usb.call_args[0][0]["model_id"], "HD2_DistKinkyBoost")

        with patch(
            "protocol.run_usb",
            return_value={"ok": True, "op": "set_model", "block": 3, "model": 12},
        ) as run_usb:
            r = handle_command(
                b'{"op":"set_model","block":3,"model_id":"HD2_DistPrizeDrive","stereo":true}'
            )
            self.assertTrue(r["ok"])
            self.assertEqual(run_usb.call_args[0][0]["stereo"], True)

    def test_clear_block_rejects_output(self):
        r = handle_command(b'{"op":"clear_block","block":9}')
        self.assertFalse(r["ok"])
        self.assertIn("output", r["error"])


if __name__ == "__main__":
    unittest.main()
