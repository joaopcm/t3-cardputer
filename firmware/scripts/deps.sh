#!/usr/bin/env bash
set -euo pipefail

FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
M5GFX_TAG=0.2.33
M5UNIFIED_TAG=0.2.27

clone_pinned() {
  local name=$1 tag=$2
  [[ -d "$FW_DIR/components/$name" ]] && return 0
  git clone --branch "$tag" --depth 1 -c advice.detachedHead=false \
    "https://github.com/m5stack/$name.git" "$FW_DIR/components/$name"
}

clone_pinned M5GFX "$M5GFX_TAG"
clone_pinned M5Unified "$M5UNIFIED_TAG"
