#!/usr/bin/env bash
set -euo pipefail

FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$FW_DIR/build-release"
cd "$FW_DIR"

# receipt: docs/receipts/2026-10-21-launcher-slot.md "slot", Launcher 2.9.1 on 8 MB flash leaves 0x170000..0x800000 free for installed apps
LAUNCHER_APP_SLOT_BYTES=$((0x800000 - 0x170000))
LAUNCHER_APP_ALIGN=$((0x10000))
LEAK_PATTERN='[a-z0-9]\.ts\.net|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+|prod-[0-9a-f]+\.t3coderelay'

. "$FW_DIR/scripts/idf-env.sh"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/t3-cardputer-app.bin" "$OUT_DIR/t3-cardputer-full.bin"
rm -f "$OUT_DIR/sdkconfig"
rm -rf "$OUT_DIR/web"
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

version=${T3_VERSION:-$(git -C "$FW_DIR" describe --tags --always --dirty 2>/dev/null || true)}
if [[ -z "$version" ]]; then
  echo "release version unknown: git describe failed (no repo access?) and T3_VERSION is empty; set T3_VERSION=<tag>" >&2
  exit 1
fi
python3 "$FW_DIR/scripts/web-manifest.py" "$OUT_DIR" "$FW_DIR/partitions.csv" "$FW_DIR/components/t3core/include/t3/protocol.h" "$OUT_DIR/web" "$version"

# why: scan only what ships; cmake caches and ELF paths in the rest of build-release/ are false-positive surface
leak_status=0
leaks=$(grep -raEl "$LEAK_PATTERN" "$OUT_DIR/web" "$OUT_DIR"/t3-cardputer-*.bin) || leak_status=$?
if (( leak_status == 0 )); then
  rm -rf "$OUT_DIR/web"
  echo "release leak check failed: relay url, tailnet name or tailscale ip found in:" >&2
  echo "$leaks" >&2
  exit 1
fi
if (( leak_status != 1 )); then
  rm -rf "$OUT_DIR/web"
  echo "release leak check could not read the release parts (grep exit $leak_status)" >&2
  exit 1
fi

echo "full image at 0x0 erases NVS (wifi + token); scripts/flash-app.sh writes only the app and keeps it"
