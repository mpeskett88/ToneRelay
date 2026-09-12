#!/usr/bin/env python3
"""Emit a C lookup table of the ToneRelay web build (hxbridge/static)."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def c_ident(path: str) -> str:
    out = []
    for ch in path:
        if ch.isalnum():
            out.append(ch)
        else:
            out.append("_")
    return "f_" + "".join(out)


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    dest = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("www_embed.c")
    files: list[tuple[str, bytes]] = []
    if src.is_dir():
        for p in sorted(src.rglob("*")):
            if not p.is_file():
                continue
            rel = "/" + p.relative_to(src).as_posix()
            files.append((rel, p.read_bytes()))

    dest.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        '#include <stddef.h>',
        '#include <stdint.h>',
        "",
        "typedef struct {",
        "    const char *path;",
        "    const uint8_t *data;",
        "    size_t len;",
        "} www_file_t;",
        "",
    ]
    for path, data in files:
        ident = c_ident(path)
        lines.append(f"static const uint8_t {ident}[] = {{")
        chunk = []
        for i, b in enumerate(data):
            chunk.append(f"0x{b:02x}")
            if (i + 1) % 16 == 0:
                lines.append("    " + ", ".join(chunk) + ",")
                chunk = []
        if chunk:
            lines.append("    " + ", ".join(chunk) + ",")
        lines.append("};")
        lines.append("")

    lines.append("const www_file_t www_files[] = {")
    for path, data in files:
        ident = c_ident(path)
        escaped = path.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'    {{"{escaped}", {ident}, {len(data)}}},')
    lines.append("};")
    lines.append(f"const size_t www_files_count = {len(files)};")
    lines.append("")
    dest.write_text("\n".join(lines), encoding="utf-8")
    print(f"embedded {len(files)} files from {src} -> {dest}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
