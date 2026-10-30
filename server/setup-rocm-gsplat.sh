#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Experimental Radeon build path for the upstream gsplat HIP pull request.
# The server keeps using PyTorch's torch.cuda API: ROCm intentionally exposes
# the same API surface, while torch.version.hip identifies the backend.
CONDA_ENV="${CONDA_ENV:-ljq-rocm}"
CONDA_ROOT="${CONDA_ROOT:-$HOME/miniconda3}"
GSPLAT_SRC="${GSPLAT_SRC:-$HOME/luma/gsplat-rocm-src}"
ROCM_HEADER_ROOT="${ROCM_HEADER_ROOT:-$HOME/luma/rocm-headers}"
GPU_ARCH="${PYTORCH_ROCM_ARCH:-gfx1101}"

source "$CONDA_ROOT/etc/profile.d/conda.sh"
conda activate "$CONDA_ENV"

if [[ "$(python -c 'import torch; print(torch.version.hip or "")')" == "" ]]; then
  echo "The '$CONDA_ENV' environment does not contain a ROCm PyTorch build." >&2
  exit 1
fi

ROCM_HOME="${ROCM_HOME:-$(python -c 'import importlib.util, pathlib; spec = importlib.util.find_spec("_rocm_sdk_devel") or importlib.util.find_spec("_rocm_sdk_core"); print(pathlib.Path(spec.origin).parent)')}"
export ROCM_HOME ROCM_PATH="$ROCM_HOME" HIP_PATH="$ROCM_HOME"
export PYTORCH_ROCM_ARCH="$GPU_ARCH" MAX_JOBS="${MAX_JOBS:-4}" BUILD_EXPERIMENTAL=0
export GSPLAT_OPT_LEVEL="${GSPLAT_OPT_LEVEL:-1}"

if [[ ! -d "$GSPLAT_SRC/.git" ]]; then
  git clone https://github.com/HPC-Ken/gsplat.git "$GSPLAT_SRC"
  git -C "$GSPLAT_SRC" checkout 071410dc576f3a1c1200625a04fb0cb2a98b2aff
fi
compat_patch="$APP_ROOT/patches/gsplat-rocm-7.14.patch"
if [[ -f "$compat_patch" ]] && ! grep -q LUMA_ROCM_714 "$GSPLAT_SRC/gsplat/hip/include/cooperative_groups/reduce.h"; then
  patch -d "$GSPLAT_SRC" -p1 < "$compat_patch"
fi
opt_patch="$APP_ROOT/patches/gsplat-configurable-opt.patch"
if [[ -f "$opt_patch" ]] && ! grep -q GSPLAT_OPT_LEVEL "$GSPLAT_SRC/gsplat/hip/build.py"; then
  patch -d "$GSPLAT_SRC" -p1 < "$opt_patch"
fi

# The rocThrust source archive normally generates this header during CMake
# installation.  Header-only fallback builds need the same generated values.
version_template="$ROCM_HEADER_ROOT/rocThrust/thrust/rocthrust_version.hpp.in"
version_header="$ROCM_HEADER_ROOT/rocThrust/thrust/rocthrust_version.hpp"
if [[ -f "$version_template" && ! -f "$version_header" ]]; then
  sed \
    -e 's/@rocthrust_VERSION_NUMBER@/400200/g' \
    -e 's/@rocthrust_VERSION_MAJOR@/4/g' \
    -e 's/@rocthrust_VERSION_MINOR@/2/g' \
    -e 's/@rocthrust_VERSION_PATCH@/0/g' \
    "$version_template" > "$version_header"
fi
rocprim_template="$ROCM_HEADER_ROOT/rocPRIM/rocprim/include/rocprim/rocprim_version.hpp.in"
rocprim_header="$ROCM_HEADER_ROOT/rocPRIM/rocprim/include/rocprim/rocprim_version.hpp"
if [[ -f "$rocprim_template" && ! -f "$rocprim_header" ]]; then
  sed \
    -e 's/@rocprim_VERSION_NUMBER@/400800/g' \
    -e 's/@rocprim_VERSION_MAJOR@/4/g' \
    -e 's/@rocprim_VERSION_MINOR@/8/g' \
    -e 's/@rocprim_VERSION_PATCH@/0/g' \
    "$rocprim_template" > "$rocprim_header"
fi
hipcub_template="$ROCM_HEADER_ROOT/hipCUB/hipcub/include/hipcub/hipcub_version.hpp.in"
hipcub_header="$ROCM_HEADER_ROOT/hipCUB/hipcub/include/hipcub/hipcub_version.hpp"
if [[ -f "$hipcub_template" && ! -f "$hipcub_header" ]]; then
  sed \
    -e 's/@hipcub_VERSION_NUMBER@/400701/g' \
    -e 's/@hipcub_VERSION_MAJOR@/4/g' \
    -e 's/@hipcub_VERSION_MINOR@/7/g' \
    -e 's/@hipcub_VERSION_PATCH@/1/g' \
    "$hipcub_template" > "$hipcub_header"
