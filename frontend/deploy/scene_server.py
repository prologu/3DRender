#!/usr/bin/env python3
"""Serve the built viewer and host uploaded Spark RAD/RADC scenes.

This service has no PyTorch/ROCm dependency, so paged browser rendering works
even when the optional gsplat server renderer is unavailable.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import sys
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit


SCENE_ID_RE = re.compile(r"^[a-f0-9]{32}$")
ALLOWED_EXTENSIONS = {".rad", ".radc"}
BUFFER_SIZE = 1024 * 1024


def safe_relative_path(raw: str) -> Path:
    value = unquote(raw).replace("\\", "/").lstrip("/")
    pure = PurePosixPath(value)
    if not value or pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ValueError("invalid scene path")
    if pure.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError("only .rad and .radc files are accepted")
    return Path(*pure.parts)


class SceneHandler(SimpleHTTPRequestHandler):
    server_version = "LumaSceneServer/1.0"

    def end_headers(self) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("Vary", "Accept-Encoding")
        elif path == "/" or path.endswith("/index.html"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        """Prefer build-time gzip for hashed assets; retain normal Range behavior."""
        path = urlsplit(self.path).path
        accepts_gzip = "gzip" in self.headers.get("Accept-Encoding", "").lower()
        if path.startswith("/assets/") and accepts_gzip and not self.headers.get("Range"):
            original = Path(self.translate_path(path))
            compressed = Path(f"{original}.gz")
            if original.is_file() and compressed.is_file():
                try:
                    source = compressed.open("rb")
                except OSError:
                    return super().send_head()
                details = compressed.stat()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mimetypes.guess_type(original.name)[0] or "application/octet-stream")
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(details.st_size))
                self.send_header("Last-Modified", self.date_time_string(details.st_mtime))
                self.end_headers()
                return source
        return super().send_head()

    @property
    def scene_root(self) -> Path:
        return self.server.scene_root  # type: ignore[attr-defined]

    @property
    def max_scene_bytes(self) -> int:
        return self.server.max_scene_bytes  # type: ignore[attr-defined]

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _scene_parts(self, prefix: str) -> tuple[str, str] | None:
        path = urlsplit(self.path).path
        if not path.startswith(prefix):
            return None
        scene_id, separator, relative = path[len(prefix):].partition("/")
        if not separator or not SCENE_ID_RE.fullmatch(scene_id):
            return None
        return scene_id, relative

    @staticmethod
    def _scene_size(directory: Path) -> int:
        return sum(item.stat().st_size for item in directory.rglob("*") if item.is_file() and not item.name.endswith(".part"))

    def _serve_scene_file(self, file_path: Path, head_only: bool = False) -> None:
        if not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        size = file_path.stat().st_size
        start, end = 0, max(size - 1, 0)
        status = HTTPStatus.OK
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match or not size:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            first, last = match.groups()
            start = int(first) if first else max(0, size - int(last or 0))
            end = min(size - 1, int(last) if last else size - 1)
            if start >= size or start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = HTTPStatus.PARTIAL_CONTENT
        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head_only:
            return
        with file_path.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining:
                chunk = source.read(min(BUFFER_SIZE, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/api/health":
            self._json(HTTPStatus.OK, {"ok": True, "uploads": True, "range": True})
            return
        parts = self._scene_parts("/scenes/")
        if parts:
            scene_id, raw_path = parts
            try:
                relative = safe_relative_path(raw_path)
            except ValueError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            self._serve_scene_file(self.scene_root / scene_id / relative)
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        parts = self._scene_parts("/scenes/")
        if parts:
            scene_id, raw_path = parts
            try:
                relative = safe_relative_path(raw_path)
            except ValueError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            self._serve_scene_file(self.scene_root / scene_id / relative, head_only=True)
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/api/scenes":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            entry = safe_relative_path(str(payload.get("entry", "scene.rad"))).as_posix()
        except (ValueError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        if not entry.lower().endswith(".rad"):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "entry must be a .rad file"})
            return
        scene_id = uuid.uuid4().hex
        directory = self.scene_root / scene_id
        directory.mkdir(parents=True)
        (directory / ".scene.json").write_text(
            json.dumps({"entry": entry, "created_at": int(time.time())}, ensure_ascii=False), encoding="utf-8"
        )
        self._json(HTTPStatus.CREATED, {
            "id": scene_id,
            "entry": entry,
            "scene_url": f"/scenes/{scene_id}/{entry}",
            "upload_base": f"/api/scenes/{scene_id}/files/",
        })

    def do_PUT(self) -> None:
        parts = self._scene_parts("/api/scenes/")
        if not parts:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        scene_id, remainder = parts
        if not remainder.startswith("files/"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        directory = self.scene_root / scene_id
        if not directory.is_dir():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            relative = safe_relative_path(remainder[len("files/"):])
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        if length < 0:
            self._json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length is required"})
            return
        if length > self.max_scene_bytes or self._scene_size(directory) + length > self.max_scene_bytes:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "scene upload limit exceeded"})
            return
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".part")
        remaining = length
        try:
            with temporary.open("wb") as output:
                while remaining:
                    chunk = self.rfile.read(min(BUFFER_SIZE, remaining))
                    if not chunk:
                        raise ConnectionError("upload ended before Content-Length")
                    output.write(chunk)
                    remaining -= len(chunk)
            temporary.replace(target)
        except (OSError, ConnectionError) as error:
            temporary.unlink(missing_ok=True)
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._json(HTTPStatus.CREATED, {"ok": True, "path": relative.as_posix(), "bytes": length})

    def do_DELETE(self) -> None:
        path = urlsplit(self.path).path
        prefix = "/api/scenes/"
        scene_id = path[len(prefix):].strip("/") if path.startswith(prefix) else ""
        if not SCENE_ID_RE.fullmatch(scene_id):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        directory = self.scene_root / scene_id
        if directory.is_dir():
            shutil.rmtree(directory)
        self._json(HTTPStatus.OK, {"ok": True})


def main() -> None:
    site = Path(os.environ.get("SITE_DIR", sys.argv[1] if len(sys.argv) > 1 else "site")).resolve()
    scene_root = Path(os.environ.get("SCENE_DIR", site.parent / "scenes")).resolve()
    port = int(os.environ.get("PORT", "8088"))
    max_scene_gib = float(os.environ.get("MAX_SCENE_GIB", "100"))
    if not (site / "index.html").is_file():
        raise SystemExit(f"No built viewer at {site}")
    scene_root.mkdir(parents=True, exist_ok=True)
    handler = lambda *args, **kwargs: SceneHandler(*args, directory=str(site), **kwargs)
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    server.scene_root = scene_root
    server.max_scene_bytes = int(max_scene_gib * 1024**3)
    print(f"Luma viewer: http://0.0.0.0:{port} (site={site}, scenes={scene_root})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
