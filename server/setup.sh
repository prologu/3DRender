#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/workspace/luma-server-render}"
DEPS="$APP_ROOT/python"
TUNA="https://pypi.tuna.tsinghua.edu.cn/simple"
TORCH_WHEEL="https://mirror.sjtu.edu.cn/pytorch-wheels/cu118/torch-2.0.1%2Bcu118-cp310-cp310-linux_x86_64.whl"
TORCH_FILENAME="torch-2.0.1+cu118-cp310-cp310-linux_x86_64.whl"
GSPLAT_FILENAME="gsplat-1.5.3+pt20cu118-cp310-cp310-linux_x86_64.whl"
WHEEL_DIR="$APP_ROOT/wheels"
LOCAL_TORCH_WHEEL="$WHEEL_DIR/$TORCH_FILENAME"
LOCAL_GSPLAT_WHEEL="$WHEEL_DIR/$GSPLAT_FILENAME"
GSPLAT_WHEEL_URL="https://github.com/nerfstudio-project/gsplat/releases/download/v1.5.3/gsplat-1.5.3%2Bpt20cu118-cp310-cp310-linux_x86_64.whl"
REQUIREMENTS="$APP_ROOT/requirements-cu118.txt"

PYTHON_ABI="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "$PYTHON_ABI" != "3.10" ]]; then
  echo "Python 3.10 is required by the pinned cp310 PyTorch/gsplat wheels; found $PYTHON_ABI" >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This server runtime requires Linux x86_64" >&2
  exit 1
fi

mkdir -p "$DEPS"
if [[ "${OFFLINE:-0}" == "1" ]]; then
  for required in "$LOCAL_TORCH_WHEEL" "$LOCAL_GSPLAT_WHEEL" "$REQUIREMENTS"; do
    if [[ ! -f "$required" ]]; then
      echo "Missing offline dependency: $required" >&2
      exit 1
    fi
  done
  python3 -m pip install --upgrade --target "$DEPS" --no-deps \
    --no-index --find-links "$WHEEL_DIR" -r "$REQUIREMENTS"
  python3 -m pip install --upgrade --target "$DEPS" "$LOCAL_TORCH_WHEEL" --no-deps
  python3 -m pip install --upgrade --target "$DEPS" "$LOCAL_GSPLAT_WHEEL" --no-deps
else
  python3 -m pip install --upgrade --target "$DEPS" pip setuptools wheel -i "$TUNA"
  python3 -m pip install --upgrade --target "$DEPS" "$TORCH_WHEEL" --no-deps
  python3 -m pip install --upgrade --target "$DEPS" --no-deps -r "$REQUIREMENTS" -i "$TUNA"
  if [[ -f "$LOCAL_GSPLAT_WHEEL" ]]; then
    python3 -m pip install --upgrade --target "$DEPS" "$LOCAL_GSPLAT_WHEEL" --no-deps
  else
    python3 -m pip install --upgrade --target "$DEPS" "$GSPLAT_WHEEL_URL" --no-deps
  fi
fi

PYTHONPATH="$DEPS" python3 - <<'PY'
import torch
import gsplat
print(f"torch={torch.__version__} cuda={torch.version.cuda} available={torch.cuda.is_available()}")
print(f"gsplat={gsplat.__version__}")
PY