fi

compat_include="$ROCM_HEADER_ROOT/compat"
if [[ -f "$ROCM_HEADER_ROOT/hipSPARSE/library/include/hipsparse.h" ]]; then
  mkdir -p "$compat_include/hipsparse"
  ln -sfn "$ROCM_HEADER_ROOT/hipSPARSE/library/include/hipsparse.h" "$compat_include/hipsparse/hipsparse.h"
  cp "$APP_ROOT/compat/hipsparse/hipsparse-export.h" "$compat_include/hipsparse/hipsparse-export.h"
  cp "$APP_ROOT/compat/hipsparse/hipsparse-version.h" "$compat_include/hipsparse/hipsparse-version.h"
fi
if [[ -f "$ROCM_HEADER_ROOT/hipBLAS/library/include/hipblas.h" ]]; then
  mkdir -p "$compat_include/hipblas"
  ln -sfn "$ROCM_HEADER_ROOT/hipBLAS/library/include/hipblas.h" "$compat_include/hipblas/hipblas.h"
  cp "$APP_ROOT/compat/hipblas/"*.h "$compat_include/hipblas/"
fi
if [[ -f "$ROCM_HEADER_ROOT/hipSOLVER/library/include/hipsolver.h" ]]; then
  mkdir -p "$compat_include/hipsolver/internal"
  ln -sfn "$ROCM_HEADER_ROOT/hipSOLVER/library/include/hipsolver.h" "$compat_include/hipsolver/hipsolver.h"
  for header in "$ROCM_HEADER_ROOT/hipSOLVER/library/include/internal/"*.h; do
    [[ -f "$header" ]] && ln -sfn "$header" "$compat_include/hipsolver/internal/$(basename "$header")"
  done
  cp "$APP_ROOT/compat/hipsolver/"*.h "$compat_include/hipsolver/internal/"
fi
if [[ -d "$ROCM_HEADER_ROOT/hipBLASLt/library/include/hipblaslt" ]]; then
  mkdir -p "$compat_include/hipblaslt"
  for header in "$ROCM_HEADER_ROOT/hipBLASLt/library/include/hipblaslt/"*.h; do
    [[ -f "$header" ]] && ln -sfn "$header" "$compat_include/hipblaslt/$(basename "$header")"
  done
  cp "$APP_ROOT/compat/hipblaslt/"*.h "$compat_include/hipblaslt/"
fi

# A full rocm-sdk-devel wheel provides these headers itself.  The small
# header-only fallback is useful when the 500+ MiB wheel mirror is too slow.
header_flags=()
for directory in \
  "$compat_include" \
  "$ROCM_HEADER_ROOT/hipSPARSE/library/include" \
  "$ROCM_HEADER_ROOT/rocSPARSE/library/include" \
  "$ROCM_HEADER_ROOT/hipBLAS/library/include" \
  "$ROCM_HEADER_ROOT/hipBLAS-common/library/include" \
  "$ROCM_HEADER_ROOT/hipSOLVER/library/include" \
  "$ROCM_HEADER_ROOT/rocThrust" \
  "$ROCM_HEADER_ROOT/rocPRIM/rocprim/include" \
  "$ROCM_HEADER_ROOT/hipCUB/hipcub/include"; do
  if [[ -d "$directory" ]]; then
    header_flags+=("-I$directory")
  fi
done
if (( ${#header_flags[@]} )); then
  joined="${header_flags[*]}"
  export CXXFLAGS="${CXXFLAGS:-} $joined"
  export HIPCC_FLAGS="${HIPCC_FLAGS:-} $joined"
fi

bitcode="$ROCM_HOME/lib/llvm/amdgcn/bitcode"
if [[ -d "$bitcode" ]]; then
  export HIPCC_FLAGS="${HIPCC_FLAGS:-} --rocm-device-lib-path=$bitcode"
fi
if [[ -d /usr/lib/gcc/x86_64-linux-gnu/13 ]]; then
  export HIPCC_FLAGS="${HIPCC_FLAGS:-} --gcc-install-dir=/usr/lib/gcc/x86_64-linux-gnu/13"
fi

python -m pip install ninja jaxtyping nvtx
python -m pip install --no-build-isolation --no-deps --force-reinstall "$GSPLAT_SRC"
python - <<'PY'
import torch
from gsplat import rasterization
print({
    "torch": torch.__version__,
    "hip": torch.version.hip,
    "device": torch.cuda.get_device_name(0),
    "arch": torch.cuda.get_device_properties(0).gcnArchName,
    "gsplat_rasterization": bool(rasterization),
})
PY
