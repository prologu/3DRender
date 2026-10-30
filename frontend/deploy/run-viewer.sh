#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
VIEWER_PORT="${PORT:-8088}"
DEFAULT_SITE="$APP_ROOT/site"
if [[ ! -f "$DEFAULT_SITE/index.html" && -f "$APP_ROOT/../dist/index.html" ]]; then
  DEFAULT_SITE="$APP_ROOT/../dist"
fi
SITE_DIR="${SITE_DIR:-$DEFAULT_SITE}"
SCENE_DIR="${SCENE_DIR:-$APP_ROOT/scenes}"

if [[ ! -f "$SITE_DIR/index.html" ]]; then
  echo "No built site at $SITE_DIR; run 'npm ci && npm run build' first." >&2
  exit 1
fi

export PORT="$VIEWER_PORT" SITE_DIR SCENE_DIR
exec python3 "$APP_ROOT/scene_server.py"
