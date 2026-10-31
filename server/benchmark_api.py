#!/usr/bin/env python3
"""Benchmark the render API locally, excluding browser/network transport latency."""

import argparse
import http.client
import json
import statistics
import time
from pathlib import Path
from urllib.parse import urlsplit


def request_json(base, method, path, payload=None, headers=None):
    target = urlsplit(base)
    connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=300)
    body = json.dumps(payload).encode() if payload is not None else None
    request_headers = dict(headers or {})
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    connection.request(method, path, body=body, headers=request_headers)
    response = connection.getresponse()
    data = response.read()
    if response.status >= 300:
        raise RuntimeError(f"{method} {path}: HTTP {response.status}: {data[:500].decode(errors='replace')}")
    result = json.loads(data or b"{}")
    connection.close()
    return result


def upload_model(base, model_path):
    target = urlsplit(base)
    model = Path(model_path)
    connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=900)
    size = model.stat().st_size
    connection.putrequest("POST", "/api/model")
    connection.putheader("Content-Type", "application/octet-stream")
    connection.putheader("Content-Length", str(size))
    connection.putheader("X-Filename", model.name)
    connection.endheaders()
    with model.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            connection.send(chunk)
    response = connection.getresponse()
    data = response.read()
    if response.status >= 300:
        raise RuntimeError(f"model upload: HTTP {response.status}: {data[:500].decode(errors='replace')}")
    connection.close()
    return json.loads(data)


def render(base, payload):
    target = urlsplit(base)
    connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=300)
    body = json.dumps(payload).encode()
    wall_started = time.perf_counter()
    connection.request("POST", "/api/render", body, {"Content-Type": "application/json"})
    response = connection.getresponse()
    image = response.read()
    wall_ms = (time.perf_counter() - wall_started) * 1000
    if response.status >= 300:
        raise RuntimeError(f"render: HTTP {response.status}: {image[:500].decode(errors='replace')}")
    stats = json.loads(response.getheader("X-Render-Stats"))
    stats["wall_ms"] = round(wall_ms, 2)
    connection.close()
    return stats


def summarize(values):
    values = sorted(values)
    return {
        "median": round(statistics.median(values), 2),
        "p95": round(values[min(len(values) - 1, int(len(values) * 0.95))], 2),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("--api", default="http://127.0.0.1:8090")
    parser.add_argument("--frames", type=int, default=12)
    parser.add_argument("--profiles", default="256x144:45,800x450:88")
    args = parser.parse_args()

    upload = upload_model(args.api, args.model)
    model = upload["model"]
    results = []
    for profile in args.profiles.split(","):
        dimensions, quality = profile.split(":")
        width, height = map(int, dimensions.split("x"))
        samples = []
        for frame in range(args.frames + 2):
            sample = render(args.api, {
                "width": width, "height": height, "jpeg_quality": int(quality),
                "lod": 1, "lock_lod": True, "interactive": width <= 320,
                "yaw": frame * 0.025, "pitch": 0.15,
            })
            if frame >= 2:
                samples.append(sample)
        render_ms = [item["render_ms"] for item in samples]
        gpu_ms = [item["gpu_ms"] for item in samples]
        wall_ms = [item["wall_ms"] for item in samples]
        results.append({
            "profile": dimensions,
            "gaussians": samples[-1]["gaussians"],
            "render_ms": summarize(render_ms),
            "gpu_ms": summarize(gpu_ms),
            "wall_ms": summarize(wall_ms),
            "render_fps": round(1000 / statistics.median(render_ms), 1),
            "jpeg_kib": round(statistics.median(item["jpeg_bytes"] for item in samples) / 1024, 1),
            "peak_allocated_mib": max(item["peak_allocated_mib"] for item in samples),
        })
    print(json.dumps({
        "api": args.api,
        "model": model,
        "profiles": results,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
