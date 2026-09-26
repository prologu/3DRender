#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
PHYSICAL_GPU="${PHYSICAL_GPU:-3}"
RENDER_PORT="${RENDER_PORT:-8090}"
MODEL_PATH="${MODEL_PATH:-}"

export CUDA_VISIBLE_DEVICES="$PHYSICAL_GPU"
export PYTHONUNBUFFERED=1
export PYTHONPATH="$APP_ROOT/python"

args=(
  --host 0.0.0.0
  --port "$RENDER_PORT"
  --physical-gpu "$PHYSICAL_GPU"
  --memory-fraction "${MEMORY_FRACTION:-0.045}"
  --min-free-mib "${MIN_FREE_MIB:-1750}"
  --max-upload-gib "${MAX_UPLOAD_GIB:-2.0}"
  --max-sessions "${MAX_SESSIONS:-4}"
  --session-ttl "${SESSION_TTL:-120}"
  --frame-budget-ms "${FRAME_BUDGET_MS:-33}"
  --upload-dir "${UPLOAD_DIR:-$APP_ROOT/uploads}"
)

if [[ -n "$MODEL_PATH" ]]; then
  args+=(--model "$MODEL_PATH")
fi

if [[ -n "${SITE_DIR:-}" ]]; then
  args+=(--site-dir "$SITE_DIR")
fi
if [[ "${AUTO_LOD:-true}" == "false" ]]; then
  args+=(--no-auto-lod)
fi
if [[ "${SPATIAL_LOD:-true}" == "false" ]]; then
  args+=(--no-spatial-lod)
fi



# 解释器可覆盖：部署环境用 LUMA_PYTHON 指定（如 conda 环境路径），默认取 PATH 中的 python3。
LUMA_PYTHON="${LUMA_PYTHON:-python3}"
exec "$LUMA_PYTHON" "$APP_ROOT/server_render_api.py" "${args[@]}"
