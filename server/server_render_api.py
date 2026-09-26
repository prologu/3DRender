#!/usr/bin/env python3
"""Minimal HTTP API for GPU-backed 3D Gaussian Splat rendering."""

from __future__ import annotations

import argparse
import gc
import json
import math
import mimetypes
import os
import subprocess
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np
import torch
from PIL import Image
from gsplat import rasterization
# JPEG 编码后端：Pillow 默认（实测比 cv2.imencode 快约 1.6 倍）；
# 个别构建上 OpenCV 更快的机器可设 LUMA_JPEG_BACKEND=opencv 切换。
try:
    import cv2
except ImportError:
    cv2 = None
_JPEG_BACKEND = "opencv" if (
    cv2 is not None
    and os.environ.get("LUMA_JPEG_BACKEND", "").lower() == "opencv"
) else "pillow"


def encode_jpeg(pixels: np.ndarray, quality: int) -> bytes:
    """将 RGB 帧编码为 JPEG。后端由模块级 _JPEG_BACKEND 决定。"""
    if _JPEG_BACKEND == "opencv":
        bgr = np.ascontiguousarray(pixels[:, :, ::-1])
        ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
        if not ok:
            raise RuntimeError("OpenCV JPEG 编码失败")
        return buf.tobytes()
    buffer = BytesIO()
    Image.fromarray(pixels, "RGB").save(buffer, format="JPEG", quality=quality, optimize=False)
    return buffer.getvalue()


SH_C0 = 0.28209479177387814
PLY_TYPES = {
    "char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1",
    "short": "<i2", "int16": "<i2", "ushort": "<u2", "uint16": "<u2",
    "int": "<i4", "int32": "<i4", "uint": "<u4", "uint32": "<u4",
    "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
}


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


def parse_ply_header(path: Path) -> tuple[int, int, np.dtype]:
    vertex_count: int | None = None
    properties: list[tuple[str, str]] = []
    in_vertices = False
    little_endian = False
    with path.open("rb") as stream:
        if stream.readline().strip() != b"ply":
            raise ValueError("文件不是 PLY 格式")
        while True:
            line = stream.readline()
            if not line:
                raise ValueError("PLY header 缺少 end_header")
            text = line.decode("ascii", "strict").strip()
            if text == "format binary_little_endian 1.0":
                little_endian = True
            elif text.startswith("format ") and text != "format binary_little_endian 1.0":
                raise ValueError("服务端当前仅支持 binary_little_endian PLY")
            elif text.startswith("element "):
                parts = text.split()
                in_vertices = len(parts) == 3 and parts[1] == "vertex"
                if in_vertices:
                    vertex_count = int(parts[2])
            elif text.startswith("property ") and in_vertices:
                parts = text.split()
                if len(parts) != 3 or parts[1] not in PLY_TYPES:
                    raise ValueError(f"不支持的 PLY 属性: {text}")
                properties.append((parts[2], PLY_TYPES[parts[1]]))
            elif text == "end_header":
                if not little_endian or vertex_count is None:
                    raise ValueError("PLY 格式或 vertex 数量无效")
                return stream.tell(), vertex_count, np.dtype(properties)


