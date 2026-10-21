#!/usr/bin/env bash
set -euo pipefail
printf 'install-whisper %s\n' "$*" >>"$STUB_STATE/calls.log"
[ "$1" = --gpu ] && [ "$3" = --prefix ] || { echo "fake install-whisper: unexpected $*" >&2; exit 2; }
echo "building whisper.cpp ($2)" >&2
mkdir -p "$4/build/bin"
echo "$4/build/bin/whisper-server"
