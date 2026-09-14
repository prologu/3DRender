#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/workspace/luma-server-render}"
DEPS="$APP_ROOT/python"
TUNA="https://pypi.tuna.tsinghua.edu.cn/simple"
TORCH_WHEEL="https://mirror.sjtu.edu.cn/pytorch-wheels/cu118/torch-2.0.1%2Bcu118-cp310-cp310-linux_x86_64.whl"
GSPLAT_FILENAME="gsplat-1.5.3+pt20cu118-cp310-cp310-linux_x86_64.whl"
LOCAL_GSPLAT_WHEEL="$APP_ROOT/wheels/$GSPLAT_FILENAME"
GSPLAT_WHEEL_URL="https://github.com/nerfstudio-project/gsplat/releases/download/v1.5.3/gsplat-1.5.3%2Bpt20cu118-cp310-cp310-linux_x86_64.whl"

mkdir -p "$DEPS"
python3 -m pip install --upgrade --target "$DEPS" pip setuptools wheel -i "$TUNA"
python3 -m pip install --upgrade --target "$DEPS" "$TORCH_WHEEL" --no-deps
python3 -m pip install --upgrade --target "$DEPS" --no-deps \
  filelock==3.16.1 typing-extensions==4.12.2 sympy==1.13.3 mpmath==1.3.0 \
  networkx==3.4.2 jinja2==3.1.6 markupsafe==3.0.2 triton==2.0.0 \
  numpy==1.26.4 pillow==10.4.0 ninja==1.11.1.1 packaging==24.2 \
  jaxtyping==0.2.36 typeguard==2.13.3 wadler-lindig==0.1.7 \
  rich==13.9.4 markdown-it-py==3.0.0 mdurl==0.1.2 pygments==2.18.0 \
  -i "$TUNA"
if [[ -f "$LOCAL_GSPLAT_WHEEL" ]]; then
  python3 -m pip install --upgrade --target "$DEPS" "$LOCAL_GSPLAT_WHEEL" --no-deps
else
  python3 -m pip install --upgrade --target "$DEPS" "$GSPLAT_WHEEL_URL" --no-deps
fi

PYTHONPATH="$DEPS" python3 - <<'PY'
import torch
import gsplat
print(f"torch={torch.__version__} cuda={torch.version.cuda} available={torch.cuda.is_available()}")
print(f"gsplat={gsplat.__version__}")
PY
