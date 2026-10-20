# firmware network: wifi, wss, pairing and soak on the Cardputer ADV

Measured on the real ADV (ESP32-S3, no PSRAM) with the Task 8 firmware on home WiFi (2.4 GHz, WPA2, RSSI -30 to -35), ESP-IDF v5.4.2, `espressif/esp_websocket_client` 1.8.0, against the live relay through Tailscale Funnel on 8443. Sources: `t3: ...` and `transport: ...` log lines from the serial console, and a temporary measurement build (heap sampler, a counting cJSON allocator, a `getaddrinfo` timer) that is not in the tree.

## heap

| what | free | largest block | where it comes from |
| --- | --- | --- | --- |
| boot (app_main entry) | 311108 | 245760 | `t3: boot` |
| after `display_init()` | 291900 | 229376 | `t3: sprite` |
| after `transport_init()` (2 rx slots of 8192, websocket client) | 268972 | 204800 | `t3: transport`, 22928 bytes |
| after `wifi_init()` | 220804 | 155648 | `t3: wifi init`, 48168 bytes for the driver |
| ready | 212444 | 147456 | `t3: ready` |
| WiFi up, before the TLS connect | 211336 | 147456 | `t3: wifi up` / `t3: connect` |
| during the TLS handshake (lowest) | 142160 | 79872 sampled | `heap_caps_get_minimum_free_size` before and after one connect, from 192492 free (16 KiB slot build) |
| socket open (TLS session held) | 170732 | 104448 | `t3: open`, the session holds 40604 bytes |
| live (after `welcome`) | 165276 | 100352 | `t3: live` |

- TLS handshake need: 192492 - 142160 = **50332 bytes** at the peak of one handshake. The session keeps about 40.6 KB after it.
- The 4-copy design (assembly + inbox of 2 frames + parse buffer) at 32 KiB frames left 92668 bytes free at `ready` with a 31744-byte largest block, under one handshake's need. That is why the transport hands frames over in 2 slots that the main task parses in place (`firmware/main/transport.cpp`).

## relay frames for this account

Largest frame of each type seen on the live relay (`t3: rx largest <type> frame N bytes`), hello `cols` 40, `bodyRows` 7:

| frame | bytes | what was on it |
| --- | --- | --- |
| home | 1738 | 12 rows (1 needs, 11 done today) |
| projects | 1505 | this account's project list (relay on main, no `models`) |
| request | 744 | one approval; its `requestId` is 333 chars (see "open problem") |
| thread_page | 469 | 7 lines of a long reply |
| error | 88 | `hello_timeout` |
| ack | 48 | |
| welcome | 40 | |

## parse peak on the device

cJSON bytes through the `setJsonAllocator` hook (`heap_caps_get_allocated_size`, so malloc overhead included), and the typed copy as the free-heap drop while the parsed message is alive:

| frame | bytes | tree peak | typed | total / frame |
| --- | --- | --- | --- | --- |
| live home, 12 rows | 1738 | 5440 | - | 3.1x tree |
| live projects | 1505 | 4324 | - | 2.9x tree |
| live thread_page | 469 | 1288 | - | 2.7x tree |
| synthetic home, 50 rows with 40-char thread ids | 7972 | 21796 | 10804 | 4.1x |
| synthetic home, 1000 empty warnings (degenerate) | 3121 | 52600 | 388 | 16.9x |

The device ratios are below the host upper bounds in `2026-10-21-protocol-parse-peak.md` (6.0x honest, 21.4x degenerate), as expected with 4-byte pointers.

## hello caps

