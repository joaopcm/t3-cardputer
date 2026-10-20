#!/usr/bin/env bash
set -euo pipefail

FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-/dev/ttyACM0}"
cd "$FW_DIR"

. "$FW_DIR/scripts/idf-env.sh"
idf.py -p "$PORT" flash "$@"
