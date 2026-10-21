#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyserial"]
# ///
import argparse
import json
import os
import stat
import sys
import time

import serial

STX = b"\x02"
PREFIX = STX + b"T3PROV "
# receipt: the main loop polls the serial port every 20 ms (kMainPollTicks) and the reply drains within 100 ms (kReplyDrainTicks); 5 s is the tripwire
TIMEOUT_S = 5.0


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


def read_frame(path):
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode != 0o600:
        sys.exit(f"provision file must be 0600, {path} is {mode:04o}; run: chmod 600 {path}")
    with open(path, encoding="utf-8") as f:
        try:
            frame = json.load(f)
        except json.JSONDecodeError as error:
            sys.exit(f"{path} is not valid json: line {error.lineno} column {error.colno}")
    return json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def read_reply(ser):
    deadline = time.monotonic() + TIMEOUT_S
    buf = b""
    while time.monotonic() < deadline:
        buf += ser.read(4096)
        start = buf.find(PREFIX)
        if start < 0:
            continue
        end = buf.find(b"\n", start)
        if end >= 0:
            return buf[start + 1 : end].decode("utf-8", errors="replace")
    sys.exit(f"no T3PROV reply within {TIMEOUT_S}s; is the T3 app running on the device?")


def main():
    parser = argparse.ArgumentParser(description="Write wifi, relay url and pairing code to the device over USB.")
    parser.add_argument("file", help="json frame, mode 0600: {\"wifi\"?:{\"ssid\",\"password\"},\"relay\"?,\"code\"?}")
    parser.add_argument("--port", default="/dev/ttyACM0")
    args = parser.parse_args()
    frame = read_frame(args.file)
    ser = open_port(args.port)
    ser.reset_input_buffer()
    ser.write(PREFIX + frame + b"\n")
    ser.flush()
    reply = read_reply(ser)
    print(reply)
    sys.exit(0 if reply == "T3PROV ok" else 1)


if __name__ == "__main__":
    main()
