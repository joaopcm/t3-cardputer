#!/usr/bin/env bash
set -euo pipefail

FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$FW_DIR"

# receipt: docs/receipts/2026-10-21-firmware-voice.md "heap", the debug .bss the connect-after-voice A/B soaked
DEBUG_BSS_BYTES=25024

. "$FW_DIR/scripts/idf-env.sh"

if [[ ! -f sdkconfig || sdkconfig.defaults -nt sdkconfig || partitions.csv -nt sdkconfig ]]; then
  rm -f sdkconfig
  idf.py set-target esp32s3
fi

idf.py build "$@"
"$FW_DIR/scripts/check-bss.sh" "$FW_DIR/build/t3_cardputer.elf" "$DEBUG_BSS_BYTES"
