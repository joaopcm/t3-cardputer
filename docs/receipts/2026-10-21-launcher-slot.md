# Launcher app slot and release image sizes

Measured 2026-10-21 against bmorcelli/Launcher release 2.9.1 (published 2026-09-04), asset `Launcher-m5stack-cardputer.bin` (the Cardputer and ADV share it; `boards/m5stack-cardputer/platformio.ini` is `DEVICE_NAME "M5Stack Cardputer & ADV"`, 8 MB flash).

## slot

| what | value | where it comes from |
| --- | --- | --- |
| Launcher partition table on the Cardputer | nvs 0x9000 0x5000, otadata 0xE000 0x2000, app0 (test) 0x10000 0x150000, coredump 0x160000 0x10000 | read from the table at 0x8000 of the downloaded 2.9.1 binary; same as `support_files/custom_8Mb.csv` |
| flash | 0x800000 | `board_upload.flash_size = 8MB` |
| free range for installed apps | 0x170000..0x800000 = 0x690000 = 6881280 bytes | flash end minus coredump end |
| how an install picks its slot | `launcherPartitionCreateOtaApp`: partition = image size aligned up to 0x10000, placed in the first free range that fits | `src/partition_table_model.cpp` |

`LAUNCHER_APP_SLOT_BYTES` in `firmware/scripts/release.sh` is 0x800000 - 0x170000. Launcher builds its own table at install time, so the app's `partitions.csv` is ignored under Launcher. Our firmware needs from that table: an `nvs` partition (20K there, 24K in ours) and no `phy_init` (Launcher dropped it; our sdkconfig has `CONFIG_ESP_PHY_INIT_DATA_IN_PARTITION` unset, so PHY data is compiled in).

NVS under Launcher: 20K is 5 pages against 6 for our 24K. The measured count was 756 entries for 6 pages (126 per page), so 20K is 630. The `nvs-settings` receipt measured 147 used before ours and 37 for 8 wifi records plus a 256-char token: 184 of 630 (29%).

## sizes

| artifact | bytes | notes |
| --- | --- | --- |
| dev app (`build/t3_cardputer.bin`, debug serial on) | 1281024 | for comparison |
| release app (`build-release/t3-cardputer-app.bin`) | 1267856 | 13168 smaller than dev |
| release app as a Launcher partition | 1310720 | 1267856 aligned up to 0x10000 |
| Launcher slot | 6881280 | |
| margin | 5570560 | slot 5.25x the partition the app needs |
| full image (`build-release/t3-cardputer-full.bin`, at 0x0) | 1333392 | bootloader + table + app, NVS region 0xFF |
| our own factory partition (dev flashing) | 3145728 | 2.48x the app |

The tripwire is a size check in `release.sh`: it prints `launcher app slot=<n> bytes, app image needed <m>` and exits 1 when the aligned app is larger than the slot. Checked with the slot forced to 1000000: `launcher app slot=1000000 bytes, app image needed 1310720`, exit 1.

## limits of this receipt

- Not measured: an install through Launcher on the device (no Launcher on the ADV, no SD card used). The slot comes from Launcher's table and source, not from a run.
- The slot is the empty-Launcher figure. Each installed app and each data partition Launcher creates for it takes from the same free range. Re-read the table and this constant when Launcher changes.
- Release `.bin` files embed the relay URL, so they stay local in `firmware/build-release/` (gitignored) and are never committed or uploaded.