def cpu_arrays_from_ply(path: Path) -> tuple[dict[str, np.ndarray], dict]:
    offset, count, dtype = parse_ply_header(path)
    names = set(dtype.names or ())
    required = {
        "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
        "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
    }
    missing = sorted(required.difference(names))
    if missing:
        raise ValueError(f"PLY 缺少标准 3DGS 属性: {', '.join(missing)}")
    expected = offset + count * dtype.itemsize
    if path.stat().st_size < expected:
        raise ValueError("PLY 数据不完整")

    vertices = np.memmap(path, dtype=dtype, mode="r", offset=offset, shape=(count,))
    means = np.column_stack((vertices["x"], vertices["y"], vertices["z"])).astype(np.float32)
    log_scales = np.column_stack(
        (vertices["scale_0"], vertices["scale_1"], vertices["scale_2"])
    ).astype(np.float32)
    opacity_logits = np.asarray(vertices["opacity"], dtype=np.float32).copy()
    quats = np.column_stack(
        (vertices["rot_0"], vertices["rot_1"], vertices["rot_2"], vertices["rot_3"])
    ).astype(np.float32)
    dc = np.column_stack(
        (vertices["f_dc_0"], vertices["f_dc_1"], vertices["f_dc_2"])
    ).astype(np.float32)
    del vertices

    for label, values in {
        "position": means, "scale": log_scales, "opacity": opacity_logits,
        "rotation": quats, "color": dc,
    }.items():
        if not np.isfinite(values).all():
            raise ValueError(f"{label} 包含 NaN 或 Inf")

    scales = np.exp(np.clip(log_scales, -20.0, 8.0)).astype(np.float32)
    opacities = (1.0 / (1.0 + np.exp(-np.clip(opacity_logits, -20.0, 20.0)))).astype(np.float32)
    norms = np.linalg.norm(quats, axis=1, keepdims=True)
    quats = quats / np.clip(norms, 1e-8, None)
    colors = np.clip(0.5 + SH_C0 * dc, 0.0, 1.0).astype(np.float32)

    bounds_min = means.min(axis=0)
    bounds_max = means.max(axis=0)
    center = (bounds_min + bounds_max) * 0.5
    radius = max(float(np.linalg.norm(bounds_max - bounds_min) * 0.5), 1e-3)
    median_scale = float(np.median(scales))
    if median_scale > radius * 0.05:
        raise ValueError(
            "Gaussian 尺度异常：PLY 很可能把线性 scale 直接写进了标准 scale_* 字段；"
            "请先执行 log(scale) 修复"
        )

    arrays = {
        "means": means, "quats": quats, "scales": scales,
        "opacities": opacities, "colors": colors,
    }
    metadata = {
        "name": path.name,
        "bytes": path.stat().st_size,
        "gaussians": count,
        "bounds_min": bounds_min.tolist(),
        "bounds_max": bounds_max.tolist(),
        "center": center.tolist(),
        "radius": radius,
        "median_scale": median_scale,
        "camera": {"yaw": 0.0, "pitch": 0.0, "distance": radius * 2.6},
    }
    return arrays, metadata


