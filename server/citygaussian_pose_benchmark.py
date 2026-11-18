#!/usr/bin/env python3
"""Evaluate 3DRender on held-out CityGaussian camera poses.

The camera JSON uses camera-to-world rotations. Mill-19's standard hold=8
split maps test view j to cameras[j * 8]. All API profiles are rendered at the
same resolution, intrinsics, JPEG quality, and pose so point-budget quality is
directly comparable.
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
from PIL import Image
from skimage.metrics import peak_signal_noise_ratio, structural_similarity


def render(base: str, payload: dict) -> tuple[bytes, dict]:
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
    stats["wall_ms"] = wall_ms
    connection.close()
    return image, stats


def decode(data: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.float32) / 255.0


def load_image(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0


def metrics(reference: np.ndarray, test: np.ndarray) -> dict:
    return {
        "psnr_db": float(peak_signal_noise_ratio(reference, test, data_range=1.0)),
        "ssim": float(structural_similarity(reference, test, channel_axis=2, data_range=1.0)),
    }


def camera_payload(camera: dict, width: int, height: int) -> dict:
    c2w = np.eye(4, dtype=np.float32)
    c2w[:3, :3] = np.asarray(camera["rotation"], dtype=np.float32)
    c2w[:3, 3] = np.asarray(camera["position"], dtype=np.float32)
    view = np.linalg.inv(c2w)
    sx, sy = width / camera["width"], height / camera["height"]
    intrinsics = [
        [camera["fx"] * sx, 0.0, width * 0.5],
        [0.0, camera["fy"] * sy, height * 0.5],
        [0.0, 0.0, 1.0],
    ]
    return {"view_matrix": view.tolist(), "intrinsics": intrinsics}


def aggregate(rows: list[dict]) -> dict:
    result = {"views": len(rows), "gaussians": rows[0]["gaussians"]}
    for key in ("psnr_db", "ssim", "native_psnr_db", "native_ssim", "render_ms", "gpu_ms", "wall_ms", "jpeg_kib"):
        values = [float(row[key]) for row in rows]
        result[f"{key}_mean"] = round(statistics.mean(values), 5)
        result[f"{key}_median"] = round(statistics.median(values), 5)
    result["render_fps_from_median"] = round(1000.0 / result["render_ms_median"], 2)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:8090")
    parser.add_argument("--cameras", type=Path, required=True)
    parser.add_argument("--gt-dir", type=Path, required=True)
    parser.add_argument("--native-dir", type=Path, required=True)
    parser.add_argument("--test-indices", default="0,20,40,60,80,100,120,140,160,180,200,220")
    parser.add_argument("--hold", type=int, default=8)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample-dir", type=Path)
    args = parser.parse_args()

    cameras = json.loads(args.cameras.read_text(encoding="utf-8"))
    test_indices = [int(value) for value in args.test_indices.split(",")]
    first_gt = Image.open(args.gt_dir / f"{test_indices[0]:05d}.png")
    width, height = first_gt.size
    full_count = 7_982_010
    profiles = [
        {"name": "full", "lod": 1.0},
        {"name": "lod55", "lod": 0.55},
        {"name": "lod25", "lod": 0.25},
        {"name": "lod10", "lod": 0.10},
        {"name": "motion300k", "lod": 300_000 / full_count},
    ]
    rows: list[dict] = []
    native_rows: list[dict] = []
    if args.sample_dir:
        args.sample_dir.mkdir(parents=True, exist_ok=True)

    for test_index in test_indices:
        camera_index = test_index * args.hold
        camera = cameras[camera_index]
        gt = load_image(args.gt_dir / f"{test_index:05d}.png")
        native = load_image(args.native_dir / f"{test_index:05d}.png")
        native_metric = metrics(gt, native)
        native_rows.append({"test_index": test_index, **native_metric})
        common = {
            "width": width,
            "height": height,
            "jpeg_quality": 95,
            "lock_lod": True,
            "interactive": False,
            **camera_payload(camera, width, height),
        }
        for profile in profiles:
            image_bytes, stats = render(args.api, {**common, "lod": profile["lod"]})
            image = decode(image_bytes)
            gt_metric = metrics(gt, image)
            native_metric_api = metrics(native, image)
            row = {
                "test_index": test_index,
                "camera_index": camera_index,
                "profile": profile["name"],
                "lod": profile["lod"],
                "gaussians": stats["gaussians"],
                **gt_metric,
                "native_psnr_db": native_metric_api["psnr_db"],
                "native_ssim": native_metric_api["ssim"],
                "render_ms": stats["render_ms"],
                "gpu_ms": stats["gpu_ms"],
                "wall_ms": stats["wall_ms"],
                "jpeg_kib": stats["jpeg_bytes"] / 1024.0,
            }
            rows.append(row)
            print(json.dumps(row), flush=True)
            if args.sample_dir and test_index == test_indices[0]:
                (args.sample_dir / f"view_{test_index:05d}_{profile['name']}.jpg").write_bytes(image_bytes)

    summary = []
    for profile in profiles:
        summary.append({"profile": profile["name"], "lod": profile["lod"], **aggregate([
            row for row in rows if row["profile"] == profile["name"]
        ])})
    native_summary = {
        "views": len(native_rows),
        "psnr_db_mean": round(statistics.mean(row["psnr_db"] for row in native_rows), 5),
        "ssim_mean": round(statistics.mean(row["ssim"] for row in native_rows), 5),
    }
    result = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "api": args.api,
        "resolution": [width, height],
        "split": {"hold": args.hold, "test_indices": test_indices},
        "native_subset": native_summary,
        "summary": summary,
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "native_subset": native_summary, "summary": summary}, indent=2))


if __name__ == "__main__":
    main()
