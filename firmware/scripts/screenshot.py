#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "pyserial"]
# ///
import argparse
import re
import sys
import time

import serial
from PIL import Image

STX = b"\x02"
ETX = b"\x03"
SCALE = 3
TIMEOUT_S = 8.0

PALETTE = [
    0xD8D8D8,  # Text
    0x6B6B6B,  # Dim
    0xFFB020,  # Warn
    0x4FC3F7,  # Run
    0x7BD88F,  # Ok
    0xFF6B6B,  # Red
    0xFFFFFF,  # Hdr
    0x2D4A7A,  # SelBg
    0x1A1A1A,  # BarBg
    0x000000,  # black
]


def open_port(path):
    # Linux raises DTR and RTS on open. Lowering RTS first avoids the (DTR=0, RTS=1) state that resets the chip.
    ser = serial.Serial()
    ser.port = path
    ser.baudrate = 115200
    ser.timeout = 0.2
    ser.open()
    ser.rts = False
    ser.dtr = False
    return ser


def read_frame(ser, start_marker):
    deadline = time.monotonic() + TIMEOUT_S
    buf = b""
    while time.monotonic() < deadline:
        buf += ser.read(4096)
        start = buf.find(STX + start_marker)
        if start < 0:
            continue
        end = buf.find(ETX, start)
        if end >= 0:
            return buf[start + 1 : end].decode("ascii", errors="replace")
    sys.exit(f"no {start_marker.decode()} reply within {TIMEOUT_S}s")


def decode_shot(frame):
    lines = frame.splitlines()
    header = lines[0].split()
    if header[0] != "SHOT" or len(header) != 4:
        sys.exit(f"bad header: {lines[0]!r}")
    width, height, bpp = (int(v) for v in header[1:])
    if bpp != 4:
        sys.exit(f"bpp={bpp}, only 4 supported")
    row_hex = (width * bpp + 7) // 8 * 2
    row_re = re.compile(rf"^[0-9a-f]{{{row_hex}}}$")
    rows = [line for line in lines[1:] if row_re.match(line)]
    if len(rows) != height:
        sys.exit(f"got {len(rows)} intact rows, needed {height}; retry")
    img = Image.new("RGB", (width, height))
    px = img.load()
    for y, row in enumerate(rows):
        for x in range(width):
            nibble = int(row[x], 16)
            px[x, y] = tuple(PALETTE[nibble].to_bytes(3, "big")) if nibble < len(PALETTE) else (255, 0, 255)
    return img.resize((width * SCALE, height * SCALE), Image.NEAREST)


def main():
    parser = argparse.ArgumentParser(description="T3 Cardputer serial debug client")
    parser.add_argument("out", nargs="?", default="/tmp/shot.png")
    parser.add_argument("--port", default="/dev/ttyACM0")
    parser.add_argument("--key", help="inject a key by name, e.g. enter, char:a, fn+s")
    parser.add_argument("--heap", action="store_true")
    args = parser.parse_args()

    with open_port(args.port) as ser:
        if args.key:
            ser.write(f"\x02KEY {args.key}\n".encode())
            print(read_frame(ser, b""))
        elif args.heap:
            ser.write(b"\x02HEAP\n")
            print(read_frame(ser, b"HEAP"))
        else:
            ser.write(b"\x02SHOT\n")
            decode_shot(read_frame(ser, b"SHOT")).save(args.out)
            print(args.out)


if __name__ == "__main__":
    main()
