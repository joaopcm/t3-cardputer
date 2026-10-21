# NVS settings and keyboard on the Cardputer ADV

Measured on the real ADV with the Task 7 firmware (`firmware/main/settings.cpp`), ESP-IDF v5.4.2, `nvs` partition 24K at 0x9000 (`firmware/partitions.csv`). Numbers are `nvs_get_stats()` entry counts logged by a temporary boot loop that added records of the largest legal size, read them back, removed them and logged again (the loop is not in the tree).

Layout: namespace `t3`, keys `wifi` (blob, array of `WifiRecord {char ssid[33]; char password[64];}` = 97 bytes each), `token` (string), `relay_url` (string, normalized `https://host[:port]`, at most `kRelayUrlMax` = 320 chars), `relay_changed` (string `"1"`, a one-shot flag: set when a different relay URL replaced a stored one and wiped the token, erased at the next boot once its notice is up), and `pair_code` (string, the 8-character pairing code USB provisioning leaves for the next boot). `password` holds a NUL-terminated passphrase of up to 63 chars or a 64 hex digit raw PSK that fills all 64 bytes with no NUL, so it is read with `strnlen`; the record stays 97 bytes.

| what | entries | where it comes from |
| --- | --- | --- |
| partition total | 756 | `nvs_get_stats` total_entries |
| used before anything of ours (other namespaces) | 147 | same, empty `t3` namespace, repeated twice: 147 both times |
| 8 wifi records, ssid 32 and password 63 chars (776 bytes) | 27 (174 - 147), 3.6% of the partition | `after8 used=174` |
| a 9th record | refused: `wifi_max=8, saved networks needed 9, forget one first` | `addWifi` return value |
| token of 256 chars | 10 (184 - 174) | `after token256 used=184` |
| everything removed | back to 147 | `cleaned used=147 free=609` |
| relay URL of 320 chars | 12, computed: 1 header + ceil(321 / 32) data entries | the NVS string layout, which gives the measured 10 for the 257 bytes of the 256-char token |
| `relay_changed` flag | 2, computed the same way | same |
| `pair_code` of 8 chars | 2, computed the same way: 1 header + ceil(9 / 32) data entries | same, not yet measured on the ADV |

`kMaxWifi = 8` is a tripwire: the full set plus a maximum token costs 37 of 756 entries (4.9%), 572 stay free, and nobody carries eight known networks. Raising it costs about 3.4 entries per network.

With a maximum relay URL, the flag and a pending pairing code on top, ours is 37 + 12 + 2 + 2 = 53 entries: 200 of 756 used (26%), 556 free. Under Launcher's 20K NVS (`2026-10-21-launcher-slot.md`, 504 usable) it is 200 of 504 (40%, up from 36%). The relay and pairing code rows are computed, not yet measured on the ADV; the next device session re-runs the boot loop with them.

## keyboard

| what | value | where it comes from |
| --- | --- | --- |
| TCA8418 at 0x34 on GPIO8/GPIO9 | answers | `t3: keyboard ready` on the ADV (the first register write is acked) |
| matrix | 7 rows x 8 cols = 56 keys = 4 x 14 | `KP_GPIO1=0x7F`, `KP_GPIO2=0xFF` from the Task 1 template |
| free internal heap at `ready` | 339208 bytes (Task 2 baseline 347184: -7976) | `t3: ready heap_internal_free`; the difference is nvs_flash init, the i2c bus and the larger static App |

The event-code to key mapping (`firmware/components/t3core/keymap.cpp`) is unit tested but its code layout (`x = row*2 + col/4`, `y = col%4`) is from the M5Cardputer ADV driver layout, not yet from a physical keypress; Checkpoint A confirms it with the `keyboard: event code=N down|up` log lines from a build with `CONFIG_T3_KEYBOARD_TRACE=y` (default n: the log would record typed passwords).

## display right edge

Not a bug in our drawing. `display_draw` writes 40 cells of 6 px; `Font0` glyphs are 5 px wide plus a blank 6th column, so a col-39 glyph ends at x=238 and x=239 is always background. Checked three ways on the ADV with the Home screen: the SHOT sprite has no lit pixel in x=239 and 26 lit pixels in x=238; a glyph at col 39 (`e` of `online`, `m` of `3m`) is pixel for pixel the same as the same glyph at any other column; `panel.readRect` of the panel GRAM (x 228-239, y 0-11) equals the sprite pixels, so nothing is lost between sprite and panel.
