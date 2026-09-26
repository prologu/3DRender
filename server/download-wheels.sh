#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
WHEEL_DIR="${WHEEL_DIR:-$APP_ROOT/wheels}"
TUNA="https://pypi.tuna.tsinghua.edu.cn/simple"
TORCH_FILENAME="torch-2.0.1+cu118-cp310-cp310-linux_x86_64.whl"
TORCH_URL="https://mirror.sjtu.edu.cn/pytorch-wheels/cu118/torch-2.0.1%2Bcu118-cp310-cp310-linux_x86_64.whl"
GSPLAT_FILENAME="gsplat-1.5.3+pt20cu118-cp310-cp310-linux_x86_64.whl"
GSPLAT_URL="https://github.com/nerfstudio-project/gsplat/releases/download/v1.5.3/gsplat-1.5.3%2Bpt20cu118-cp310-cp310-linux_x86_64.whl"

mkdir -p "$WHEEL_DIR"
python3 -m pip download \
  --dest "$WHEEL_DIR" \
  --only-binary=:all: \
  --platform manylinux2014_x86_64 \
  --python-version 310 \
  --implementation cp \
  --abi cp310 \
  --no-deps \
  -r "$APP_ROOT/requirements-cu118.txt" \
  -i "$TUNA"

download() {
  local url="$1"
  local destination="$2"
  if [[ -f "$destination" ]]; then
    echo "Already present: $destination"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$destination" "$url"
  else
    echo "curl or wget is required" >&2
    exit 1
  fi
}

download "$TORCH_URL" "$WHEEL_DIR/$TORCH_FILENAME"
download "$GSPLAT_URL" "$WHEEL_DIR/$GSPLAT_FILENAME"
echo "Offline bundle is ready in $WHEEL_DIR"
