#!/usr/bin/env python3
import hashlib
import json
import shutil
import sys
from pathlib import Path

PART_NAMES = {
    "bootloader": "bootloader.bin",
    "partition-table": "partition-table.bin",
    "app": "t3-cardputer.bin",
}
MANIFEST_NAME = "T3 Cardputer"
MANIFEST_PROTOCOL = 1


def fail(message):
    print(f"web manifest failed: {message}", file=sys.stderr)
    sys.exit(1)


def size_to_bytes(text):
    value = text.strip().upper()
    for suffix, factor in (("K", 1024), ("M", 1024 * 1024)):
        if value.endswith(suffix):
            return int(value[:-1], 0) * factor
    return int(value, 0)


def nvs_region(partitions_csv):
    for line in partitions_csv.read_text().splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) >= 5 and fields[0] == "nvs":
            return {"offset": int(fields[3], 0), "size": size_to_bytes(fields[4])}
    fail(f"no nvs row in {partitions_csv}")


def main():
    if len(sys.argv) != 5:
        fail("usage: web-manifest.py <build dir> <partitions.csv> <out dir> <version>")
    build_dir, partitions_csv, out_dir, version = (
        Path(sys.argv[1]),
        Path(sys.argv[2]),
        Path(sys.argv[3]),
        sys.argv[4],
    )
    flasher_args = json.loads((build_dir / "flasher_args.json").read_text())
    chip = flasher_args["extra_esptool_args"]["chip"]

    out_dir.mkdir(parents=True, exist_ok=True)
    parts = []
    for key, name in PART_NAMES.items():
        entry = flasher_args.get(key)
        if entry is None:
            fail(f"flasher_args.json has no '{key}' entry")
        source = build_dir / entry["file"]
        target = out_dir / name
        shutil.copyfile(source, target)
        parts.append(
            {
                "path": name,
                "offset": int(entry["offset"], 0),
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            }
        )
    parts.sort(key=lambda part: part["offset"])

    manifest = {
        "name": MANIFEST_NAME,
        "version": version,
        "chip": chip,
        "protocol": MANIFEST_PROTOCOL,
        "parts": parts,
        "nvs": nvs_region(partitions_csv),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"web parts: {len(parts)}, manifest version {version}")


main()