- `maxFrameBytes` = **8192**. Largest measured frame 1738 x 4 = 6952, rounded up to 8 KiB (4.7x). Heap check at 8192: an honest worst frame costs 4.1 x 8192 = 33.6 KB against 165 KB free after TLS (20%); the degenerate frame costs 16.9 x 8192 = 138 KB, which cJSON cannot always get, and the hooked allocator then reports `heap: parse needed more than available` instead of crashing. The two rx slots cost 16 KiB, allocated once at boot.
- `maxHomeRows` = **32**. Today's home is 12 rows, so 32 is 2.7x. The relay does not shrink home to fit bytes (it sends `error internal` naming `max_frame_bytes`), so a full home must fit `maxFrameBytes`: a worst honest row is about 155 bytes (40-char T3 thread id, 13-col project, 31-col title, 4-col age), 32 rows are 4960 bytes, plus about 2 KB for 16 warnings of 120 chars and the counts, about 7.1 KB, inside 8192. Past 32 rows the home screen already shows `maxHomeRows=32, home needed N`.
- `bodyRows` = 7, `cols` = 40: controller ruling and the grid.

## connect

| what | measured | where it comes from |
| --- | --- | --- |
| WiFi scan | 2.42 s | `ready` 629 ms to `wifi: scan` 3049 ms |
| WiFi join (association + DHCP) | 5.6 to 5.8 s over 6 joins | `wifi: joining` to `wifi: up` |
| first join after a reset that cut off a join in progress | fails with reason 2 (auth expired) on 4 of 5 boots, the retry 12.4 s later joins | `wifi: <ssid>: reason 2`; every such boot followed a flash or reset 3 s into the previous boot's join |
| first DNS lookup after WiFi up | 7.0 to 7.2 s over 3 boots | `getaddrinfo` timer: DHCP hands out a primary DNS server that does not answer (unreachable from the homelab too), lwIP falls back to the secondary |
| TLS + websocket upgrade, DNS cached | 3.8 to 3.9 s | `t3: connect` to `t3: open` |
| `welcome` after open | 0.5 s | `t3: open` to `t3: link live` |
| worst connect (first after WiFi up) | 11.1 s | 7.2 s DNS + 3.8 s TLS and upgrade |
| reconnect after a dropped socket | 4.8 to 5.4 s, close to live | soak below |
| pairing POST (first after WiFi up) | 11.7 s | key Enter to `pair: http 200`, 7.2 s of it DNS |

- `kConnectWaitMs` = 30000 (`link.h`): 2.7x the worst connect.
- `kNetworkTimeoutMs` = 10000 (`transport.cpp`, the library default): each phase (TCP, TLS, upgrade read) is bounded by it, and the longest phase measured is the 3.8 s TLS connect.
- `kPairTimeoutMs` = 10000: same per-operation bound for the HTTPS pair request; its TLS and POST took about 4.5 s after DNS.
- `kSendWaitTicks` = 5000 ms: tripwire on taking the client's lock and writing at most 4.2 KB (a 4000-char reply in 5 chunks); the lock is only held by the websocket task while it reads a frame or answers a ping, both in milliseconds.

## backoff

- `kBackoffMaxMs` = 30000 (`link.h`). A retry while the relay is gone costs one TLS connect (3.8 s, about 50 KB of transient heap). At 30 s apart, retries hold the radio and CPU at most 3.8 / 30 = 13% of an outage, and a relay that comes back is reached within 30 s plus one connect. The relay itself is back 0.24 s after a restart (`kBackoffMinMs` receipt), so a restart never reaches the maximum: Review Focus 2 reconnected 4.8 s after the close.
- Hotspot timings are not measured here (no hotspot at the homelab); Checkpoint A adds one.

## wifi

- `kWifiJoinWaitMs` = 20000: 3.5x the 5.8 s worst join; a join that has no IP by then is aborted and reported as `no ip within kWifiJoinWaitMs=20000`.
- `kWifiRetryMs` = 10000: with no saved network in range the device scans for 2.4 s every 12.4 s, about 20% radio duty.
- `kRawQueueDepth` = 16: a join posts about 6 driver events (scan done, connected, got ip, ...), drained every 20 ms by the main task; a full queue logs `wifi_raw_queue=16, event N dropped`.

