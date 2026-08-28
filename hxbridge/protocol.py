#!/usr/bin/env python3
"""Helix JSON command core. GATT and HTTP both call handle_command.

USB work goes to the hxbridge-usb daemon (TonePush session).
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess

PRESET_LINE = re.compile(r"^\s*(\d+):\s+(.*)\s*$")
GLOBAL_IDS = {30, 134}
OPS = [
    "ping",
    "info",
    "preset_info",
    "list_presets",
    "select_preset",
    "select_snapshot",
    "events",
    "list_setlists",
    "list_irs",
    "list_models",
    "move_block",
    "set_model",
    "clear_block",
    "save_preset",
    "set_param",
    "get_param",
    "get_state",
    "set_bool",
    "set_int",
    "set_bypass",
    "set_trails",
    "set_global",
    "set_assign",
    "get_assign",
    "topology",
]


def cli_path() -> str:
    return os.environ.get("HXBRIDGE_USB_SOCK", "/tmp/hxbridge-usb.sock")


def daemon_sock() -> str:
    return cli_path()


def helix_present() -> bool:
    try:
        out = subprocess.check_output(["lsusb", "-d", "0e41:"], text=True)
        return "4248" in out or "HELIX" in out.upper()
    except subprocess.CalledProcessError:
        return False


def parse_preset_list(stdout: str) -> list[dict]:
    presets = []
    for line in stdout.splitlines():
        m = PRESET_LINE.match(line)
        if m:
            presets.append({"index": int(m.group(1)), "name": m.group(2)})
    return presets


def parse_param_get(stdout: str):
    """Last non-empty line of `param get` is the dump value."""
    lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
    if not lines:
        raise ValueError("param get returned no value")
    raw = lines[-1]
    if raw in ("true", "false"):
        return raw == "true"
    try:
        if raw.startswith(("+", "-")) or raw[0].isdigit() or raw.startswith("."):
            if any(c in raw for c in ".eE"):
                return float(raw)
            return int(raw)
    except ValueError:
        pass
    try:
        return int(raw)
    except ValueError:
        try:
            return float(raw)
        except ValueError as exc:
            raise ValueError(f"unrecognized param get value: {raw!r}") from exc


def parse_state_json(stdout: str) -> dict:
    """First JSON object in `param state` stdout."""
    start = stdout.find("{")
    if start < 0:
        raise ValueError("param state returned no JSON object")
    data, _ = json.JSONDecoder().raw_decode(stdout[start:])
    if not isinstance(data, dict) or "blocks" not in data:
        raise ValueError("param state JSON missing blocks")
    return data


def run_usb(cmd: dict, timeout: float = 30.0) -> dict:
    """One JSON request to the TonePush USB daemon. One line back."""
    path = daemon_sock()
    payload = (json.dumps(cmd, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(path)
            sock.sendall(payload)
            buf = bytearray()
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buf.extend(chunk)
                if b"\n" in buf:
                    break
    except OSError as exc:
        return {
            "ok": False,
            "op": cmd.get("op"),
            "error": f"usb daemon not running ({path}): {exc}",
        }
    line = bytes(buf).split(b"\n", 1)[0]
    try:
        reply = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"ok": False, "op": cmd.get("op"), "error": f"bad daemon reply: {exc}"}
    if not isinstance(reply, dict):
        return {"ok": False, "op": cmd.get("op"), "error": "daemon reply was not an object"}
    return reply


def handle_command(raw: bytes) -> dict:
    try:
        text = raw.decode("utf-8").strip()
        if not text:
            return {"ok": False, "error": "empty command"}
        cmd = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"invalid json: {exc}"}

    if not isinstance(cmd, dict) or "op" not in cmd:
        return {"ok": False, "error": "command must be an object with 'op'"}

    op = cmd["op"]
    if op == "ping":
        return {"ok": True, "op": op, "pong": True}

    if op == "info":
        return {
            "ok": True,
            "op": op,
            "usb": helix_present(),
            "vid": "0e41",
            "pid": "4248",
            "product": "HELIX",
            "cli": cli_path(),
            "ops": list(OPS),
            "note": "TonePush USB daemon; Helix Floor firmware 3.80",
        }

    if op == "list_presets":
        if "setlist" in cmd:
            setlist = _parse_int(cmd.get("setlist"), 0, 7)
            if setlist is None:
                return {"ok": False, "op": op, "error": "setlist must be 0-7"}
            return run_usb({"op": op, "setlist": setlist}, timeout=45.0)
        return run_usb({"op": op}, timeout=45.0)

    if op == "preset_info":
        return run_usb({"op": op}, timeout=45.0)

    if op == "events":
        return run_usb({"op": op}, timeout=15.0)

    if op == "list_models":
        return run_usb({"op": op}, timeout=20.0)

    if op == "list_setlists":
        return run_usb({"op": op}, timeout=20.0)

    if op == "list_irs":
        return run_usb({"op": op}, timeout=20.0)

    if op == "select_snapshot":
        index = _parse_int(cmd.get("index"), 0, 7)
        if index is None:
            return {"ok": False, "op": op, "error": "index must be an integer 0-7"}
        return run_usb({"op": op, "index": index}, timeout=20.0)

    if op == "move_block":
        src = _parse_int(cmd.get("from"), 0, 39)
        dst = _parse_int(cmd.get("to"), 0, 39)
        if src is None or dst is None:
            return {"ok": False, "op": op, "error": "from and to must be integers 0-39"}
        return run_usb({"op": op, "from": src, "to": dst}, timeout=20.0)

    if op == "set_model":
        block = _parse_int(cmd.get("block"), 0, 39)
        if block is None:
            return {"ok": False, "op": op, "error": "block must be an integer 0-39"}
        if block % 20 in (0, 9, 10, 19):
            return {"ok": False, "op": op, "error": "cannot change input, output, split, or merge"}
        body: dict = {"op": op, "block": block}
        if "model" in cmd:
            model = _parse_int(cmd.get("model"), 0, 10000)
            if model is None:
                return {"ok": False, "op": op, "error": "model must be an integer 0-10000"}
            body["model"] = model
        elif isinstance(cmd.get("model_id"), str) and cmd["model_id"]:
            body["model_id"] = cmd["model_id"]
        else:
            return {"ok": False, "op": op, "error": "model (int) or model_id (string) required"}
        if "paired" in cmd:
            paired = _parse_int(cmd.get("paired"), 0, 10000)
            if paired is None:
                return {"ok": False, "op": op, "error": "paired must be an integer 0-10000"}
            body["paired"] = paired
        elif isinstance(cmd.get("paired_id"), str) and cmd["paired_id"]:
            body["paired_id"] = cmd["paired_id"]
        if cmd.get("pair") is True:
            body["pair"] = True
        if isinstance(cmd.get("stereo"), bool):
            body["stereo"] = cmd["stereo"]
        return run_usb(body, timeout=20.0)

    if op == "clear_block":
        block = _parse_int(cmd.get("block"), 0, 39)
        if block is None:
            return {"ok": False, "op": op, "error": "block must be an integer 0-39"}
        if block % 20 in (0, 9, 10, 19):
            return {"ok": False, "op": op, "error": "cannot clear input, output, split, or merge"}
        return run_usb({"op": op, "block": block}, timeout=20.0)

    if op == "save_preset":
        body = {"op": op}
        if "setlist" in cmd:
            setlist = _parse_int(cmd.get("setlist"), 0, 7)
            if setlist is None:
                return {"ok": False, "op": op, "error": "setlist must be 0-7"}
            body["setlist"] = setlist
        if "index" in cmd:
            index = _parse_int(cmd.get("index"), 0, 127)
            if index is None:
                return {"ok": False, "op": op, "error": "index must be an integer 0-127"}
            body["index"] = index
        name = cmd.get("name")
        if name is not None:
            if not isinstance(name, str) or not name:
                return {"ok": False, "op": op, "error": "name must be a non-empty string"}
            body["name"] = name
        return run_usb(body, timeout=20.0)

    if op == "select_preset":
        try:
            bank = int(cmd["bank"])
            preset = int(cmd["preset"])
        except (KeyError, TypeError, ValueError):
            return {"ok": False, "op": op, "error": "bank and preset must be integers"}
        if not 0 <= bank <= 255 or not 0 <= preset <= 255:
            return {"ok": False, "op": op, "error": "bank/preset out of range"}
        setlist = _parse_int(cmd.get("setlist", 0), 0, 7)
        if setlist is None:
            return {"ok": False, "op": op, "error": "setlist must be 0-7"}
        return run_usb(
            {"op": op, "bank": bank, "preset": preset, "setlist": setlist},
            timeout=20.0,
        )

    if op == "set_param":
        ids, err = _parse_block_param(cmd, op)
        if err:
            return err
        block, param, subslot = ids
        try:
            wire = float(cmd["float"])
        except (KeyError, TypeError, ValueError):
            return {"ok": False, "op": op, "error": "float must be a number"}
        if wire != wire or wire in (float("inf"), float("-inf")):
            return {"ok": False, "op": op, "error": "float must be finite"}
        return run_usb(
            {"op": op, "block": block, "param": param, "subslot": subslot, "float": wire}
        )

    if op == "get_param":
        ids, err = _parse_block_param(cmd, op)
        if err:
            return err
        block, param, subslot = ids
        return run_usb(
            {"op": op, "block": block, "param": param, "subslot": subslot},
            timeout=45.0,
        )

    if op == "get_state":
        return run_usb({"op": op}, timeout=45.0)

    if op == "topology":
        return run_usb({"op": op}, timeout=45.0)

    if op == "set_bool":
        ids, err = _parse_block_param(cmd, op)
        if err:
            return err
        block, param, subslot = ids
        value = cmd.get("value")
        if not isinstance(value, bool):
            return {"ok": False, "op": op, "error": "value must be true or false"}
        return run_usb(
            {"op": op, "block": block, "param": param, "subslot": subslot, "value": value}
        )

    if op == "set_int":
        ids, err = _parse_block_param(cmd, op)
        if err:
            return err
        block, param, subslot = ids
        value = _parse_int(cmd.get("value"), 0, 127)
        if value is None:
            return {"ok": False, "op": op, "error": "value must be an integer 0-127"}
        return run_usb(
            {"op": op, "block": block, "param": param, "subslot": subslot, "value": value}
        )

    if op == "set_bypass":
        block = _parse_int(cmd.get("block"), 0, 39)
        if block is None:
            return {"ok": False, "op": op, "error": "block must be an integer 0-39"}
        enabled = cmd.get("enabled")
        if not isinstance(enabled, bool):
            return {"ok": False, "op": op, "error": "enabled must be true or false"}
        return run_usb({"op": op, "block": block, "enabled": enabled})

    if op == "set_trails":
        block = _parse_int(cmd.get("block"), 0, 39)
        if block is None:
            return {"ok": False, "op": op, "error": "block must be an integer 0-39"}
        value = cmd.get("value")
        if not isinstance(value, bool):
            return {"ok": False, "op": op, "error": "value must be true or false"}
        return run_usb({"op": op, "block": block, "value": value})

    if op == "set_global":
        gid = _parse_int(cmd.get("id"), 0, 255)
        value = _parse_int(cmd.get("value"), 0, 127)
        if gid is None or value is None:
            return {"ok": False, "op": op, "error": "id and value must be integers"}
        if gid not in GLOBAL_IDS:
            return {"ok": False, "op": op, "error": "id not in live global allowlist (30=In-Z, 134=Pad)"}
        return run_usb({"op": op, "id": gid, "value": value})

    if op == "set_assign":
        block = _parse_int(cmd.get("block"), 0, 39)
        value = _parse_int(cmd.get("value"), 0, 127)
        if block is None or value is None:
            return {"ok": False, "op": op, "error": "block and value must be integers"}
        return run_usb({"op": op, "block": block, "value": value})

    if op == "get_assign":
        block = _parse_int(cmd.get("block"), 0, 39)
        subslot = _parse_int(cmd.get("subslot", 0), 0, 1)
        if block is None or subslot is None:
            return {"ok": False, "op": op, "error": "block 0-39 and subslot 0-1 required"}
        return run_usb({"op": op, "block": block, "subslot": subslot}, timeout=45.0)

    return {"ok": False, "error": f"unknown op: {op}"}


def _parse_int(raw, lo: int, hi: int) -> int | None:
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None
    if not lo <= raw <= hi:
        return None
    return raw


def _parse_block_param(cmd: dict, op: str):
    block = _parse_int(cmd.get("block"), 0, 39)
    param = _parse_int(cmd.get("param"), 0, 31)
    subslot = _parse_int(cmd.get("subslot", 0), 0, 1)
    if block is None or param is None or subslot is None:
        return None, {
            "ok": False,
            "op": op,
            "error": "block 0-39, param 0-31, subslot 0-1 required",
        }
    return (block, param, subslot), None
