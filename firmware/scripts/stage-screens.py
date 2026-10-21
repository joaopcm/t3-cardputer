#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "pyserial"]
# ///
import argparse
import json
import re
import sys
import time
from pathlib import Path

import serial
from PIL import Image, ImageDraw

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from screenshot import decode_shot, open_port

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "docs/images/fixtures"
STX = "\x02"
ETX = "\x03"
# receipt: firmware/components/t3core/include/t3/provision.h kProvisionLineMax, the serial line buffer FRAME lands in
LINE_MAX = 1024
# receipt: reset to the `t3: ready` log took 0.56 s on the ADV, debug build, 2026-10-21; WiFi up came at 8.7 s; 6 s is about 10x and still ahead of the link
BOOT_TIMEOUT_S = 6.0
# receipt: firmware/scripts/screenshot.py TIMEOUT_S, a full SHOT dump fits it
REPLY_TIMEOUT_S = 8.0
# receipt: the main loop waits at most 20 ms per pass (kMainPollTicks, app_main.cpp) and draws at the end of the pass it handled the key or frame in, 5x
SETTLE_S = 0.1
# receipt: one meter column per 100 ms chunk (kMicChunkMs, mic.h), 30 of the 40 columns
VOICE_HOLD_S = 3.0
# receipt: the app's power timeouts are 30 s dim, 60 s off (power.cpp); an hour keeps the screen lit for the whole run
POWER = "3600000 7200000"
STAGED = f"{STX}STAGE ok, until reset{ETX}"
LIVE_MARKERS = ("t3: link live", "t3: rx largest")
PROMPT = "add a health check that reports db latency"


class Device:
    def __init__(self, port):
        self.port = port
        self.ser = open_port(port)
        self.buf = ""
        self.cursor = 0

    def reset(self):
        self.ser.reset_input_buffer()
        self.ser.rts = True
        time.sleep(0.1)
        self.ser.rts = False
        self.buf = ""
        self.cursor = 0

    def pump(self):
        try:
            chunk = self.ser.read(65536)
        except serial.SerialException:
            time.sleep(0.05)
            self.ser = open_port(self.port)
            return
        self.buf += chunk.decode("latin-1")

    def send(self, line):
        self.ser.write(f"{STX}{line}\n".encode())

    def wait(self, pattern, what, timeout=REPLY_TIMEOUT_S):
        regex = re.compile(pattern, re.S)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            found = regex.search(self.buf, self.cursor)
            if found:
                self.cursor = found.end()
                return found
            error = re.search(f"{STX}(ERR [^{ETX}]*){ETX}", self.buf[self.cursor :])
            if error:
                sys.exit(f"{what}: device said {error.group(1)!r}")
        sys.exit(f"{what}: no answer within {timeout}s")

    def stage(self):
        self.reset()
        deadline = time.monotonic() + BOOT_TIMEOUT_S
        while time.monotonic() < deadline:
            self.send("STAGE")
            time.sleep(0.05)
            self.pump()
            if STAGED in self.buf:
                break
        else:
            sys.exit(f"stage: no `STAGE ok` within {BOOT_TIMEOUT_S}s of reset; is this a debug build (CONFIG_T3_DEBUG_SERIAL)?")
        before = self.buf[: self.buf.index(STAGED)]
        boot = before.rfind("t3: boot ")
        if boot < 0:
            sys.exit("stage: `STAGE ok` came with no `t3: boot` log before it, so the reset did not happen; rerun")
        for marker in LIVE_MARKERS:
            if marker in before[boot:]:
                sys.exit(f"stage: `{marker}` came before `STAGE ok`, real relay data reached the screen; rerun")
        self.cursor = self.buf.index(STAGED)
        self.send(f"POWER {POWER}")
        self.wait(f"{STX}POWER ok{ETX}", "power")

    def frame(self, name, screen):
        text = json.dumps(json.loads((FIXTURES / f"{name}.json").read_text()), separators=(",", ":"))
        line = f"FRAME {text}"
        if len(line) > LINE_MAX:
            sys.exit(f"{name}.json: provision_line_max={LINE_MAX}, FRAME line needed {len(line)}")
        self.send(line)
        got = self.wait(f"{STX}FRAME ok screen=([a-z_]+){ETX}", f"frame {name}").group(1)
        if got != screen:
            sys.exit(f"frame {name}: screen is {got}, needed {screen}")

    def key(self, name, screen):
        self.send(f"KEY {name}")
        got = self.wait(r"t3: screen ([a-z_]+)", f"key {name}").group(1)
        if got != screen:
            sys.exit(f"key {name}: screen is {got}, needed {screen}")

    def shot(self, out):
        time.sleep(SETTLE_S)
        self.send("SHOT")
        block = self.wait(f"{STX}(SHOT .*?){ETX}", f"shot {out.name}").group(1)
        decode_shot(block).save(out)
        print(out)


