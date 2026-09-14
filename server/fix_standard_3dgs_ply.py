#!/usr/bin/env python3
"""Convert activated scale/opacity fields into standard 3DGS PLY encoding."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import numpy as np


def read_header(path: Path) -> tuple[int, int, list[str]]:
    properties: list[str] = []
    vertex_count: int | None = None
    with path.open("rb") as stream:
        if stream.readline().strip() != b"ply":
            raise ValueError("Not a PLY file")
        while True:
            line = stream.readline()
            if not line:
                raise ValueError("PLY header has no end_header")
            text = line.decode("ascii").strip()
            if text == "format binary_little_endian 1.0":
                pass
            elif text.startswith("element vertex "):
                vertex_count = int(text.split()[-1])
            elif text.startswith("property "):
                parts = text.split()
                if len(parts) == 3:
                    if parts[1] not in {"float", "float32"}:
                        raise ValueError(f"Unsupported property type: {text}")
                    properties.append(parts[2])
            elif text == "end_header":
                if vertex_count is None:
                    raise ValueError("PLY header has no vertex count")
                return stream.tell(), vertex_count, properties


def convert(source: Path, output: Path, chunk_size: int) -> None:
    if source.resolve() == output.resolve():
        raise ValueError("Refusing to overwrite the source PLY")
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")

    header_size, count, properties = read_header(source)
    required = {"opacity", "scale_0", "scale_1", "scale_2"}
    missing = sorted(required.difference(properties))
    if missing:
        raise ValueError(f"Missing required properties: {', '.join(missing)}")

    stride = len(properties) * 4
    expected_size = header_size + count * stride
    if source.stat().st_size != expected_size:
        raise ValueError(
            f"Unexpected file size: got {source.stat().st_size}, expected {expected_size}"
        )

    shutil.copyfile(source, output)
    dtype = np.dtype([(name, "<f4") for name in properties])
    vertices = np.memmap(output, dtype=dtype, mode="r+", offset=header_size, shape=(count,))

    for start in range(0, count, chunk_size):
        end = min(start + chunk_size, count)
        for name in ("scale_0", "scale_1", "scale_2"):
            linear = np.asarray(vertices[name][start:end], dtype=np.float64)
            vertices[name][start:end] = np.log(np.clip(linear, 1e-8, None)).astype(np.float32)

        opacity = np.asarray(vertices["opacity"][start:end], dtype=np.float64)
        opacity = np.clip(opacity, 1e-6, 1.0 - 1e-6)
        vertices["opacity"][start:end] = np.log(opacity / (1.0 - opacity)).astype(np.float32)

    vertices.flush()
    del vertices

    check = np.memmap(output, dtype=dtype, mode="r", offset=header_size, shape=(count,))
    print(f"source={source}")
    print(f"output={output}")
    print(f"vertices={count}")
    for name in ("scale_0", "scale_1", "scale_2", "opacity"):
        values = check[name]
        print(
            f"{name}: min={float(values.min()):.8f} "
            f"max={float(values.max()):.8f} finite={bool(np.isfinite(values).all())}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--chunk-size", type=int, default=100_000)
    args = parser.parse_args()
    convert(args.source, args.output, args.chunk_size)


if __name__ == "__main__":
    main()
