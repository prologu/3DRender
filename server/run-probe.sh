#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
PHYSICAL_GPU="${PHYSICAL_GPU:-3}"
export CUDA_VISIBLE_DEVICES="$PHYSICAL_GPU"
export PYTHONUNBUFFERED=1
export PYTHONPATH="$APP_ROOT/python"

exec python3 "$APP_ROOT/render_probe.py" \
  --physical-gpu "$PHYSICAL_GPU" \
  --output "$APP_ROOT/benchmark-result.json" \
  "$@"
