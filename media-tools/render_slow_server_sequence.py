#!/usr/bin/env python3
"""Render a slow, human-scale six-direction camera sequence through 3DRender API."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import time
import urllib.request
from pathlib import Path

import numpy as np


def ease(value: float) -> float:
    value = min(1.0, max(0.0, value))
    return value * value * (3.0 - 2.0 * value)


def sample_keyframes(seconds: float, keys: list[tuple[float, np.ndarray]]) -> np.ndarray:
    if seconds <= keys[0][0]:
        return keys[0][1]
    if seconds >= keys[-1][0]:
        return keys[-1][1]
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t0 <= seconds <= t1:
            alpha = ease((seconds - t0) / max(t1 - t0, 1e-8))
            return a * (1.0 - alpha) + b * alpha
    return keys[-1][1]


def post_render(api: str, payload: dict) -> tuple[bytes, dict]:
    request = urllib.request.Request(
        api.rstrip("/") + "/api/render",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        image = response.read()
        stats = json.loads(response.headers.get("X-Render-Stats", "{}"))
    return image, stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:8090")
    parser.add_argument("--cameras", required=True)
    parser.add_argument("--camera-index", type=int, default=384)
    parser.add_argument("--output", required=True)
    parser.add_argument("--name", default="server-slow")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=int, default=15)
    parser.add_argument("--duration", type=float, default=35.0)
    parser.add_argument("--lod", default="balanced", choices=["preview", "balanced", "full"])
    parser.add_argument("--radius", type=float, required=True)
    parser.add_argument("--jpeg-quality", type=int, default=92)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()

    output = Path(args.output)
    frames_dir = output / "frames"
    images_dir = output / "images"
    frames_dir.mkdir(parents=True, exist_ok=True)
    images_dir.mkdir(parents=True, exist_ok=True)

    cameras = json.loads(Path(args.cameras).read_text(encoding="utf-8"))
    camera = cameras[args.camera_index]
    base_position = np.asarray(camera["position"], dtype=np.float64)
    rotation_c2w = np.asarray(camera["rotation"], dtype=np.float64)

    # Offsets are camera-local [right, down, forward]. The amplitudes remain
    # deliberately small so all motion stays inside the trained camera domain.
    right = args.radius * 0.018
    vertical = args.radius * 0.012
    forward = args.radius * 0.028
    zero = np.zeros(3, dtype=np.float64)
    keys = [
        (0.0, zero), (2.0, zero),
        (5.0, np.array([-right, 0.0, 0.0])), (7.0, zero),
        (10.0, np.array([right, 0.0, 0.0])), (12.0, zero),
        (15.0, np.array([0.0, -vertical, 0.0])), (17.0, zero),
        (20.0, np.array([0.0, vertical, 0.0])), (22.0, zero),
        (26.0, np.array([0.0, 0.0, forward])), (28.0, zero),
        (32.0, np.array([0.0, 0.0, -forward])), (35.0, zero),
    ]

    sx = args.width / float(camera["width"])
    sy = args.height / float(camera["height"])
    intrinsics = np.array([
        [float(camera["fx"]) * sx, 0.0, args.width * 0.5],
        [0.0, float(camera["fy"]) * sy, args.height * 0.5],
        [0.0, 0.0, 1.0],
    ])

    count = int(round(args.duration * args.fps))
    stats_rows: list[dict] = []
    wall_started = time.perf_counter()
    image_times = [2.0, 8.0, 14.0, 20.0, 27.0, 33.0]
    image_indices = {min(count - 1, round(t * args.fps)): t for t in image_times}

    for index in range(count):
        seconds = index / args.fps
        local_offset = sample_keyframes(seconds, keys)
        position = base_position + rotation_c2w @ local_offset
        view = np.eye(4, dtype=np.float64)
        view[:3, :3] = rotation_c2w.T
        view[:3, 3] = -rotation_c2w.T @ position
        payload = {
            "width": args.width,
            "height": args.height,
            "view_matrix": view.reshape(-1).tolist(),
            "intrinsics": intrinsics.reshape(-1).tolist(),
            "lod": args.lod,
            "jpeg_quality": args.jpeg_quality,
            "background": [0.035, 0.043, 0.059],
        }
        started = time.perf_counter()
        image, stats = post_render(args.api, payload)
        request_ms = (time.perf_counter() - started) * 1000.0
        frame_path = frames_dir / f"frame_{index:05d}.jpg"
        frame_path.write_bytes(image)
        if index in image_indices:
            (images_dir / f"{args.name}_{int(image_indices[index]):02d}s.jpg").write_bytes(image)
        stats_rows.append({"frame": index, "time_s": seconds, "request_ms": request_ms, **stats})
        if index % max(1, args.fps * 2) == 0:
            print(f"{index + 1}/{count}: request={request_ms:.1f} ms render={stats.get('render_ms')} ms", flush=True)

    wall_seconds = time.perf_counter() - wall_started
    mp4_path = output / f"{args.name}.mp4"
    subprocess.run([
        args.ffmpeg, "-y", "-loglevel", "error", "-framerate", str(args.fps),
        "-i", str(frames_dir / "frame_%05d.jpg"), "-c:v", "libx264",
        "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(mp4_path),
    ], check=True)

    request_values = np.asarray([row["request_ms"] for row in stats_rows])
    render_values = np.asarray([row.get("render_ms", math.nan) for row in stats_rows], dtype=float)
    summary = {
        "name": args.name,
        "camera_file": str(Path(args.cameras).resolve()),
        "camera_index": args.camera_index,
        "camera_image": camera.get("img_name"),
        "format": "PLY via gsplat server renderer",
        "width": args.width,
        "height": args.height,
        "video_fps": args.fps,
        "duration_seconds": args.duration,
        "frames": count,
        "lod": args.lod,
        "wall_seconds": wall_seconds,
        "offline_throughput_fps": count / wall_seconds,
        "mean_request_ms": float(np.mean(request_values)),
        "median_request_ms": float(np.median(request_values)),
        "mean_render_ms": float(np.nanmean(render_values)),
        "median_render_ms": float(np.nanmedian(render_values)),
        "movement": "hold, left, center, right, center, up, center, down, center, forward, center, backward, center",
        "mp4": str(mp4_path),
    }
    (output / "metrics.json").write_text(json.dumps({"summary": summary, "frames": stats_rows}, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
