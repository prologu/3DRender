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
  --max-sessions "${MAX_SESSIONS:-4}"
  --session-ttl "${SESSION_TTL:-120}"
  --upload-dir "$APP_ROOT/uploads"
)

if [[ -n "$MODEL_PATH" ]]; then
  args+=(--model "$MODEL_PATH")
fi

exec python3 "$APP_ROOT/server_render_api.py" "${args[@]}"
