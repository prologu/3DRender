#!/usr/bin/env python3
import http.client
import importlib.util
import json
import tempfile
import threading
from functools import partial
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("scene_server", ROOT / "deploy" / "scene_server.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def request(connection, method, path, body=None, headers=None):
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    payload = response.read()
    return response.status, dict(response.getheaders()), payload


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    site = root / "site"
    scenes = root / "scenes"
    site.mkdir()
    scenes.mkdir()
    (site / "index.html").write_text("viewer", encoding="utf-8")
    handler = partial(MODULE.SceneHandler, directory=str(site))
    server = MODULE.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.scene_root = scenes
    server.max_scene_bytes = 1024 * 1024
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    try:
        body = json.dumps({"entry": "city.rad"}).encode()
        status, _, payload = request(connection, "POST", "/api/scenes", body, {
            "Content-Type": "application/json", "Content-Length": str(len(body))
        })
        assert status == 201, (status, payload)
        scene = json.loads(payload)
        for name, data in (("city.rad", b"RAD-INDEX"), ("chunks/0.radc", b"0123456789")):
            path = scene["upload_base"] + name
            status, _, payload = request(connection, "PUT", path, data, {"Content-Length": str(len(data))})
            assert status == 201, (status, payload)
        status, headers, payload = request(
            connection, "GET", f"/scenes/{scene['id']}/chunks/0.radc", headers={"Range": "bytes=2-5"}
        )
        assert status == 206 and payload == b"2345", (status, payload)
        assert headers["Accept-Ranges"] == "bytes"
        status, _, payload = request(connection, "GET", "/api/health")
        assert status == 200 and json.loads(payload)["uploads"] is True
        print(json.dumps({"ok": True, "range": "2-5/10", "scene": scene["id"]}))
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
