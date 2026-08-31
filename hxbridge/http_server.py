#!/usr/bin/env python3
"""ToneRelay HTTP + WebSocket server (Wi-Fi path).

Serves the React static build and the same JSON ops as GATT.
TLS is optional (``--https``); the default is plain HTTP for LAN use.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import ssl
import subprocess
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path

from aiohttp import WSMsgType, web

sys.path.insert(0, str(Path(__file__).resolve().parent))
from protocol import handle_command, helix_present, cli_path

LOG = logging.getLogger("tonerelay.http")
HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
CERT_DIR = HERE / "certs"
CATALOG = HERE / "model_param_index.json"

# index.html names the hashed JS/CSS. If Safari caches it, a rebuild is invisible
# until the home-screen app is killed. Hashed /assets/ can be cached forever.
HTML_NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
}
ASSET_CACHE = {"Cache-Control": "public, max-age=31536000, immutable"}


def ensure_lab_cert(cert_dir: Path) -> tuple[Path, Path]:
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert = cert_dir / "cert.pem"
    key = cert_dir / "key.pem"
    if cert.is_file() and key.is_file():
        return cert, key
    LOG.info("creating lab self-signed TLS cert in %s", cert_dir)
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-sha256",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "3650",
            "-nodes",
            "-subj",
            "/CN=tonerelay.local",
            "-addext",
            "subjectAltName=DNS:tonerelay.local,DNS:localhost,IP:127.0.0.1",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    key.chmod(0o600)
    return cert, key


async def api_info(_request: web.Request) -> web.Response:
    body = handle_command(b'{"op":"info"}')
    return web.json_response(body)


async def api_catalog(_request: web.Request) -> web.Response:
    if not CATALOG.is_file():
        return web.json_response({"ok": False, "error": "catalog missing"}, status=404)
    return web.FileResponse(CATALOG, headers={"Content-Type": "application/json"})


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30.0)
    await ws.prepare(request)
    LOG.info("websocket connected")
    async for msg in ws:
        if msg.type == WSMsgType.TEXT:
            try:
                parsed = json.loads(msg.data)
            except json.JSONDecodeError as exc:
                await ws.send_str(
                    json.dumps({"ok": False, "error": f"invalid json: {exc}"}, separators=(",", ":"))
                )
                continue
            req_id = None
            if isinstance(parsed, dict) and "id" in parsed:
                req_id = parsed.pop("id")
            raw = json.dumps(parsed, separators=(",", ":")).encode("utf-8")
            result = await asyncio.to_thread(handle_command, raw)
            if req_id is not None:
                result["id"] = req_id
            await ws.send_str(json.dumps(result, separators=(",", ":")))
        elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
            break
    LOG.info("websocket closed")
    return ws


async def index(_request: web.Request) -> web.StreamResponse:
    index_path = STATIC / "index.html"
    if not index_path.is_file():
        return web.Response(
            text="ToneRelay: static UI is not built. Run npm run build in web/.",
            content_type="text/plain",
            status=503,
        )
    return web.FileResponse(index_path, headers=HTML_NO_CACHE)


async def spa_or_file(request: web.Request) -> web.StreamResponse:
    rel = request.match_info["path"]
    if rel.startswith("api/") or rel == "ws":
        raise web.HTTPNotFound()
    candidate = (STATIC / rel).resolve()
    try:
        candidate.relative_to(STATIC.resolve())
    except ValueError:
        raise web.HTTPBadRequest() from None
    if candidate.is_file():
        if candidate.suffix in {".html", ".webmanifest"}:
            return web.FileResponse(candidate, headers=HTML_NO_CACHE)
        return web.FileResponse(candidate)
    return await index(request)


@web.middleware
async def cache_control(
    request: web.Request,
    handler: Callable[[web.Request], Awaitable[web.StreamResponse]],
) -> web.StreamResponse:
    resp = await handler(request)
    if request.path.startswith("/assets/"):
        resp.headers.update(ASSET_CACHE)
    return resp


def build_app() -> web.Application:
    app = web.Application(middlewares=[cache_control])
    app.router.add_get("/api/info", api_info)
    app.router.add_get("/api/catalog", api_catalog)
    app.router.add_get("/ws", ws_handler)
    if STATIC.is_dir():
        app.router.add_static("/assets", STATIC / "assets", show_index=False)
    app.router.add_get("/", index)
    app.router.add_get("/{path:.*}", spa_or_file)
    return app


def main() -> int:
    parser = argparse.ArgumentParser(description="ToneRelay HTTP + WebSocket server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="listen port (default: 80, or 8443 with --https)",
    )
    tls = parser.add_mutually_exclusive_group()
    tls.add_argument(
        "--https",
        action="store_true",
        help="listen with a lab self-signed TLS cert (needed for Web Bluetooth on a LAN host)",
    )
    tls.add_argument(
        "--http",
        action="store_true",
        help="listen without TLS (default)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    use_tls = bool(args.https)
    port = args.port if args.port is not None else (8443 if use_tls else 80)
    ssl_ctx = None
    if use_tls:
        cert, key = ensure_lab_cert(CERT_DIR)
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        ssl_ctx.load_cert_chain(str(cert), str(key))

    scheme = "https" if use_tls else "http"
    LOG.info("Helix present=%s cli=%s", helix_present(), cli_path())
    LOG.info("listening %s://%s:%s", scheme, args.host, port)
    web.run_app(build_app(), host=args.host, port=port, ssl_context=ssl_ctx, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
