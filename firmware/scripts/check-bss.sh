#!/usr/bin/env bash
set -euo pipefail

elf=$1
receipted=$2
symbols=$(xtensa-esp32s3-elf-nm "$elf")
bss_start=$(awk '$3 == "_bss_start" { print $1 }' <<<"$symbols")
bss_end=$(awk '$3 == "_bss_end" { print $1 }' <<<"$symbols")
if [[ -z "$bss_start" || -z "$bss_end" ]]; then
  echo "bss check failed: no _bss_start or _bss_end symbol in $elf" >&2
  exit 1
fi
bss=$(( 0x$bss_end - 0x$bss_start ))
if (( bss != receipted )); then
  echo "bss=$receipted, build has $bss: re-soak connect-after-voice (docs/receipts/2026-10-21-firmware-voice.md \"heap\") and update the receipt" >&2
  exit 1
fi
