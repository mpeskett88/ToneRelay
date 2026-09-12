#!/usr/bin/env python3
"""HTTP route tests that do not touch USB."""

from __future__ import annotations

import unittest

from aiohttp.test_utils import AioHTTPTestCase

from http_server import build_app


class CmdRouteTests(AioHTTPTestCase):
    async def get_application(self):
        return build_app()

    async def test_post_cmd_ping(self):
        resp = await self.client.post("/api/cmd", json={"op": "ping"})
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["pong"])

    async def test_post_cmd_rejects_empty(self):
        resp = await self.client.post("/api/cmd", data=b"")
        self.assertEqual(resp.status, 400)

    async def test_get_cmd_is_not_post(self):
        resp = await self.client.get("/api/cmd")
        self.assertIn(resp.status, (404, 405))


if __name__ == "__main__":
    unittest.main()
