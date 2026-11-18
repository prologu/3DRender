#!/usr/bin/env python3
"""Benchmark a model already loaded by the 3DRender REST API.

The script measures renderer/transport cost across practical interactive and
settled profiles, then compares reduced-LOD frames against the full point set
at identical cameras and JPEG quality.
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import math
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity


def post_render(base: str, payload: dict) -> tuple[bytes, dict]:
    target = urlsplit(base)
    connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=300)
    body = json.dumps(payload).encode("utf-8")
    started = time.perf_counter()
    connection.request("POST", "/api/render", body, {"Content-Type": "application/json"})
    response = connection.getresponse()
    image = response.read()
    wall_ms = (time.perf_counter() - started) * 1000.0
    if response.status >= 300:
        raise RuntimeError(f"HTTP {response.status}: {image[:500].decode(errors='replace')}")
    stats = json.loads(response.getheader("X-Render-Stats"))
    stats["wall_ms"] = round(wall_ms, 3)
    connection.close()
    return image, stats


def get_json(base: str, path: str) -> dict:
    target = urlsplit(base)
    connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=30)
    connection.request("GET", path)
    response = connection.getresponse()
    data = response.read()
    if response.status >= 300:
        raise RuntimeError(f"HTTP {response.status}: {data[:500].decode(errors='replace')}")
    connection.close()
    return json.loads(data)


def percentile(values: list[float], q: float) -> float:
    return float(np.percentile(np.asarray(values, dtype=np.float64), q))


def summarize_samples(samples: list[dict]) -> dict:
    def metric(name: str) -> dict:
        values = [float(sample[name]) for sample in samples]
        return {
            "median": round(statistics.median(values), 3),
            "p95": round(percentile(values, 95), 3),
        }

    median_render = statistics.median(float(sample["render_ms"]) for sample in samples)
    median_wall = statistics.median(float(sample["wall_ms"]) for sample in samples)
    return {
        "gaussians": int(samples[-1]["gaussians"]),
        "lod": samples[-1]["lod"],
        "render_ms": metric("render_ms"),
        "gpu_ms": metric("gpu_ms"),
        "encode_ms": metric("encode_ms"),
        "wall_ms": metric("wall_ms"),
        "render_fps": round(1000.0 / median_render, 2),
        "local_delivery_fps": round(1000.0 / median_wall, 2),
        "jpeg_kib": round(statistics.median(float(sample["jpeg_bytes"]) for sample in samples) / 1024.0, 2),
        "peak_allocated_mib": max(float(sample["peak_allocated_mib"]) for sample in samples),
        "peak_reserved_mib": max(float(sample["peak_reserved_mib"]) for sample in samples),
    }


def decode_rgb(data: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.float32) / 255.0


def image_metrics(reference: np.ndarray, test: np.ndarray) -> dict:
    mse = float(np.mean((reference - test) ** 2))
    psnr = 100.0 if mse == 0.0 else 10.0 * math.log10(1.0 / mse)
    ssim = structural_similarity(reference, test, channel_axis=2, data_range=1.0)
    return {"psnr_db": round(psnr, 4), "ssim": round(float(ssim), 6)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:8090")
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    status = get_json(args.api, "/api/status")
    profiles = [
        # Motion/interactive profiles.
        {"name": "450p-lod10-q60", "width": 800, "height": 450, "lod": 0.10, "jpeg_quality": 60, "interactive": True},
        {"name": "450p-lod25-q70", "width": 800, "height": 450, "lod": 0.25, "jpeg_quality": 70, "interactive": True},
        {"name": "720p-lod25-q70", "width": 1280, "height": 720, "lod": 0.25, "jpeg_quality": 70, "interactive": True},
        {"name": "720p-lod55-q80", "width": 1280, "height": 720, "lod": 0.55, "jpeg_quality": 80, "interactive": True},
        # Settled/inspection profiles.
        {"name": "720p-full-q90", "width": 1280, "height": 720, "lod": 1.0, "jpeg_quality": 90, "interactive": False},
        {"name": "1080p-lod55-q88", "width": 1920, "height": 1080, "lod": 0.55, "jpeg_quality": 88, "interactive": False},
        {"name": "1080p-full-q92", "width": 1920, "height": 1080, "lod": 1.0, "jpeg_quality": 92, "interactive": False},
    ]

    performance = []
    for profile in profiles:
        samples = []
        for frame in range(args.frames + 2):
            _, stats = post_render(args.api, {
                **profile,
                "lock_lod": True,
                "yaw": -0.55 + frame * 0.035,
                "pitch": 0.42 + 0.015 * math.sin(frame * 0.7),
                "fov": 55,
            })
            if frame >= 2:
                samples.append(stats)
        performance.append({"profile": profile, "summary": summarize_samples(samples)})
        print(json.dumps(performance[-1], ensure_ascii=False), flush=True)

    cameras = [
        {"yaw": -1.10, "pitch": 0.52, "fov": 55},
        {"yaw": -0.55, "pitch": 0.38, "fov": 52},
        {"yaw": 0.00, "pitch": 0.46, "fov": 55},
        {"yaw": 0.62, "pitch": 0.34, "fov": 58},
        {"yaw": 1.18, "pitch": 0.55, "fov": 52},
        {"yaw": 2.10, "pitch": 0.42, "fov": 55},
    ]
    quality = []
    quality_profiles = [
        {"name": "lod10", "lod": 0.10},
        {"name": "lod25", "lod": 0.25},
        {"name": "lod55", "lod": 0.55},
    ]
    for camera_index, camera in enumerate(cameras):
        common = {
            "width": 1280,
            "height": 720,
            "jpeg_quality": 95,
            "interactive": False,
            "lock_lod": True,
            **camera,
        }
        reference_bytes, reference_stats = post_render(args.api, {**common, "lod": 1.0})
        reference = decode_rgb(reference_bytes)
        for profile in quality_profiles:
            image_bytes, stats = post_render(args.api, {**common, "lod": profile["lod"]})
            metrics = image_metrics(reference, decode_rgb(image_bytes))
            quality.append({
                "camera": camera_index,
                "profile": profile["name"],
                **metrics,
                "gaussians": stats["gaussians"],
                "jpeg_kib": round(stats["jpeg_bytes"] / 1024.0, 2),
                "reference_jpeg_kib": round(reference_stats["jpeg_bytes"] / 1024.0, 2),
            })

    quality_summary = []
    for profile in quality_profiles:
        rows = [row for row in quality if row["profile"] == profile["name"]]
        quality_summary.append({
            "profile": profile["name"],
            "lod": profile["lod"],
            "gaussians": rows[0]["gaussians"],
            "psnr_db_mean": round(statistics.mean(row["psnr_db"] for row in rows), 4),
            "psnr_db_min": round(min(row["psnr_db"] for row in rows), 4),
            "ssim_mean": round(statistics.mean(row["ssim"] for row in rows), 6),
            "ssim_min": round(min(row["ssim"] for row in rows), 6),
        })

    result = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "api": args.api,
        "status": status,
        "performance": performance,
        "quality_reference": "same camera, 1280x720, JPEG quality 95, full loaded point set",
        "quality_samples": quality,
        "quality_summary": quality_summary,
        "color_mode": status.get("model", {}).get("color_mode", "unknown"),
        "sh_degree": status.get("model", {}).get("sh_degree"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "quality_summary": quality_summary}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
