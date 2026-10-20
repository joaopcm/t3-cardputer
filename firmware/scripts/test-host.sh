#!/usr/bin/env bash
set -euo pipefail

HOST_DIR="$(cd "$(dirname "$0")/../test/host" && pwd)"
BUILD_DIR="$HOST_DIR/build"

if command -v cmake >/dev/null 2>&1; then
  cmake_cmd=(cmake)
  ctest_cmd=(ctest)
else
  cmake_cmd=(uvx --from cmake cmake)
  ctest_cmd=(uvx --from cmake ctest)
fi

"${cmake_cmd[@]}" -S "$HOST_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Debug
"${cmake_cmd[@]}" --build "$BUILD_DIR" -j
"${ctest_cmd[@]}" --test-dir "$BUILD_DIR" --output-on-failure
