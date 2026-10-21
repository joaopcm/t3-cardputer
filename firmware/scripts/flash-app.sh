#!/usr/bin/env bash
set -euo pipefail

FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-/dev/ttyACM0}"
APP="${1:-$FW_DIR/build-release/t3-cardputer-app.bin}"
APP_DESC_MAGIC_OFFSET=32

size_to_bytes() {
  local value=${1^^}
  case "$value" in
    *K) echo $(( ${value%K} * 1024 )) ;;
    *M) echo $(( ${value%M} * 1024 * 1024 )) ;;
    *) echo $(( value )) ;;
  esac
}

IFS=', ' read -r _ _ _ factory_offset factory_size_text _ < <(grep -E '^factory[ ,]' "$FW_DIR/partitions.csv")
factory_size=$(size_to_bytes "$factory_size_text")

if [[ ! -f "$APP" ]]; then
  echo "app image check failed: $APP does not exist" >&2
  exit 1
fi

app_bytes=$(stat -c %s "$APP")
if (( app_bytes > factory_size )); then
  echo "app image size check failed: factory partition=$factory_size bytes, image is $app_bytes" >&2
  exit 1
fi

if (( app_bytes < APP_DESC_MAGIC_OFFSET + 4 )); then
  echo "app descriptor check failed: image is $app_bytes bytes, too short to hold the descriptor magic at offset $APP_DESC_MAGIC_OFFSET" >&2
  exit 1
fi

magic=$(od -An -tx1 -j "$APP_DESC_MAGIC_OFFSET" -N4 "$APP" | tr -d ' \n')
magic_le=$(echo "$magic" | sed -E 's/(..)(..)(..)(..)/\4\3\2\1/')
if [[ "$magic_le" != "abcd5432" ]]; then
  echo "app descriptor check failed: magic at offset $APP_DESC_MAGIC_OFFSET is 0x$magic_le, needed 0xabcd5432 (a merged full image is not an app image)" >&2
  exit 1
fi

. "$FW_DIR/scripts/idf-env.sh"
python -m esptool --chip esp32s3 -p "$PORT" -b 460800 --before default_reset --after hard_reset \
  write_flash --flash_mode dio --flash_size 8MB --flash_freq 80m "$factory_offset" "$APP"
