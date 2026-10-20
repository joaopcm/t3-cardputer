# firmware baseline on the Cardputer ADV

Measured on the real ADV (ESP32-S3 rev v0.2, 8 MB flash, no PSRAM) with the template skeleton, ESP-IDF v5.4.2, M5GFX 0.2.33, M5Unified 0.2.27 linked in, custom partition table (`firmware/partitions.csv`: nvs 24K at 0x9000, phy_init 4K at 0xf000, factory 3M at 0x10000). Components come from the IDF component manager (`dependencies.lock`). Source: `t3: boot ...` and `t3: display ...` lines from `firmware/scripts/monitor.sh 10`, and `idf.py size`.

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
