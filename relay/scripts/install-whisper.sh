#!/usr/bin/env bash
set -euo pipefail

WHISPER_TAG="v1.9.5"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp"
MODELS=(small.en medium.en large-v3-turbo)

USAGE="usage: install-whisper.sh [--gpu none|cuda|metal] [--prefix <dir>]
  --gpu     none (cpu only), cuda (needs nvcc), metal (macOS). default: metal on macOS arm64, none elsewhere
  --prefix  whisper.cpp checkout and build dir, models go next to it in ../models. default: \$T3_CARDPUTER_WHISPER_DIR or ~/.local/share/t3-cardputer/whisper"

OS="$(uname -s)"
case "$OS" in
  Darwin | Linux) ;;
  *)
    echo "$OS is not supported: the relay host must be macOS or Linux" >&2
    exit 1
    ;;
esac

GPU=""
BIN_DIR="${T3_CARDPUTER_WHISPER_DIR:-$HOME/.local/share/t3-cardputer/whisper}"
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu)
      GPU="${2:?--gpu needs none, cuda or metal}"
      shift 2
      ;;
    --prefix)
      BIN_DIR="${2:?--prefix needs a directory}"
      shift 2
      ;;
    -h | --help)
      echo "$USAGE"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "$USAGE" >&2
      exit 2
      ;;
  esac
done

if [ -z "$GPU" ]; then
  if [ "$OS" = Darwin ] && [ "$(uname -m)" = arm64 ]; then GPU=metal; else GPU=none; fi
fi

case "$GPU" in
  none) CMAKE_GPU_FLAGS=(-DGGML_CUDA=OFF -DGGML_METAL=OFF) ;;
  cuda)
    if ! command -v nvcc >/dev/null 2>&1; then
      echo "--gpu cuda needs the CUDA toolkit (nvcc not found)" >&2
      echo "install the toolkit from https://developer.nvidia.com/cuda-downloads, put its bin dir on PATH, or run with --gpu none" >&2
      exit 1
    fi
    CMAKE_GPU_FLAGS=(-DGGML_CUDA=ON -DGGML_METAL=OFF)
    ;;
  metal)
    if [ "$OS" != Darwin ]; then
      echo "--gpu metal needs macOS, this is $OS: run with --gpu none or --gpu cuda" >&2
      exit 1
    fi
    CMAKE_GPU_FLAGS=(-DGGML_CUDA=OFF -DGGML_METAL=ON)
    ;;
  *)
    echo "unknown --gpu value: $GPU (use none, cuda or metal)" >&2
    exit 2
    ;;
esac

MODELS_DIR="$(dirname "$BIN_DIR")/models"
SERVER="$BIN_DIR/build/bin/whisper-server"

exec 3>&1 1>&2

use_homebrew_cmake() {
  local brew_bin
  for brew_bin in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -n "$brew_bin" ] && [ -x "$brew_bin" ] || continue
    local prefix
    prefix="$("$brew_bin" --prefix 2>/dev/null)" || continue
    if [ -x "$prefix/bin/cmake" ]; then
      export PATH="$prefix/bin:$PATH"
      return 0
    fi
  done
  return 1
}

ensure_cmake() {
  if command -v cmake >/dev/null 2>&1; then
    echo "cmake: using $(command -v cmake)"
    return
  fi
  if [ "$OS" = Darwin ] && use_homebrew_cmake; then
    echo "cmake: using Homebrew's $(command -v cmake)"
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
  if [ "$OS" = Darwin ]; then
    echo "cmake is missing and could not be installed user-local. Install it with: brew install cmake" >&2
  else
    echo "cmake is missing and could not be installed user-local. Install it with: sudo apt install cmake" >&2
  fi
  exit 1
}

if [ "$OS" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
  echo "the Xcode command line tools are missing, install them with: xcode-select --install" >&2
  exit 1
fi

ensure_cmake

JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

mkdir -p "$(dirname "$BIN_DIR")" "$MODELS_DIR"
if [ ! -d "$BIN_DIR/.git" ]; then
  echo "clone: $WHISPER_REPO $WHISPER_TAG into $BIN_DIR"
  git clone --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$BIN_DIR"
else
  echo "clone: $BIN_DIR exists, checking out $WHISPER_TAG"
  git -C "$BIN_DIR" fetch --depth 1 origin "refs/tags/$WHISPER_TAG:refs/tags/$WHISPER_TAG"
  git -C "$BIN_DIR" checkout --quiet "$WHISPER_TAG"
fi

echo "build: whisper-server, gpu $GPU"
cmake -S "$BIN_DIR" -B "$BIN_DIR/build" -DCMAKE_BUILD_TYPE=Release "${CMAKE_GPU_FLAGS[@]}"
cmake --build "$BIN_DIR/build" -j "$JOBS" --config Release --target whisper-server

for model in "${MODELS[@]}"; do
  if [ -s "$MODELS_DIR/ggml-$model.bin" ]; then
    echo "model: $model already at $MODELS_DIR"
    continue
  fi
  echo "model: downloading $model into $MODELS_DIR"
  "$BIN_DIR/models/download-ggml-model.sh" "$model" "$MODELS_DIR"
done

echo "done: whisper-server built with gpu $GPU, models in $MODELS_DIR"
echo "$SERVER" >&3
