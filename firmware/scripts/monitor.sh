#!/usr/bin/env bash
set -euo pipefail

SECONDS_TO_CAPTURE="${1:-10}"
PORT="${PORT:-/dev/ttyACM0}"

. "$(cd "$(dirname "$0")" && pwd)/idf-env.sh"

exec python - "$PORT" "$SECONDS_TO_CAPTURE" <<'PY'
import sys
import time

import serial

port, seconds = sys.argv[1], float(sys.argv[2])
with serial.Serial() as ser:
    ser.port = port
    ser.baudrate = 115200
    ser.timeout = 0.2
    ser.dtr = False
    ser.rts = False
    ser.open()
    ser.dtr = False
    ser.rts = True
    time.sleep(0.1)
    ser.rts = False
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        chunk = ser.read(4096)
        if chunk:
            sys.stdout.write(chunk.decode("utf-8", errors="replace"))
            sys.stdout.flush()
PY
