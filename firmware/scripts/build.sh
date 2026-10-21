#!/usr/bin/env bash
set -euo pipefail

FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$FW_DIR"

. "$FW_DIR/scripts/idf-env.sh"

if [[ ! -f sdkconfig || sdkconfig.defaults -nt sdkconfig || partitions.csv -nt sdkconfig ]]; then
  rm -f sdkconfig
  idf.py set-target esp32s3
fi

idf.py build "$@"
