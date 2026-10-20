# firmware baseline on the Cardputer ADV

Measured on the real ADV (ESP32-S3 rev v0.2, 8 MB flash, no PSRAM) with the task 1 template skeleton (commit 2bf4824: no grid, no sprite, no debug serial; every number in this first table is from that build, not the current one, and the current build's numbers are in the later tables), ESP-IDF v5.4.2, M5GFX 0.2.33, M5Unified 0.2.27 linked in, custom partition table (`firmware/partitions.csv`: nvs 24K at 0x9000, phy_init 4K at 0xf000, factory 3M at 0x10000). Components come from the IDF component manager (`dependencies.lock`). Source: `t3: boot ...` and `t3: display ...` lines from `firmware/scripts/monitor.sh 10`, and `idf.py size`.

| what | value | where it comes from |
| --- | --- | --- |
| free internal heap at boot | 379212 bytes | `t3: boot heap_internal_free` at app_main entry |
| largest free internal block at boot | 311296 bytes | `t3: boot largest_block` |
| free internal heap after `display.init()` | 376444 bytes | `t3: display heap_internal_free` |
| largest free block after `display.init()` | 311296 bytes | `t3: display largest_block` |
| app image size | 374448 bytes (0x5b6b0) | `build/t3_cardputer.bin` |
| bootloader | 22208 bytes | `build/bootloader/bootloader.bin` |
| partition table | 3072 bytes | `build/partition_table/partition-table.bin` |
| flash written | 399728 bytes (bootloader + table + app) | sum of the three above |
| app partition | 3145728 bytes (0x300000), 11.9% used, 88% free | `firmware/partitions.csv` |
| static RAM (DIRAM) | 65799 of 341760 bytes (19.25%) | `idf.py size` |
| `idf.py size` IRAM column | 16383 of 16384 bytes | first 16 KB after the ICache only, see below |

## reading it

- Display init costs 2768 bytes of internal heap and no contiguous space: the 4-bit 240x135 sprite (about 16 KB) and the TLS buffers fit in the 311296-byte block with room to spare.
- The app is 11.9% of the 3 MB slot with M5GFX + M5Unified and no networking, so WiFi, TLS and websocket have room.
- The `idf.py size` IRAM row always looks full on the S3 and is not a budget. It only counts the first 16 KB of IRAM after the ICache (`0x40374000`-`0x40378000`). `.iram0.text` spills past it into DIRAM: per `build/t3_cardputer.map`, `.iram0.vectors` starts at `0x40374000` and `.iram0.text` runs `0x40374404` to `0x40384597`, 66967 bytes of IRAM in total. `build/esp-idf/esp_system/ld/memory.ld` gives `iram0_0_seg` org `0x40374000` and `dram0_0_seg` len `0x53700` (341760 bytes), the same DIRAM total `idf.py size` reports. The real budget is DIRAM, which is what is left for the heap: 379212 bytes free at boot.

## grid, sprite and debug serial

Measured on the ADV with the task 2 firmware at HEAD ffa124c plus the `sdkconfig.h` include in `debug_serial.h`, `T3_DEBUG_SERIAL=y`, draw lock on (`t3: boot|sprite|ready` log lines, `\x02HEAP`, `idf.py size`, `uxTaskGetStackHighWaterMark`), re-measured on the ADV after the fix round. Grid 40x11, 6x12 cells (M5GFX built-in `Font0`, 6x8 glyph, 2 px above and below), 4 bpp palette sprite.

| what | value | where it comes from |
| --- | --- | --- |
| sprite size | 16200 bytes (240 x 135 x 4 / 8, 120 bytes per row) | `display_buffer()`, dump rows are 240 hex chars |
| free internal heap at boot (app_main entry) | 374436 bytes, largest block 311296 | `t3: boot heap_internal_free` / `largest_block` |
| free internal heap after `display_init()` (panel init + sprite) | 355228 bytes, largest block 286720 | `t3: sprite heap_internal_free` / `largest_block` |
| boot to after sprite | 19208 bytes of heap, 24576 bytes of largest block | 374436 - 355228, 311296 - 286720 |
| free internal heap after `debug_serial_start()` | 347272 bytes, largest block 278528 | `t3: ready ...` and `\x02HEAP` reply, same numbers |
| first `display_draw()` (panel push buffer) | 1456 bytes of heap | `t3: sprite` to `t3: ready` with the debug channel off |
| debug task stack | 2340 bytes used of 4096 (1756 free at the worst point, during `SHOT`) | `debug: task_stack_free_min` |
| longest command | 13 bytes (`KEY talk-down`), line buffer 64 | `debug_serial.cpp` `kMaxLineBytes`, an over-long line logs `line_buf=64, command needed more` |
| rx buffer 256, tx buffer 1024 | commands are at most 13 bytes, one `SHOT` row is 241 bytes | 8 back-to-back screenshots all arrived with 135 intact rows and identical pixels |
| key queue depth 16 | injected keys are consumed every 20 ms; a full queue logs `key_queue=16, injected key dropped` | `debug_serial.cpp` |
| app image | 385072 bytes (0x5e030), 88% of the 3 MB slot free | `build/t3_cardputer.bin` |
| static RAM (DIRAM) | 70507 of 341760 bytes (20.63%) | `idf.py size` |

Notes:

- Boot heap differs from the skeleton table (379212 vs 374436, 4776 bytes) because the debug channel is linked in: 4616 bytes of static RAM (see the debug serial table) plus 160 bytes from the display code. With `T3_DEBUG_SERIAL` off the same source boots at 379052.

- The USB-Serial-JTAG chip resets when the host sets DTR=0 with RTS=1. Linux raises both lines on open, so `screenshot.py` lowers RTS first and the open does not reset the device.
- Each `SHOT` row goes out in one `fwrite`, so ESP log lines from other tasks land between rows, never inside one. `screenshot.py` keeps only lines of exactly 240 hex chars and fails loudly if it does not get 135.

## debug serial cost (`T3_DEBUG_SERIAL`)

`firmware/main/Kconfig.projbuild`, default y. Off: `debug_serial.cpp` is not compiled, `debug_serial_start()` is an inline no-op, no SHOT, KEY or HEAP. Task 12 builds releases with it off. Measured on the ADV, same source, only the option flipped (`t3: boot|sprite|ready` log lines, `build/t3_cardputer.bin`):

| what | on | off | cost when on |
| --- | --- | --- | --- |
| free heap at boot (app_main entry) | 374436 | 379052 | 4616 bytes of static RAM |
| free heap after `debug_serial_start()` (`ready`) | 347184 | 358388 | 11204 bytes total |
| heap taken by `debug_serial_start()` itself | 8044 - 1456 = 6588 | 0 | 6588 bytes: 4096 task stack, 256 rx + 1024 tx ring buffers, driver and queue |
| largest free block at `ready` | 278528 | 294912 | 16384 bytes |
| app image | 385072 (0x5e030) | 358672 (0x57910) | 26400 bytes of flash |
| debug task stack used | 2340 of 4096 | - | |

## draw lock

`display_draw()` and the whole `SHOT` dump hold one static mutex (`display.cpp`, no heap). The raw buffer is only reachable through `display_with_buffer()`. Test: a temporary loop in `app_main` redrew the grid every 2 ms, alternating the selected row, while `screenshot.py` ran back to back.

| build | shots | complete | torn |
| --- | --- | --- | --- |
| no lock | 10 | 9 | 1 (all black, no text); superseded: the first write-up also listed a third half-drawn variant that does not fit 9 + 1 = 10, and the run was not repeated, so only the lock row is the receipt |
| lock | 30 | 30 | 0, exactly 2 distinct frames (row 2 or row 3 selected) |
