#!/usr/bin/env python3
"""Bounded CUDA 3DGS inference benchmark for a busy shared GPU."""

from __future__ import annotations

import argparse
import gc
import json
import os
import subprocess
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from gsplat import rasterization


def gpu_snapshot(physical_gpu: int) -> dict[str, int]:
    output = subprocess.check_output(
        [
            "nvidia-smi", f"--id={physical_gpu}",
            "--query-gpu=memory.used,memory.free,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits",
        ], text=True,
    ).strip()
    used, free, total, util = (int(value.strip()) for value in output.split(","))
    return {"used_mib": used, "free_mib": free, "total_mib": total, "util_percent": util}


def make_scene(count: int, device: torch.device) -> tuple[torch.Tensor, ...]:
    generator = torch.Generator(device=device).manual_seed(20260910 + count)
    means = torch.empty((count, 3), device=device)
    means[:, :2].uniform_(-2.2, 2.2, generator=generator)
    means[:, 2].uniform_(2.8, 7.5, generator=generator)
    quats = torch.zeros((count, 4), device=device)
    quats[:, 0] = 1.0
    scales = torch.empty((count, 3), device=device).uniform_(0.008, 0.025, generator=generator)
    opacities = torch.empty((count,), device=device).uniform_(0.20, 0.72, generator=generator)
    colors = torch.empty((count, 3), device=device).uniform_(0.08, 0.95, generator=generator)
    return means, quats, scales, opacities, colors


def render_once(scene: tuple[torch.Tensor, ...], width: int, height: int):
    means, quats, scales, opacities, colors = scene
    viewmats = torch.eye(4, device=means.device)[None]
    focal = 0.82 * width
    Ks = torch.tensor(
        [[[focal, 0.0, width / 2], [0.0, focal, height / 2], [0.0, 0.0, 1.0]]],
        device=means.device,
    )
    return rasterization(
        means=means,
        quats=quats,
        scales=scales,
        opacities=opacities,
        colors=colors,
        viewmats=viewmats,
        Ks=Ks,
        width=width,
        height=height,
        packed=True,
        render_mode="RGB",
        rasterize_mode="classic",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--physical-gpu", type=int, default=3)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--counts", type=int, nargs="+", default=[10_000, 25_000, 50_000, 100_000, 200_000, 400_000, 800_000, 1_200_000])
    parser.add_argument("--memory-fraction", type=float, default=0.045)
    parser.add_argument("--min-external-free-mib", type=int, default=1750)
    parser.add_argument("--max-external-util", type=int, default=35)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path, default=Path("benchmark-result.json"))
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available inside the isolated environment")
    device = torch.device("cuda:0")
    torch.cuda.set_per_process_memory_fraction(args.memory_fraction, device)
    props = torch.cuda.get_device_properties(device)
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "physical_gpu": args.physical_gpu,
        "visible_gpu": torch.cuda.get_device_name(device),
        "torch": torch.__version__,
        "cuda_runtime": torch.version.cuda,
        "resolution": [args.width, args.height],
        "memory_fraction_cap": args.memory_fraction,
        "allocator_cap_mib": round(props.total_memory * args.memory_fraction / 2**20),
        "initial_gpu": gpu_snapshot(args.physical_gpu),
        "results": [],
    }

    last_image = None
    with torch.inference_mode():
        for count in args.counts:
            before = gpu_snapshot(args.physical_gpu)
            if before["free_mib"] < args.min_external_free_mib or before["util_percent"] > args.max_external_util:
                report["stopped"] = {"reason": "shared_gpu_guard", "before": before, "next_count": count}
                break
            gc.collect()
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats(device)
            try:
                scene = make_scene(count, device)
                torch.cuda.synchronize()
                render, alpha, _ = render_once(scene, args.width, args.height)
                torch.cuda.synchronize()
                timings = []
                for _ in range(args.repeats):
                    started = time.perf_counter()
                    render, alpha, _ = render_once(scene, args.width, args.height)
                    torch.cuda.synchronize()
                    timings.append((time.perf_counter() - started) * 1000)
                last_image = render[0].clamp(0, 1).mul(255).byte().cpu().numpy()
                result = {
                    "gaussians": count,
                    "median_ms": round(float(np.median(timings)), 2),
                    "fps": round(1000.0 / float(np.median(timings)), 2),
                    "peak_allocated_mib": round(torch.cuda.max_memory_allocated(device) / 2**20, 1),
                    "peak_reserved_mib": round(torch.cuda.max_memory_reserved(device) / 2**20, 1),
                    "gpu_after": gpu_snapshot(args.physical_gpu),
                    "status": "ok",
                }
                report["results"].append(result)
                print(json.dumps(result, ensure_ascii=False), flush=True)
                del render, alpha, scene
            except torch.cuda.OutOfMemoryError as error:
                report["results"].append({"gaussians": count, "status": "oom", "error": str(error).splitlines()[0]})
                report["stopped"] = {"reason": "allocator_cap", "next_count": count}
                print(f"OOM at {count:,} Gaussians", flush=True)
                break

    if last_image is not None:
        image_path = args.output.with_suffix(".png")
        Image.fromarray(last_image).save(image_path)
        report["preview"] = str(image_path)
    report["final_gpu"] = gpu_snapshot(args.physical_gpu)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Report: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