class RendererState:
    def __init__(
        self,
        physical_gpu: int,
        memory_fraction: float,
        min_free_mib: int,
        spatial_lod: bool = True,
        stream_count: int = 4,
    ):
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA 不可用")
        self.physical_gpu = physical_gpu
        self.device = torch.device("cuda:0")
        self.min_free_mib = min_free_mib
        torch.cuda.set_per_process_memory_fraction(memory_fraction, self.device)
        self.memory_fraction = memory_fraction
        # Model tensors are read-only during render; the lock now only guards
        # model load/swap. Renders run concurrently on a small pool of CUDA
        # streams so multiple sessions do not serialize on one lock.
        self.lock = threading.RLock()
        self.streams = [torch.cuda.Stream(self.device) for _ in range(max(1, stream_count))]
        self._stream_cond = threading.Condition()
        self._stream_free = set(range(len(self.streams)))
        self.spatial_lod = spatial_lod
        self.spatial: dict | None = None
        self.model: dict[str, torch.Tensor] | None = None
        self.metadata: dict | None = None
        self.model_generation = 0

    def _take_stream(self) -> int:
        with self._stream_cond:
            while not self._stream_free:
                if not self._stream_cond.wait(timeout=30.0):
                    raise RuntimeError("渲染流池耗尽：所有会话均在渲染中")
            return self._stream_free.pop()

    def _release_stream(self, index: int) -> None:
        with self._stream_cond:
            self._stream_free.add(index)
            self._stream_cond.notify()

    def _build_spatial(self, arrays: dict[str, np.ndarray], count: int) -> dict:
        """Group Gaussians into dyadic-grid cells (a full octree for a point set)."""
        means = arrays["means"]
        target_cells = max(256, min(count // 512, 262_144))
        g = 8
        while g * g * g < target_cells and g < 64:
            g *= 2
        bb_min = means.min(axis=0)
        bb_max = means.max(axis=0)
        span = np.maximum(bb_max - bb_min, 1e-9)
        cell = np.floor(np.clip((means - bb_min) / span, 0.0, 0.999999) * g).astype(np.int64)
        cell_id = cell[:, 0] + cell[:, 1] * g + cell[:, 2] * g * g
        order = np.argsort(cell_id, kind="stable")
        sorted_ids = cell_id[order]
        starts = np.concatenate(
            ([0], np.flatnonzero(sorted_ids[1:] != sorted_ids[:-1]) + 1, [count])
        )
        rows = means[order]
        bb_min_c = np.minimum.reduceat(rows, starts[:-1], axis=0)
        bb_max_c = np.maximum.reduceat(rows, starts[:-1], axis=0)
        diag = np.linalg.norm(bb_max_c - bb_min_c, axis=1)
        return {
            "g": g,
            "cells": int(len(starts) - 1),
            "order": order,
            "starts": starts,
            "counts": np.diff(starts),
            "bb_min": bb_min_c,
            "bb_max": bb_max_c,
            "centroid": (bb_min_c + bb_max_c) * 0.5,
            "diag": diag,
            "vis": np.zeros(count, dtype=np.int32),
            "token": 0,
        }

    def _spatial_select(
        self,
        view: np.ndarray,
        fov: float,
        width: int,
        height: int,
        budget: int,
    ) -> np.ndarray | None:
        """Greedy screen-space-error leaf selection under a Gaussian count budget."""
        spatial = self.spatial
        if spatial is None:
            return None
        centroid = spatial["centroid"]
        counts = spatial["counts"].astype(np.int64)
        diag = spatial["diag"]
        rotation = view[:3, :3]
        eye = rotation.T @ (-view[:3, 3])
        cam_to_c = centroid - eye
        depth = cam_to_c @ rotation[2]
        inside = depth > 1e-3
        if not inside.any():
            return None
        right = cam_to_c @ rotation[0]
        up = cam_to_c @ (-rotation[1])
        half_w = math.tan(math.radians(fov) * 0.5)
        half_h = half_w * height / width
        margin = diag / np.maximum(depth, 1e-3) + 0.05
        inside &= np.abs(right) / depth < half_w + margin
        inside &= np.abs(up) / depth < half_h + margin
        if not inside.any():
            return None
        focal = 0.5 * height / math.tan(math.radians(fov) * 0.5)
        size_px = diag * focal / np.maximum(depth, 1e-3)
        candidates = np.flatnonzero(inside)
        ranked = candidates[np.argsort(-size_px[candidates], kind="stable")]
        cum = np.cumsum(counts[ranked])
        take = int(np.searchsorted(cum, budget, side="left")) + 1
        take = max(1, min(take, len(ranked)))
        chosen = ranked[:take]
        per = counts[chosen]
        total = int(per.sum())
        base = spatial["starts"][chosen]
        cum_sel = np.cumsum(per)
        offsets = np.repeat(np.arange(take, dtype=np.int64), per)
        return spatial["order"][
            base[offsets] + (np.arange(total, dtype=np.int64) - np.repeat(cum_sel - per, per))
        ]

    def status(self) -> dict:
        return {
            "ok": True,
            "backend": "gsplat",
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
            "device": torch.cuda.get_device_name(self.device),
            "physical_gpu": self.physical_gpu,
            "memory_fraction": self.memory_fraction,
            "gpu": gpu_snapshot(self.physical_gpu),
            "model": self.metadata,
            "model_generation": self.model_generation,
            "capabilities": {
                "adaptive_lod": True,
                "mjpeg_stream": True,
                "latest_camera_wins": True,
                "spatial_lod": bool(self.spatial_lod and self.spatial is not None),
                "stream_concurrency": len(self.streams),
            },
        }

    def load(self, path: Path) -> dict:
        snapshot = gpu_snapshot(self.physical_gpu)
        if snapshot["free_mib"] < self.min_free_mib:
            raise RuntimeError(f"GPU 剩余显存不足：{snapshot['free_mib']} MiB")
        arrays, metadata = cpu_arrays_from_ply(path)
        # Sort once by a view-independent projected-area proxy. Every LOD is then
        # a stable prefix of the same tensors, so quality changes never reshuffle
        # Gaussians and do not allocate index buffers for every frame.
        importance = arrays["opacities"] * np.square(np.max(arrays["scales"], axis=1))
        order = np.argsort(importance, kind="stable")[::-1]
        arrays = {name: np.ascontiguousarray(values[order]) for name, values in arrays.items()}
        count = metadata["gaussians"]
        metadata["lod_levels"] = {
            "preview": min(count, max(1_000, int(count * 0.25))),
            "balanced": min(count, max(1_000, int(count * 0.55))),
            "full": count,
        }
        if self.spatial_lod and count >= 10_000:
            spatial = self._build_spatial(arrays, count)
        else:
            spatial = None
        with self.lock:
            self.model = None
            gc.collect()
            torch.cuda.empty_cache()
            model = {
                name: torch.from_numpy(values).to(self.device, non_blocking=False)
                for name, values in arrays.items()
            }
            self.model = model
            self.metadata = metadata
            self.spatial = spatial
            self.model_generation += 1
        return metadata

    def lod_count(self, request: dict) -> tuple[int, str]:
        if self.metadata is None:
            raise RuntimeError("尚未加载模型")
        levels = self.metadata["lod_levels"]
        requested = request.get("lod", "full")
        if isinstance(requested, (int, float)):
            fraction = float(np.clip(float(requested), 0.05, 1.0))
            count = min(levels["full"], max(1_000, int(levels["full"] * fraction)))
            return count, f"{fraction:.2f}"
        name = str(requested).lower()
        if name not in levels:
            name = "full"
        return levels[name], name

    def lod_fraction(self, lod: object) -> float:
        """把客户端 LOD 请求（名称或比例）解析成 0.05-1.0 的比例上限。"""
        if self.metadata is None:
            return 1.0
        levels = self.metadata["lod_levels"]
        if isinstance(lod, (int, float)) and not isinstance(lod, bool):
            return float(np.clip(float(lod), 0.05, 1.0))
        name = str(lod).lower()
        if name in ("preview", "balanced"):
            return levels[name] / levels["full"]
        return 1.0

    @staticmethod
    def view_matrix(center: np.ndarray, yaw: float, pitch: float, distance: float) -> np.ndarray:
        pitch = float(np.clip(pitch, -1.48, 1.48))
        offset = np.array([
            math.sin(yaw) * math.cos(pitch),
            math.sin(pitch),
            -math.cos(yaw) * math.cos(pitch),
        ], dtype=np.float32) * distance
        eye = center + offset
        forward = center - eye
        forward /= max(float(np.linalg.norm(forward)), 1e-8)
        up = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        right = np.cross(up, forward)
        if np.linalg.norm(right) < 1e-5:
            up = np.array([0.0, 0.0, 1.0], dtype=np.float32)
            right = np.cross(up, forward)
        right /= max(float(np.linalg.norm(right)), 1e-8)
        true_up = np.cross(forward, right)
        rotation = np.stack((right, -true_up, forward), axis=0)
        view = np.eye(4, dtype=np.float32)
        view[:3, :3] = rotation
        view[:3, 3] = -rotation @ eye
        return view

    def render(self, request: dict) -> tuple[bytes, dict]:
        model = self.model
        if model is None or self.metadata is None:
            raise RuntimeError("尚未加载模型")
        width = int(np.clip(int(request.get("width", 960)), 320, 1920))
        height = int(np.clip(int(request.get("height", 540)), 180, 1080))
        yaw = float(request.get("yaw", 0.0))
        pitch = float(request.get("pitch", 0.0))
        distance = float(request.get("distance", self.metadata["camera"]["distance"]))
        distance = float(np.clip(distance, self.metadata["radius"] * 0.08, self.metadata["radius"] * 20.0))
        fov = float(np.clip(float(request.get("fov", 55.0)), 20.0, 100.0))
        background = request.get("background", [9 / 255, 11 / 255, 15 / 255])
        if not isinstance(background, list) or len(background) != 3:
            background = [9 / 255, 11 / 255, 15 / 255]

        center = np.asarray(self.metadata["center"], dtype=np.float32)
        view = self.view_matrix(center, yaw, pitch, distance)
        focal = 0.5 * height / math.tan(math.radians(fov) * 0.5)
        intrinsics = np.array(
            [[focal, 0.0, width * 0.5], [0.0, focal, height * 0.5], [0.0, 0.0, 1.0]],
            dtype=np.float32,
        )

        gaussian_count, lod_name = self.lod_count(request)
        full_count = self.metadata["lod_levels"]["full"]
        lod_strategy = "prefix"
        selection = None
        spatial_ms = 0.0
        if gaussian_count < full_count and self.spatial_lod and self.spatial is not None:
            select_started = time.perf_counter()
            reserve = max(1, int(gaussian_count * 0.5))
            selection = self._spatial_select(
                view, fov, width, height, max(1, gaussian_count - reserve))
            if selection is not None:
                # 两级选择：一半预算保留全局重要性前缀（保证全场景基础覆盖、
                # 防止远处可见空洞），另一半给空间近处叶节点叠加局部细节。
                # 时间戳标记法只遍历被选中的点，复杂度 O(选定点数)。
                if reserve < len(selection):
                    token = self.spatial["token"] + 1
                    self.spatial["vis"][selection] = token
                    self.spatial["token"] = token
                    prefix_new = np.flatnonzero(self.spatial["vis"][:reserve] != token)
                    selection = np.concatenate([selection, prefix_new])
                spatial_ms = (time.perf_counter() - select_started) * 1000.0
                lod_strategy = "spatial"
        jpeg_quality = int(np.clip(int(request.get("jpeg_quality", 88)), 55, 95))
        started = time.perf_counter()
        stream_index = self._take_stream()
        try:
            free_bytes, _ = torch.cuda.mem_get_info(self.device)
            free_mib = int(free_bytes / 2**20)
            if free_mib < self.min_free_mib:
                raise RuntimeError(f"GPU 剩余显存不足：{free_mib} MiB")
            torch.cuda.reset_peak_memory_stats(self.device)
            try:
                with torch.cuda.stream(self.streams[stream_index]), torch.inference_mode():
                    if selection is not None:
                        index_tensor = torch.from_numpy(selection).to(self.device)
                        params = {name: tensor[index_tensor] for name, tensor in model.items()}
                    else:
                        limit = gaussian_count if gaussian_count < full_count else None
                        params = {
                            name: (tensor[:limit] if limit is not None else tensor)
                            for name, tensor in model.items()
                        }
                    gpu_started = time.perf_counter()
                    rendered, _, _ = rasterization(
                        means=params["means"],
                        quats=params["quats"],
                        scales=params["scales"],
                        opacities=params["opacities"],
                        colors=params["colors"],
                        viewmats=torch.from_numpy(view).to(self.device)[None],
                        Ks=torch.from_numpy(intrinsics).to(self.device)[None],
                        width=width,
                        height=height,
                        packed=True,
                        # gsplat 1.5.3 packed mode expects a single [channels] background.
                        backgrounds=torch.tensor(background, dtype=torch.float32, device=self.device),
                        render_mode="RGB",
                        rasterize_mode="classic",
                    )
                    self.streams[stream_index].synchronize()
                    gpu_ms = (time.perf_counter() - gpu_started) * 1000.0
                    pixels = rendered[0].clamp(0, 1).mul(255).byte().cpu().numpy()
            except torch.cuda.OutOfMemoryError as exc:
                torch.cuda.empty_cache()
                raise RuntimeError("服务端渲染达到显存保护上限") from exc
        finally:
            self._release_stream(stream_index)

        encode_started = time.perf_counter()
        image_bytes = encode_jpeg(pixels, jpeg_quality)
        encode_ms = (time.perf_counter() - encode_started) * 1000.0
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        stats = {
            "render_ms": round(elapsed_ms, 2),
            "gpu_ms": round(gpu_ms, 2),
            "encode_ms": round(encode_ms, 2),
            "width": width,
            "height": height,
            "gaussians": int(params["means"].shape[0]),
            "lod": lod_name,
            "lod_strategy": lod_strategy,
            "spatial_ms": round(spatial_ms, 2),
            "jpeg_bytes": len(image_bytes),
            "jpeg_backend": _JPEG_BACKEND,
            "peak_allocated_mib": round(torch.cuda.max_memory_allocated(self.device) / 2**20, 1),
            "peak_reserved_mib": round(torch.cuda.max_memory_reserved(self.device) / 2**20, 1),
            "yaw": yaw, "pitch": pitch, "distance": distance,
        }
        return image_bytes, stats

    def export_splat(self, count: int) -> bytes:
        """Export importance-top-N Gaussians as a 32-byte-per-splat .splat preview."""
        model = self.model
        if model is None:
            raise RuntimeError("尚未加载模型")
        count = min(max(1, int(count)), model["means"].shape[0])
        means = model["means"][:count].detach().cpu().numpy()
        scales = model["scales"][:count].detach().cpu().numpy()
        rgb = np.clip(model["colors"][:count].detach().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
        opacity = np.clip(model["opacities"][:count].detach().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
        dtype = np.dtype([
            ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
            ("sx", "<f4"), ("sy", "<f4"), ("sz", "<f4"),
            ("r", "u1"), ("g", "u1"), ("b", "u1"), ("o", "u1"),
            ("pad", "u1", (4,)),
        ])
        buffer = np.empty(count, dtype=dtype)
        buffer["x"], buffer["y"], buffer["z"] = means[:, 0], means[:, 1], means[:, 2]
        buffer["sx"], buffer["sy"], buffer["sz"] = scales[:, 0], scales[:, 1], scales[:, 2]
        buffer["r"], buffer["g"], buffer["b"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
        buffer["o"] = opacity
        buffer["pad"][:] = (255, 128, 128, 128)
        return buffer.tobytes()



class RenderSession:
    """A single MJPEG consumer with a coalescing latest-camera mailbox."""

    def __init__(self, session_id: str, initial_request: dict):
        self.id = session_id
        self.condition = threading.Condition()
        self.request = dict(initial_request)
        self.revision = 1
        self.closed = False
        self.stream_attached = False
        self.last_seen = time.monotonic()
        self.stats: dict | None = None
        # 服务端自适应 LOD：在客户端 LOD 上限内按帧时间预算升降档。
        self.auto_fraction: float | None = None
        self.auto_frames = 0
        self.last_rt: float | None = None

    def update(self, request: dict) -> int:
        with self.condition:
            self.request.update(request)
            self.revision += 1
            self.last_seen = time.monotonic()
            self.condition.notify_all()
            return self.revision

    def next_request(self, rendered_revision: int, timeout: float = 15.0):
        with self.condition:
            self.condition.wait_for(
                lambda: self.closed or self.revision > rendered_revision,
                timeout=timeout,
            )
            self.last_seen = time.monotonic()
            if self.closed:
                return None
            if self.revision <= rendered_revision:
                return {}, rendered_revision
            return dict(self.request), self.revision

    def attach_stream(self) -> bool:
        with self.condition:
            if self.stream_attached or self.closed:
                return False
            self.stream_attached = True
            self.last_seen = time.monotonic()
            return True

    def detach_stream(self) -> None:
        with self.condition:
            self.stream_attached = False
            self.last_seen = time.monotonic()

    def close(self) -> None:
        with self.condition:
            self.closed = True
            self.condition.notify_all()


class SessionRegistry:
    def __init__(self, max_sessions: int, ttl_seconds: int):
        self.max_sessions = max_sessions
        self.ttl_seconds = ttl_seconds
        self.lock = threading.RLock()
        self.sessions: dict[str, RenderSession] = {}

    def cleanup(self) -> None:
        cutoff = time.monotonic() - self.ttl_seconds
        with self.lock:
            expired = [
                session_id for session_id, session in self.sessions.items()
                if session.last_seen < cutoff and not session.stream_attached
            ]
            for session_id in expired:
                self.sessions.pop(session_id).close()

    def create(self, initial_request: dict) -> RenderSession:
        self.cleanup()
        with self.lock:
            if len(self.sessions) >= self.max_sessions:
                raise RuntimeError("服务端交互会话已满，请稍后重试")
            session = RenderSession(uuid.uuid4().hex, initial_request)
            self.sessions[session.id] = session
            return session

    def get(self, session_id: str) -> RenderSession:
        with self.lock:
            session = self.sessions.get(session_id)
        if session is None or session.closed:
            raise ValueError("渲染会话不存在或已过期")
        session.last_seen = time.monotonic()
        return session

    def delete(self, session_id: str) -> None:
        with self.lock:
            session = self.sessions.pop(session_id, None)
        if session:
            session.close()

    def reset_for_model(self, metadata: dict) -> None:
        camera = metadata.get("camera", {})
        with self.lock:
            sessions = list(self.sessions.values())
        for session in sessions:
            session.update({**camera, "lod": "full"})

    def status(self) -> dict:
        self.cleanup()
        with self.lock:
            active_streams = sum(session.stream_attached for session in self.sessions.values())
            return {
                "active": len(self.sessions),
                "streams": active_streams,
                "limit": self.max_sessions,
                "ttl_seconds": self.ttl_seconds,
            }


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "LumaSplatServer/1.1"

    @property
    def app(self):
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")
        self.send_header("Access-Control-Expose-Headers", "X-Render-Stats")

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.cors()
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in {"/health", "/api/status"}:
            try:
                payload = self.app.state.status()
                payload["sessions"] = self.app.sessions.status()
                self.send_json(HTTPStatus.OK, payload)
            except Exception as exc:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": str(exc)})
        elif path.startswith("/api/session/"):
            try:
                parts = path.strip("/").split("/")
                if len(parts) == 4 and parts[3] == "stream":
                    self.stream_session(parts[2])
                elif len(parts) == 3:
                    session = self.app.sessions.get(parts[2])
                    self.send_json(HTTPStatus.OK, {
                        "ok": True,
                        "session": session.id,
                        "revision": session.revision,
                        "stats": session.stats,
                    })
                else:
                    self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})
            except ValueError as exc:
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
        elif path == "/api/model.splat":
            try:
                query = parse_qs(urlparse(self.path).query)
                fraction = float(query.get("frac", ["0.25"])[0])
                count, _ = self.app.state.lod_count({"lod": fraction})
                data = self.app.state.export_splat(min(count, 2_000_000))
                self.send_response(HTTPStatus.OK)
                self.cors()
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=300")
                self.end_headers()
                self.wfile.write(data)
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid frac"})
            except Exception as exc:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": str(exc)})

        elif self.app.site_dir is not None:
            self.send_static(path, include_body=True)
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})

    def do_HEAD(self) -> None:
        path = urlparse(self.path).path
        if self.app.site_dir is not None and not path.startswith("/api/") and path != "/health":
            self.send_static(path, include_body=False)
        else:
            self.send_response(HTTPStatus.NO_CONTENT)
            self.cors()
            self.end_headers()

    def send_static(self, request_path: str, include_body: bool) -> None:
        relative = unquote(request_path).lstrip("/") or "index.html"
        root = self.app.site_dir
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(candidate.stat().st_size))
        cache_control = "no-cache" if candidate.name == "index.html" else "public, max-age=31536000, immutable"
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        if include_body:
            with candidate.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    self.wfile.write(chunk)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/render":
                length = int(self.headers.get("Content-Length", "0"))
                if length > 64 * 1024:
                    raise ValueError("渲染参数过大")
                request = json.loads(self.rfile.read(length) or b"{}")
                image, stats = self.app.state.render(request)
                self.send_response(HTTPStatus.OK)
                self.cors()
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(image)))
                self.send_header("X-Render-Stats", json.dumps(stats, separators=(",", ":")))
                self.end_headers()
                self.wfile.write(image)
            elif path == "/api/session":
                request = self.read_json_request()
                session = self.app.sessions.create(request)
                self.send_json(HTTPStatus.CREATED, {
                    "ok": True,
                    "session": session.id,
                    "stream_url": f"/api/session/{session.id}/stream",
                })
            elif path.startswith("/api/session/") and path.endswith("/camera"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    raise ValueError("渲染会话路径无效")
                session = self.app.sessions.get(parts[2])
                revision = session.update(self.read_json_request())
                self.send_json(HTTPStatus.ACCEPTED, {
                    "ok": True, "session": session.id, "revision": revision
                })
            elif path == "/api/model":
                self.receive_model()
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})
        except ValueError as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        except RuntimeError as exc:
            self.send_json(HTTPStatus.INSUFFICIENT_STORAGE, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "session"]:
            self.app.sessions.delete(parts[2])
            self.send_json(HTTPStatus.OK, {"ok": True})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})

    def read_json_request(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 64 * 1024:
            raise ValueError("请求参数过大")
        payload = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(payload, dict):
            raise ValueError("请求参数必须是 JSON object")
        return payload

    def stream_session(self, session_id: str) -> None:
        session = self.app.sessions.get(session_id)
        if not session.attach_stream():
            self.send_json(HTTPStatus.CONFLICT, {"ok": False, "error": "该会话已有帧流连接"})
            return
        self.send_response(HTTPStatus.OK)
        self.cors()
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        rendered_revision = 0
        last_image: bytes | None = None
        last_stats: dict | None = None
        try:
            while not session.closed:
                item = session.next_request(rendered_revision)
                if item is None:
                    break
                request, revision = item
                if revision <= rendered_revision:
                    # 相机静止：没有新帧可发，不再重复传输旧帧（省 CPU/带宽/解码）。
                    time.sleep(0.05)
                    continue
                active_request = request
                if self.app.auto_lod:
                    ceiling = self.app.state.lod_fraction(request.get("lod", "full"))
                    if session.auto_fraction is None:
                        session.auto_fraction = ceiling
                    if ceiling > session.auto_fraction + 1e-6:
                        # 相机刚停止（settle 帧）：客户端明确要求比当前自动档位更高的质量。
                        # 仅当机器刚证明有余量（上一帧在预算内）或尚无参考帧时立即按该档
                        # 渲染，避免低配机器上“升一档又降一档”的振荡；否则保持降档。
                        if session.last_rt is None or session.last_rt <= self.app.frame_budget_ms:
                            session.auto_fraction = ceiling
                    else:
                        session.auto_fraction = min(session.auto_fraction, ceiling)
                    active_request = {**request, "lod": round(session.auto_fraction, 4)}
                last_image, last_stats = self.app.state.render(active_request)
                rendered_revision = revision
                session.last_rt = last_stats["render_ms"]
                if self.app.auto_lod:
                    session.auto_frames += 1
                    budget = self.app.frame_budget_ms
                    # 前 3 帧跳过调整，避开显存分配/内核加载的瞬时尖峰。
                    if session.auto_frames > 3:
                        rt = last_stats["render_ms"]
                        if rt > budget * 1.2:
                            # 超预算：按超出比例同比例降档（快速保帧率）。
                            session.auto_fraction = max(
                                0.05, session.auto_fraction * budget / max(rt, 1.0))
                        elif rt < budget * 0.5:
                            # 有余量：每帧最多升 15%，逐步细化回客户端要求的档位。
                            session.auto_fraction = min(ceiling, session.auto_fraction * 1.15)
                session.stats = {
                    **last_stats, "revision": revision,
                    "lod_auto": round(session.auto_fraction, 3) if self.app.auto_lod else None,
                }
                stats_header = json.dumps(last_stats or {}, separators=(",", ":"))
                headers = (
                    "--frame\r\n"
                    "Content-Type: image/jpeg\r\n"
                    f"Content-Length: {len(last_image)}\r\n"
                    f"X-Render-Stats: {stats_header}\r\n\r\n"
                ).encode("ascii")
                self.wfile.write(headers)
                self.wfile.write(last_image)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            print(f"stream {session_id} stopped: {exc}", flush=True)
        finally:
            session.detach_stream()

    def receive_model(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > self.app.max_upload_bytes:
            raise ValueError("模型为空或超过上传限制")
        filename = Path(unquote(self.headers.get("X-Filename", "model.ply"))).name
        if Path(filename).suffix.lower() != ".ply":
            raise ValueError("服务端模式当前仅支持标准 3DGS PLY")
        destination = self.app.upload_dir / f"{uuid.uuid4().hex}-{filename}"
        remaining = length
        try:
            with destination.open("xb") as stream:
                while remaining:
                    chunk = self.rfile.read(min(4 * 1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("上传中断")
                    stream.write(chunk)
                    remaining -= len(chunk)
            metadata = self.app.state.load(destination)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        self.send_json(HTTPStatus.OK, {"ok": True, "model": metadata})


class RenderServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self, address, state: RendererState, upload_dir: Path, max_upload_bytes: int,
        max_sessions: int, session_ttl: int, site_dir: Path | None = None,
        auto_lod: bool = True, frame_budget_ms: float = 33.0,
    ):
        super().__init__(address, ApiHandler)
        self.state = state
        self.upload_dir = upload_dir
        self.max_upload_bytes = max_upload_bytes
        self.sessions = SessionRegistry(max_sessions, session_ttl)
        self.site_dir = site_dir.resolve() if site_dir is not None else None
        self.auto_lod = auto_lod
        self.frame_budget_ms = frame_budget_ms
        self.app = self


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--physical-gpu", type=int, default=3)
    parser.add_argument("--memory-fraction", type=float, default=0.045)
    parser.add_argument("--min-free-mib", type=int, default=1750)
    parser.add_argument("--max-upload-gib", type=float, default=2.0)
    parser.add_argument("--max-sessions", type=int, default=4)
    parser.add_argument("--session-ttl", type=int, default=120)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--upload-dir", type=Path, default=Path("uploads"))
    parser.add_argument("--site-dir", type=Path)
    parser.add_argument("--auto-lod", dest="auto_lod", action="store_true", default=True,
                        help="按帧时间预算在服务端自动升降 LOD（默认开启）")
    parser.add_argument("--no-auto-lod", dest="auto_lod", action="store_false",
                        help="禁用服务端自适应 LOD，严格使用客户端请求的档位")
    parser.add_argument("--frame-budget-ms", type=float, default=33.0,
                        help="自适应 LOD 的目标帧时间预算，毫秒（默认 33 ≈ 30fps）")
    parser.add_argument("--spatial-lod", dest="spatial_lod", action="store_true", default=True,
                        help="按空间八叉树选择 LOD 叶节点（默认开启）")
    parser.add_argument("--no-spatial-lod", dest="spatial_lod", action="store_false",
                        help="禁用空间 LOD，LOD 只按重要性前缀截取")
    args = parser.parse_args()

    args.upload_dir.mkdir(parents=True, exist_ok=True)
    state = RendererState(
        args.physical_gpu, args.memory_fraction, args.min_free_mib,
        spatial_lod=args.spatial_lod,
    )
    if args.model:
        metadata = state.load(args.model)
        print(f"Loaded {metadata['name']}: {metadata['gaussians']:,} Gaussians", flush=True)
    if args.site_dir is not None and not (args.site_dir / "index.html").is_file():
        raise FileNotFoundError(f"Viewer site is missing: {args.site_dir}")
    server = RenderServer(
        (args.host, args.port), state, args.upload_dir.resolve(),
        int(args.max_upload_gib * 1024**3), max(1, args.max_sessions), max(30, args.session_ttl),
        args.site_dir, args.auto_lod, args.frame_budget_ms,
    )
    print(f"Server renderer listening on {args.host}:{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
