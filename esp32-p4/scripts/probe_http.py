#!/usr/bin/env python3
"""Time ToneRelay HTTP ops without opening UART (UART DTR resets the P4).

Examples:
  python3 probe_http.py
  python3 probe_http.py http://10.0.0.90 --wait 90
  python3 probe_http.py --ops ping,preset_info,list_setlists
  python3 probe_http.py --ops list_presets --timeout 15
  python3 probe_http.py --full --timeout 15
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request

DEFAULT_OPS = ("ping", "preset_info", "list_setlists")
HEAVY_OPS = ("list_presets", "get_state")


def fetch(base: str, path: str, timeout: float = 8.0):
    t0 = time.time()
    try:
        with urllib.request.urlopen(base + path, timeout=timeout) as r:
            body = r.read()
        return time.time() - t0, r.status, body, None
    except Exception as e:
        return time.time() - t0, None, b"", e


def cmd(base: str, op: str, timeout: float = 20.0, **extra):
    payload = {"op": op, **extra}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        base + "/api/cmd",
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
        return time.time() - t0, r.status, body, None
    except Exception as e:
        return time.time() - t0, None, b"", e


def summarize(body: bytes):
    try:
        j = json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body[:180].decode("utf-8", "replace")}
    out = {k: j.get(k) for k in ("ok", "op", "error", "lost", "name", "setlist", "index", "count") if k in j}
    if isinstance(j.get("presets"), list):
        out["n_presets"] = len(j["presets"])
        named = [p for p in j["presets"] if isinstance(p, dict) and p.get("name")]
        out["named"] = len(named)
    if isinstance(j.get("setlists"), list):
        out["n_setlists"] = len(j["setlists"])
    if isinstance(j.get("blocks"), list):
        out["n_blocks"] = len(j["blocks"])
    if isinstance(j.get("paths"), list):
        out["n_paths"] = len(j["paths"])
    out["bytes"] = len(body)
    return out


def dump_usb(label: str, body: bytes) -> None:
    try:
        j = json.loads(body)
    except json.JSONDecodeError:
        print(f"{label} bad json {body[:80]!r}")
        return
    print(
        "{label} present={present} claimed={claimed} tx={tx} in={inn} drops={drops} "
        "parked={parked} queued={queued} last={n}/{st}".format(
            label=label,
            present=j.get("present"),
            claimed=j.get("claimed"),
            tx=j.get("tx_ok"),
            inn=j.get("in_ok"),
            drops=j.get("drops"),
            parked=j.get("parked"),
            queued=j.get("queued"),
            n=j.get("last_in_n"),
            st=j.get("last_in_status"),
        )
    )


def watch_usb(base: str, stop: threading.Event, interval: float = 0.25) -> None:
    n = 0
    while not stop.wait(interval):
        n += 1
        dt, _st, body, err = fetch(base, "/api/usb", timeout=2)
        if err:
            print(f"usb {n:02d} {dt:.3f}s ERR {err}")
            continue
        dump_usb(f"usb {n:02d} {dt:.3f}s", body)


def dump_info(info: dict) -> None:
    print(
        "usb={usb} present={present} opening={opening} stats={stats} note={note!r}".format(
            usb=info.get("usb"),
            present=info.get("present"),
            opening=info.get("opening"),
            stats=info.get("usb_stats"),
            note=info.get("note"),
        )
    )
    for line in info.get("trace") or []:
        print(f"  {line}")


def wait_usb(base: str, seconds: float) -> dict | None:
    deadline = time.time() + seconds
    last = None
    n = 0
    while time.time() < deadline:
        dt, st, body, err = fetch(base, "/api/info", timeout=5)
        n += 1
        if err:
            print(f"wait {n:02d} {dt:.3f}s ERR {err}")
            time.sleep(1)
            continue
        try:
            info = json.loads(body)
        except json.JSONDecodeError:
            print(f"wait {n:02d} {dt:.3f}s bad json")
            time.sleep(1)
            continue
        last = info
        print(
            "wait {n:02d} {dt:.3f}s usb={usb} present={present} opening={opening} tx={tx} in_ok={in_ok} drops={drops}".format(
                n=n,
                dt=dt,
                usb=info.get("usb"),
                present=info.get("present"),
                opening=info.get("opening"),
                tx=(info.get("usb_stats") or {}).get("tx_ok"),
                in_ok=(info.get("usb_stats") or {}).get("in_ok"),
                drops=(info.get("usb_stats") or {}).get("drops"),
            )
        )
        if info.get("usb"):
            return info
        time.sleep(1)
    return last


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("base", nargs="?", default="http://10.0.0.90")
    p.add_argument("--wait", type=float, default=0, help="seconds to wait for usb=true")
    p.add_argument(
        "--ops",
        default=",".join(DEFAULT_OPS),
        help="comma-separated ops; default skips list_presets/get_state",
    )
    p.add_argument("--timeout", type=float, default=12, help="per-op HTTP timeout seconds")
    p.add_argument("--full", action="store_true", help="also run list_presets and get_state")
    args = p.parse_args()
    base = args.base.rstrip("/")
    ops = [o.strip() for o in args.ops.split(",") if o.strip()]
    if args.full:
        for extra in HEAVY_OPS:
            if extra not in ops:
                ops.append(extra)

    print(f"probe {base} ops={ops} timeout={args.timeout}")
    if args.wait > 0:
        info = wait_usb(base, args.wait)
        if not info:
            print("no /api/info while waiting")
            return 1
        print("--- GET /api/info after wait ---")
        dump_info(info)
        if not info.get("usb"):
            print("usb not open; not sending Helix ops")
            return 0
    else:
        dt, st, body, err = fetch(base, "/api/info")
        print(f"--- GET /api/info ({dt:.2f}s status={st}) ---")
        if err:
            print(f"ERR {err}")
            return 1
        info = json.loads(body)
        dump_info(info)
        if not info.get("usb") and any(op != "ping" for op in ops):
            print("usb not open; not sending Helix ops")
            return 0

    for op in ops:
        tout = args.timeout
        if op in HEAVY_OPS:
            tout = max(tout, 15.0)
        stop = threading.Event()
        watcher = None
        if op in HEAVY_OPS:
            watcher = threading.Thread(target=watch_usb, args=(base, stop), daemon=True)
            watcher.start()
        dt, st, body, err = cmd(base, op, timeout=tout)
        if watcher:
            stop.set()
            watcher.join(timeout=1)
        print(f"--- POST {op} ({dt:.3f}s status={st}) ---")
        if err:
            print(f"ERR {err}")
        else:
            print(summarize(body))

        dt, st, body, err = fetch(base, "/api/usb", timeout=5)
        if err:
            print(f"usb after {op}: ERR {err}")
        else:
            dump_usb(f"usb after {op}", body)

        dt, st, body, err = fetch(base, "/api/info")
        if err:
            print(f"info after {op}: ERR {err}")
            continue
        info = json.loads(body)
        print(
            "after {op}: usb={usb} present={present} stats={stats}".format(
                op=op,
                usb=info.get("usb"),
                present=info.get("present"),
                stats=info.get("usb_stats"),
            )
        )
        for line in (info.get("trace") or [])[-8:]:
            print(f"  {line}")
        if not info.get("usb"):
            print("session dropped; stopping")
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