def capture(device, out):
    device.stage()
    device.frame("home", "home")
    device.shot(out / "home.png")

    device.key("enter", "thread")
    device.frame("approval-page", "thread")
    device.frame("approval", "approval")
    device.shot(out / "approval.png")

    device.key("esc", "home")
    device.key("down", "home")
    device.key("down", "home")
    device.key("enter", "thread")
    device.frame("thread", "thread")
    device.shot(out / "thread.png")

    device.key("talk-down", "voice")
    time.sleep(VOICE_HOLD_S)
    device.frame("voice", "voice")
    device.shot(out / "voice.png")
    device.key("esc", "thread")

    device.key("esc", "home")
    device.key("char:n", "projects")
    device.frame("projects", "projects")
    device.key("enter", "new_task")
    for c in PROMPT:
        device.key(f"char:{c}", "new_task")
    device.shot(out / "new-task.png")

    device.reset()


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def hero(home, out):
    screen = Image.open(home).convert("RGBA")
    sw, sh = screen.size
    pad = 36
    bezel = 14
    key_rows = [14, 14, 14, 14]
    key = 42
    gap = 8
    keys_w = max(key_rows) * key + (max(key_rows) - 1) * gap
    width = max(sw + 2 * bezel, keys_w) + 2 * pad
    keys_top = pad + sh + 2 * bezel + 34
    height = keys_top + len(key_rows) * (key + gap) - gap + pad
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    rounded(draw, (2, 2, width - 3, height - 3), 40, fill=(30, 30, 32, 255), outline=(74, 74, 78, 255), width=3)
    sx = (width - sw) // 2
    rounded(draw, (sx - bezel, pad, sx + sw + bezel, pad + sh + 2 * bezel), 14, fill=(0, 0, 0, 255), outline=(58, 58, 62, 255), width=2)
    img.alpha_composite(screen, (sx, pad + bezel))
    for row, count in enumerate(key_rows):
        row_w = count * key + (count - 1) * gap
        x = (width - row_w) // 2
        y = keys_top + row * (key + gap)
        for i in range(count):
            left = x + i * (key + gap)
            rounded(draw, (left, y, left + key, y + key), 9, fill=(44, 44, 48, 255), outline=(64, 64, 68, 255), width=2)
    img.save(out, optimize=True)
    print(out)


def main():
    parser = argparse.ArgumentParser(description="capture the readme screenshots from docs/images/fixtures on a debug build")
    parser.add_argument("--port", default="/dev/ttyACM0")
    parser.add_argument("--out", type=Path, default=REPO / "docs/images")
    parser.add_argument("--hero-only", action="store_true", help="redraw hero.png from an existing home.png")
    args = parser.parse_args()
    if not args.hero_only:
        capture(Device(args.port), args.out)
    hero(args.out / "home.png", args.out / "hero.png")


if __name__ == "__main__":
    main()