## transport

- `kSlots` = 2 rx slots of `maxFrameBytes`. The websocket task fills a free slot and wakes the main task, which parses the frame in place and frees the slot on its next poll. 100 reconnects (each with a welcome + home burst) and the end-to-end run dropped no frame; a frame with no free slot is dropped and shown as `rx_slots=2, a N byte frame needed one more`.
- `kInboxDepth` = 8: at most 2 text events (one per slot) plus an open and a close are outstanding, so 8 is 2x.
- `kWsChunkBytes` = 1024 (library default): only the read chunk size; the largest frame (1738) arrives in 2 events and is reassembled in its slot.
- `kReasonMax` = 48: the longest close reason seen is `ESP_ERR_ESP_TLS_TCP_CLOSED_FIN` (30 chars).
- `kPairReplyMax` = 1024: a 200 reply is `{"token":...}` with a token of at most 256 chars (`TOKEN_MAX`); the 401/429 bodies are under 120 chars.

## stacks

| task | used | size | where it comes from |
| --- | --- | --- | --- |
| main (`app_main`) | 3504 | 8192 (`CONFIG_ESP_MAIN_TASK_STACK_SIZE`) | `t3: main_task_stack_free_min=4688`; the 3584 default would leave 80 bytes once it sends over TLS |
| websocket task | 3684 | 6144 (`kWsTaskStackBytes`) | `transport: ws_task_stack_free_min=2460`, worst over the soak |
| pair task | 3620 | 6144 (`kPairTaskStackBytes`) | `transport: pair_task_stack_free_min=4572 of 8192` |

## Review Focus 2

- `systemctl --user restart t3-cardputer-relay` while live: the device showed `relay unreachable: ESP_ERR_ESP_TLS_TCP_CLOSED_FIN` (`/tmp/t3-task8-rf2-unreachable.png`), reconnected after the 500 ms backoff and was live 4.8 s after the close, token kept (no re-pair; the next reboot connected with the stored token). Done twice.
- Slow hello: the relay was stopped with SIGSTOP the moment the device logged `open` (before its hello reached the relay) and held 10.6 s, then SIGCONT. The relay's 10 s timer fired first: the device got `error hello_timeout` ("no hello within helloTimeoutMs=10000"), close 4408, retried after 1 s and was live 5.3 s later with the same token.

## Review Focus 4: soak

100 forced reconnects (`\x02DROP` closes the socket like a network drop; the link backs off 500 ms and reconnects), heap and largest block logged at each `live`:

| what | value |
| --- | --- |
| reconnects | 100 of 100 live again, no frame dropped, no error logged |
| free heap, first / last | 166452 / 164932 (-0.91%, inside the 2% bound) |
| free heap range | 163380 to 167796 |
| largest block range | 96256 to 100352 (19 x 100352, 28 x 98304, 52 x 96256, cycle 96 read 100352 in the raw log, the soak script cut the line) |
| pass line for the largest block | TLS need 50332 x 1.2 = 60398; the lowest block, 96256, is 1.6x it |
| close to live | 5.0 to 5.8 s on 98 cycles, 12.5 and 13.1 s on two (cause not logged, both came back on the first retry) |
| websocket task stack | at least 2460 bytes free of 6144 on every connection |

Pass on both counts: the largest block never went under 60398, and the last heap is within 2% of the first.

## open problem: approvals need a requestId over 128 chars

T3's approval request ids are 333 chars on the live relay (`runtime-request:provider:claudeAgent:provider-turn:...:native-request:toolu_...:<uuid>`). The relay forwards them as `request.requestId`, but `respond.requestId` is `ref` (1-128) in `relay/src/protocol/messages.ts`, so no device can answer them: the firmware rejects the request frame with `requestId: ref_max=128, got 333`, and a device that accepted it would get its `respond` refused. The fix is on the relay (a short handle per pending request), not in the firmware cap.
