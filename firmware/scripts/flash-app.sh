#!/usr/bin/env bash
set -euo pipefail

FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-/dev/ttyACM0}"
APP="${1:-$FW_DIR/build-release/t3-cardputer-app.bin}"

. "$FW_DIR/scripts/idf-env.sh"
python -m esptool --chip esp32s3 -p "$PORT" -b 460800 --before default_reset --after hard_reset \
  write_flash --flash_mode dio --flash_size 8MB --flash_freq 80m 0x10000 "$APP"
