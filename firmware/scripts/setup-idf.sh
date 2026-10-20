#!/usr/bin/env bash
set -euo pipefail

IDF_VERSION=v5.4.2
IDF_ROOT="${IDF_PATH:-$HOME/esp/esp-idf}"

if [[ ! -d "$IDF_ROOT/.git" ]]; then
  mkdir -p "$(dirname "$IDF_ROOT")"
  git clone -b "$IDF_VERSION" --recursive --shallow-submodules --depth 1 \
    https://github.com/espressif/esp-idf.git "$IDF_ROOT"
fi

. "$(dirname "$0")/idf-python.sh"

cd "$IDF_ROOT"
./install.sh esp32s3
. ./export.sh
python tools/idf_tools.py install cmake ninja

echo
echo "ready. in a new shell:"
echo "  . $IDF_ROOT/export.sh"
