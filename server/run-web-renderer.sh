#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
export RENDER_PORT="${PORT:-8089}"
export SITE_DIR="${SITE_DIR:-$APP_ROOT/site}"
export MODEL_PATH="${MODEL_PATH:-}"
export PHYSICAL_GPU="${PHYSICAL_GPU:-3}"

echo "Luma Splat 流式渲染器正在启动"
echo "本地访问: http://127.0.0.1:${RENDER_PORT}/"
echo "容器监听: http://0.0.0.0:${RENDER_PORT}/"
if [[ -n "$MODEL_PATH" ]]; then
  echo "启动时预加载: $MODEL_PATH"
else
  echo "启动时不预加载模型；请在网页的服务端渲染模式中上传 PLY。"
fi

exec "$APP_ROOT/run-render-server.sh"
