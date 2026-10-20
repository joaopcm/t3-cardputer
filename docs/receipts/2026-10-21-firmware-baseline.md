# firmware baseline on the Cardputer ADV

Measured on the real ADV (ESP32-S3 rev v0.2, 8 MB flash, no PSRAM) with the template skeleton, ESP-IDF v5.4.2, M5GFX 0.2.33, M5Unified 0.2.27 linked in, default single-app partition table. Source: `t3: boot ...` and `t3: display ...` lines from `firmware/scripts/monitor.sh 10`, and `idf.py size`.

| what | value | where it comes from |
| --- | --- | --- |
| free internal heap at boot | 379212 bytes | `t3: boot heap_internal_free` at app_main entry |
| largest free internal block at boot | 311296 bytes | `t3: boot largest_block` |
| free internal heap after `display.init()` | 376444 bytes | `t3: display heap_internal_free` |
| largest free block after `display.init()` | 311296 bytes | `t3: display largest_block` |
| app image size | 374432 bytes (0x5b6a0) | `build/t3_cardputer.bin` |
| bootloader | 22208 bytes | `build/bootloader/bootloader.bin` |
| partition table | 3072 bytes | `build/partition_table/partition-table.bin` |
| flash written | 399712 bytes (bootloader + table + app) | sum of the three above |
| app partition | 1048576 bytes (0x100000), 64% free | default single-app table |
| static RAM (DIRAM) | 65799 of 341760 bytes (19.25%) | `idf.py size` |
| IRAM | 16383 of 16384 bytes | `idf.py size` |

## reading it

- Display init costs 2768 bytes of internal heap and no contiguous space: the 4-bit 240x135 sprite (about 16 KB) and the TLS buffers fit in the 311296-byte block with room to spare.
- The app already fills 36% of the default 1 MB app partition with M5GFX + M5Unified and no networking. TLS, WiFi and audio will push it past that; the partition table needs a bigger app slot before the network tasks land.
- IRAM is at 99.99% in this build; later tasks that add IRAM-placed code should watch `idf.py size`.
