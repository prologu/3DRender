#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
VIEWER_PORT="${PORT:-8088}"
DEFAULT_SITE="$APP_ROOT/site"
if [[ ! -f "$DEFAULT_SITE/index.html" && -f "$APP_ROOT/../dist/index.html" ]]; then
  DEFAULT_SITE="$APP_ROOT/../dist"
fi
SITE_DIR="${SITE_DIR:-$DEFAULT_SITE}"

if [[ ! -f "$SITE_DIR/index.html" ]]; then
  echo "No built site at $SITE_DIR; run 'npm ci && npm run build' first." >&2
  exit 1
fi

exec python3 -m http.server "$VIEWER_PORT" --bind 0.0.0.0 --directory "$SITE_DIR"
