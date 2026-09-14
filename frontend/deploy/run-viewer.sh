#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
VIEWER_PORT="${PORT:-8088}"

exec python3 -m http.server "$VIEWER_PORT" --bind 0.0.0.0 --directory "$APP_ROOT/site"
