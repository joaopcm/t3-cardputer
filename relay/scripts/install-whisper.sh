#!/usr/bin/env bash
set -euo pipefail

WHISPER_TAG="v1.9.5"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp"
MODELS=(small.en medium.en large-v3-turbo)

BIN_DIR="${1:-${T3_CARDPUTER_WHISPER_DIR:-$HOME/.local/share/t3-cardputer/whisper}}"
MODELS_DIR="$(dirname "$BIN_DIR")/models"

ensure_cmake() {
  if command -v cmake >/dev/null 2>&1; then
    echo "cmake: using $(command -v cmake)"
    return
  fi
  if command -v uv >/dev/null 2>&1; then
    echo "cmake: not on PATH, installing a user-local copy with 'uv tool install cmake' (no sudo)"
    uv tool install cmake
    export PATH="$(uv tool dir --bin):$PATH"
    if command -v cmake >/dev/null 2>&1; then
      echo "cmake: installed user-local at $(command -v cmake)"
      return
    fi
  fi
  echo "cmake is missing and could not be installed user-local. Install it with: sudo apt install cmake" >&2
  exit 1
}

ensure_cmake

mkdir -p "$(dirname "$BIN_DIR")" "$MODELS_DIR"
if [ ! -d "$BIN_DIR/.git" ]; then
  echo "clone: $WHISPER_REPO $WHISPER_TAG into $BIN_DIR"
  git clone --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$BIN_DIR"
else
  echo "clone: $BIN_DIR exists, checking out $WHISPER_TAG"
  git -C "$BIN_DIR" fetch --depth 1 origin "refs/tags/$WHISPER_TAG:refs/tags/$WHISPER_TAG"
  git -C "$BIN_DIR" checkout --quiet "$WHISPER_TAG"
fi

echo "build: whisper-server, CPU only"
cmake -S "$BIN_DIR" -B "$BIN_DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BIN_DIR/build" -j "$(nproc)" --config Release --target whisper-server

for model in "${MODELS[@]}"; do
  if [ -s "$MODELS_DIR/ggml-$model.bin" ]; then
    echo "model: $model already at $MODELS_DIR"
    continue
  fi
  echo "model: downloading $model into $MODELS_DIR"
  "$BIN_DIR/models/download-ggml-model.sh" "$model" "$MODELS_DIR"
done

echo "done: $BIN_DIR/build/bin/whisper-server, models in $MODELS_DIR"
