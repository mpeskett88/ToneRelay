#!/usr/bin/env python3
"""Poll /api/info until Ctrl-C. Does not open UART."""

from __future__ import annotations

import json
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://10.0.0.90"
INTERVAL = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0


def main() -> int:
    n = 0
    last_trace_n = 0
    print(f"watch {BASE} every {INTERVAL}s")
    while True:
        n += 1
        t0 = time.time()
        try:
            with urllib.request.urlopen(BASE + "/api/info", timeout=5) as r:
                info = json.loads(r.read())
            dt = time.time() - t0
        except Exception as e:
            print(f"{n:04d} {time.strftime('%H:%M:%S')} ERR {e}")
            time.sleep(INTERVAL)
            continue
        stats = info.get("usb_stats") or {}
        print(
            "{n:04d} {ts} {dt:.3f}s usb={usb} present={present} opening={opening} "
            "tx={tx} in_ok={in_ok} drops={drops} last_in={last_n}/{last_st}".format(
                n=n,
                ts=time.strftime("%H:%M:%S"),
                dt=dt,
                usb=info.get("usb"),
                present=info.get("present"),
                opening=info.get("opening"),
                tx=stats.get("tx_ok"),
                in_ok=stats.get("in_ok"),
                drops=stats.get("drops"),
                last_n=stats.get("last_in_n"),
                last_st=stats.get("last_in_status"),
            )
        )
        trace = info.get("trace") or []
        if len(trace) > last_trace_n:
            for line in trace[last_trace_n:]:
                print(f"     TRACE {line}")
            last_trace_n = len(trace)
        elif len(trace) < last_trace_n:
            last_trace_n = 0
            for line in trace:
                print(f"     TRACE {line}")
            last_trace_n = len(trace)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
