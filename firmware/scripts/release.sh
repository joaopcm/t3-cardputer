#!/usr/bin/env bash
set -euo pipefail

FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$FW_DIR/build-release"
cd "$FW_DIR"

# receipt: docs/receipts/2026-10-21-launcher-slot.md "slot", Launcher 2.9.1 on 8 MB flash leaves 0x170000..0x800000 free for installed apps
LAUNCHER_APP_SLOT_BYTES=$((0x800000 - 0x170000))
LAUNCHER_APP_ALIGN=$((0x10000))

. "$FW_DIR/scripts/idf-env.sh"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/t3-cardputer-app.bin" "$OUT_DIR/t3-cardputer-full.bin"
rm -f "$OUT_DIR/sdkconfig"
export IDF_TARGET=esp32s3
idf.py -B "$OUT_DIR" \
  -DSDKCONFIG="$OUT_DIR/sdkconfig" \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.release" \
  build

for option in T3_DEBUG_SERIAL T3_KEYBOARD_TRACE; do
  if ! grep -qx "# CONFIG_$option is not set" "$OUT_DIR/sdkconfig"; then
    echo "release build has CONFIG_$option enabled; refusing to produce artifacts" >&2
    exit 1
  fi
done

app_bytes=$(stat -c %s "$OUT_DIR/t3_cardputer.bin")
needed=$(( (app_bytes + LAUNCHER_APP_ALIGN - 1) / LAUNCHER_APP_ALIGN * LAUNCHER_APP_ALIGN ))
if (( needed > LAUNCHER_APP_SLOT_BYTES )); then
  echo "launcher app slot=$LAUNCHER_APP_SLOT_BYTES bytes, app image needed $needed" >&2
  exit 1
fi

cp "$OUT_DIR/t3_cardputer.bin" "$OUT_DIR/t3-cardputer-app.bin"
idf.py -B "$OUT_DIR" merge-bin -o "$OUT_DIR/t3-cardputer-full.bin"

full_bytes=$(stat -c %s "$OUT_DIR/t3-cardputer-full.bin")
echo "app image $app_bytes bytes (partition $needed of launcher slot $LAUNCHER_APP_SLOT_BYTES), full image $full_bytes bytes"
echo "artifacts embed the relay URL: keep them local, never commit or upload"
echo "full image at 0x0 erases NVS (wifi + token); scripts/flash-app.sh writes only the app and keeps it"
