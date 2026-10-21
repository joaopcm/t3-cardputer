# firmware network: wifi, wss, pairing and soak on the Cardputer ADV

Measured on the real ADV (ESP32-S3, no PSRAM) with the Task 8 firmware on home WiFi (2.4 GHz, WPA2, RSSI -30 to -35), ESP-IDF v5.4.2, `espressif/esp_websocket_client` 1.8.0, against the live relay through Tailscale Funnel on 8443. Sources: `t3: ...` and `transport: ...` log lines from the serial console, and a temporary measurement build (heap sampler, a counting cJSON allocator, a `getaddrinfo` timer) that is not in the tree.

## heap

| what | free | largest block | where it comes from |
| --- | --- | --- | --- |
| boot (app_main entry) | 311108 | 245760 | `t3: boot` |
| after `display_init()` | 291900 | 229376 | `t3: sprite` |
| after `transport_init()` (24 KiB rx ring, websocket client, control task) | 255252 | 192512 | `t3: transport`, 36568 bytes |
| after `wifi_init()` | 220804 | 155648 | `t3: wifi init`, 48168 bytes for the driver |
| ready | 212444 | 147456 | `t3: ready` |
| WiFi up, before the TLS connect | 211336 | 147456 | `t3: wifi up` / `t3: connect` |
| during the TLS handshake (lowest) | 142160 | 79872 sampled | `heap_caps_get_minimum_free_size` before and after one connect, from 192492 free (16 KiB slot build) |
| socket open (TLS session held) | 170732 | 104448 | `t3: open`, the session holds 40604 bytes |
| live (after `welcome`) | 165276 | 100352 | `t3: live` |

- TLS handshake need: 192492 - 142160 = **50332 bytes** at the peak of one handshake. The session keeps about 40.6 KB after it.
- The 4-copy design (assembly + inbox of 2 frames + parse buffer) at 32 KiB frames left 92668 bytes free at `ready` with a 31744-byte largest block, under one handshake's need. That is why the transport hands frames over in a ring the main task parses in place (`firmware/main/transport.cpp`). The `transport_init()` row is the ring build; the rows after it are from the 2-slot build, and the ring build's are in "fix round 1" below.

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

- `maxFrameBytes` = **8192**. Largest measured frame 1738 x 4 = 6952, rounded up to 8 KiB (4.7x). Heap check at 8192: an honest worst frame costs 4.1 x 8192 = 33.6 KB against 155 KB free after TLS with the rx ring (22%); the degenerate frame costs 16.9 x 8192 = 138 KB, which cJSON cannot always get, and the hooked allocator then reports `heap: parse needed more than available` instead of crashing. The rx ring costs 24 KiB, allocated once at boot (see "fix round 1").
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

## dead link (`kPingIntervalSec` = 10, `kPongTimeoutSec` = 25)

- Before this, `transport.cpp` left both unset, so `esp_websocket_client` 1.8.0 used its defaults (`WEBSOCKET_PING_INTERVAL_SEC` 10, `WEBSOCKET_PINGPONG_TIMEOUT_SEC` 120). A hotspot that stalls without closing the socket left the device showing "online" for up to about 130 s, while the relay had dropped it at 60 s.
- The relay terminates a socket that misses `heartbeatMaxMissed` = 2 pings at `heartbeatIntervalMs` = 30000 (`relay/src/config.ts`), so it gives up on a silent device after 60 s (`kRelaySilentDropMs`).
- The client sends a ping every `ping_interval_sec` and aborts with `WEBSOCKET_ERROR_TYPE_PONG_TIMEOUT` when no pong arrives within `pingpong_timeout_sec` of the first unanswered ping (`esp_websocket_client.c`, `WEBSOCKET_STATE_CONNECTED`). Its task polls once a second. The worst case is a link that dies just after a pong: the next ping goes out 10 s later and times out 25 s after that, so the dead link is found 10 + 25 + 1 = 36 s after it died, inside the relay's 60 s (host test in `link_test.cpp`).
- `kPongTimeoutSec` = 25 is a tripwire. The honest pong wait is one round trip through the Funnel. The closest measurement is `welcome` 0.5 s after `open`, which is a hello round trip plus the relay's token check, so 25 s is 50x it. While recording, the ping queues behind at most the 16 KB TCP send buffer, which drains in 0.5 s at 32 KB/s (`2026-10-21-firmware-voice.md`). Hotspot round trips are not measured. A false timeout costs one reconnect (about 5 s) and the recording in progress.
- Relay side: `ws` 8.22.0 `WebSocketServer` defaults to `autoPong: true` (`relay/src/server.ts` does not change it), so the relay answers the device's pings with no relay change.
- `kPingIntervalSec` = 10 keeps the library default: a 6-byte masked ping and a 2-byte pong every 10 s.
- A pong timeout surfaces as close 1006 with the reason `pong_timeout_sec=25, no pong from relay`. The link shows `relay unreachable: ...`, keeps the token and reconnects with backoff (`link_test.cpp`).
- If the TCP send buffer is full when the link dies (mid-recording), the ping write can block for `kNetworkTimeoutMs` (10 s) first, so the worst case there is 46 s, still inside 60 s.

## unacked replies and answers (`kUnackedMax` = 8)

- A `reply` or `respond` stays in `App::unacked_` from the key press until its `ack`. It is re-sent with the same `id` after the next `welcome` if the link drops first. The relay answers a repeated id from its idempotency cache (`AckCache` in `relay/src/session.ts`, keyed by device and id, kept `idempotencyTtlMs` = 24 h across connections), so a re-send never runs the action twice unless the relay restarted in between.
- Sends are refused while the link is not live (`reply not sent: <status>`), so entries pile up only while it is live. Each one needs its own key press: an option press on a request that arrived at least `kRequestGuardMs` = 400 ms earlier, or a typed reply and Enter. The relay acks after T3 takes the action, which took 7 to 17 ms for an approval (`2026-10-20-approvals-spike.md`), plus one round trip through the Funnel (`welcome` 0.5 s after `open`, "connect" above). So a live link holds at most about 2 entries in one ack round trip, and 8 is 4x that.
- An entry outlives its round trip only when its `ack` frame is dropped, which already shows the rx budget on screen. The next reconnect re-sends it and the cached ack clears it. A full list shows `unacked_max=8, reply needed 9` and keeps the typed text.
- `kUnackedBytesMax` = 8192: an entry holds its id, thread id, text, confirmation and, for an answer, the request it answers; the frame is encoded again at re-send, not kept. 8192 fits two longest replies (2 x `kReplyTextMax` 4000 plus ids), the about 2 entries one ack round trip holds. Entries are held across a reconnect, so they compete with the TLS handshake: 8192 is 42% of the 19474 bytes between the 79872 largest block at a plain-drop connect and the 60398 TLS line (`2026-10-21-firmware-voice.md` "heap"). Before this cap an entry also kept its encoded frame, so 8 longest replies held about 65 KB, more than the whole margin. Over the cap: `unacked_bytes_max=8192, reply needed N`, and the typed text stays.
- Text given back while its thread is not open, or while another reply is being typed on it, waits in `App::unsent_`: a reply comes back when its thread opens (or after the reply being typed is sent), an answer when its request shows again. These entries do not count against `kUnackedMax`: that budget is about acks in flight, and a saved entry waits for no ack. They count only against `kUnackedBytesMax`. Moving an entry over never grows the total. A send that would push the total past 8192 drops the oldest saved entries instead of being refused, and says so (`unacked_bytes_max=8192, reply needed N, oldest saved reply to <thread> dropped`); only unacked entries alone over the cap refuse a send. A saved answer is also dropped when `home` lists its thread as `running`, `done` or `failed`, since the relay ranks `approval` and `question` above every status (`kindOf` in `relay/src/views/home.ts`), so nothing is pending there: `saved answer to <thread> dropped: nothing pending there`. This only happens while `home` says `approvals.available` true and `t3` ok: the relay's watcher lists no approvals at all while its adapter is broken, unreachable or unauthorized (`readApprovals` in `relay/src/watcher.ts`), so a thread still waiting on an answer then shows as `running`. Several drops, and drops right after text given back on reconnect, show together joined with `; `. A thread missing from `home` keeps its saved answers until a send evicts them; `thread_page` carries no pending flag, so opening the thread drops nothing.
- Close 4401 drops the list instead of re-sending it: the relay's `AckCache` key is `${deviceId}:${id}` (`relay/src/session.ts`), and a re-paired device gets a new device id, so a re-send would run the reply or answer a second time. The screen says `N replies, M answers unconfirmed, may have gone through: re-pair`: each one may have run before its ack was lost, so it is not called dropped. Their text waits in `App::unsent_` as above. 4000 and 4402 keep the list for the next connect.

## wifi

- `kWifiJoinWaitMs` = 20000: 3.5x the 5.8 s worst join; a join that has no IP by then is aborted and reported as `no ip within kWifiJoinWaitMs=20000`.
- A timed-out join calls `esp_wifi_disconnect` and waits for the driver's `STA_DISCONNECTED` (reason 8, `ASSOC_LEAVE`) before the next network is tried, so that event is not charged to the next network. The wait reuses `kWifiJoinWaitMs` as its tripwire, the same bound a user join waits to leave the current network; the event itself is expected at once (not measured on the ADV). Host tests: `wifi_station_test.cpp`.
- A join answered with reason 2 (`AUTH_EXPIRE`) fails like any other refused join: no immediate retry. After a sudden reset the access point still holds the old association and refuses the first join with reason 2 (device check 2026-10-21 at a4f6842: 2 of 3 reboots after a typed join; a reboot after a clean WIFIOFF joined on the first try). An immediate same-network retry was tried and measured slower (device check 2026-10-21 at fa6d3e9): reason 2 on 7 of 8 sudden resets, the retry went out about 20 ms after the refusal and got reason 2 again 3.4 s later every time, then the normal `kWifiRetryMs` wait followed and the next join, about 22.4 s after the first, went through. Boot to live with reason 2 was 39.4-39.9 s with the retry against 35.97-36.31 s without it (a4f6842). The access point keeps refusing until about 10-22 s after the reset, and no measured window is precise enough to pick a shorter delay, so the plain `kWifiRetryMs` wait stays.
- `kWifiRetryMs` = 10000: with no saved network in range and no hidden access point in range, the device scans for 2.4 s every 12.4 s, about 20% radio duty. With a hidden access point in range each round also tries at most one saved network the scan did not list (see Fallback), so the duty is (2.4 s + t_fail) / (12.4 s + t_fail) for any number of such networks, where t_fail is how long one join to an absent SSID takes to fail. t_fail = 2.41 s (device check 2026-10-21 at 492af2a: 6 joins to an absent open SSID typed in setup, with a hidden access point in range, read off the monitor log timestamps between `wifi: joining <ssid>` and `wifi: <ssid> failed, ...`: 2.41 s in 5 runs and 2.42 s in 1, median 2.41 s, max 2.42 s, 10 ms log ticks; every run failed with `network not found (reason 201)`). That is one all-channel connect scan (`WIFI_ALL_CHANNEL_SCAN`, `main/wifi.cpp` 76) ending in reason 201 (`NO_AP_FOUND`, `main/wifi.cpp` 52), so the duty is (2.4 + 2.41) / (12.4 + 2.41), about 32% (32.5% at the max), and the cap keeps it there however many saved networks are unlisted. A join that only gave up at `kWifiJoinWaitMs` (`no ip within kWifiJoinWaitMs=20000`) would cost (2.4 + 20) / (12.4 + 20), about 69%; no absent-SSID join came near it. The cost of the cap: with n unlisted saved networks, a typed hidden network may wait up to n rounds before it is tried again (8 at most, `kMaxWifi`).
- Fallback (`t3::WifiPicker`, `wifi_pick_test.cpp`): saved networks in range are tried strongest first. One that fails is skipped for the rest of the round and the next strongest is tried at once. The round starts over after a join, when a scan lists a different set of saved networks, or when every candidate has failed (then after `kWifiRetryMs`). Saved networks the scan did not list are tried last, only when the scan saw a hidden access point (empty SSID; the scan sets `show_hidden`, without it the driver leaves hidden access points out and a typed hidden network never rejoined), and at most one per round, a different one each round in saved order, so a typed hidden network can rejoin. Trying them on rounds with no hidden access point would cost one failed join per saved network that is simply out of range; trying all of them on every round would grow the radio duty with their number, and mesh routers often broadcast a hidden backhaul SSID, so a hidden access point in range is common. Each such try costs one join attempt to an absent SSID, 2.41 s median on the ADV (see `kWifiRetryMs`). Only typed networks can be hidden, but this is not narrowed to them: a saved record (`WifiRecord` in `main/settings.cpp`, ssid and password, 97 bytes) does not say how the network was added, and a flag would change the record size, so every saved list already on a device would read as wrong-size and show an error until a migration is written.
- `kRawQueueDepth` = 16: a join posts about 6 driver events (scan done, connected, got ip, ...), drained every 20 ms by the main task; a full queue logs `wifi_raw_queue=16, event N dropped`.

## transport

- `kRingFrames` = 3 and `kInboxDepth` = 16: see "fix round 1" (the first build's 2 slots were smaller than a relay refresh burst).
- `kWsChunkBytes` = 1024 (library default): only the read chunk size; the largest frame (1738) arrives in 2 events and is reassembled in its slot.
- `kReasonMax` = 48: the longest close reason seen is `ESP_ERR_ESP_TLS_TCP_CLOSED_FIN` (30 chars).
- Websocket events do not all come from the websocket task. In esp_websocket_client 1.8.0 a failed `transport_send` dispatches ERROR and DISCONNECTED on the caller's task, the main task here, under `client->lock` (`esp_websocket_client.c` 745-766, then `abort_connection` 283, then `dispatch_event` 246). FINISH comes from the websocket task without the lock (1445). Both reach `postClose`, so `closePosted` is a `std::atomic<bool>` taken with `exchange(true)` and only one close is posted per connection. The order of close and later frames still holds: `abort_connection` does nothing once the state is CLOSING, UNKNOW or WAIT_TIMEOUT (266), so a send that fails after the websocket task began closing dispatches no second DISCONNECTED.
- `kPairReplyMax` = 1024: a 200 reply is `{"token":...}` with a token of at most 256 chars (`TOKEN_MAX`); the 401/429 bodies are under 120 chars.

## stacks

| task | used | size | where it comes from |
| --- | --- | --- | --- |
| main (`app_main`) | 3952 | 8192 (`CONFIG_ESP_MAIN_TASK_STACK_SIZE`) | `t3: main_task_stack_free_min=4240` at live, device check 2026-10-21 at a4f6842 (4688 in Task 8); 8192 is 2.07x the use, and the 3584 default would already overflow |
| websocket task | 3684 | 6144 (`kWsTaskStackBytes`) | `transport: ws_task_stack_free_min=2460`, worst over the soak |
| pair task | 3620 | 6144 (`kPairTaskStackBytes`) | `transport: pair_task_stack_free_min=4572 of 8192`; at the shipped 6144 that leaves 2524 free, 1.7x the use |
| websocket control task | 2252 | 4096 (`kControlTaskStackBytes`) | `t3_transport: ws_control_stack_free_min=1844 of 4096`; 1.8x (the first 3072 left 972) |

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

## fix round 1

### rx ring (`kRingFrames` = 3, `kInboxDepth` = 16)

- The relay's largest burst is `refresh`: `home`, `thread_page`, `request`, then the `ack` (`relay/src/session.ts` `refresh`). `open_thread` sends 3 frames (`thread_page`, `request`, `ack`) and a connect sends 2 (`welcome`, `home`). On top of that, the watcher can push one `home` and one `thread_page` in the same poll, so up to 6 frames can be in flight before the main task runs again.
- Worst honest bytes for that burst at these caps:
  - `home` about 7.1 KB (32 rows plus 16 warnings, see "hello caps")
  - `thread_page` about 0.6 KB (7 lines of 40 plus the header; 469 measured)
  - `request` about 2 KB (7 rows plus 4 options; 744 measured)
  - `ack` about 0.2 KB
  - So about 9.9 KB per refresh, or 17.6 KB with an extra home and thread_page pushed on top.
- The ring is 3 x 8192 = 24576 bytes, 1.4x that worst case. Frames take only their own size. The websocket task writes each frame contiguously and the main task frees in arrival order. Four frames that each hit `maxFrameBytes` would need 32 KiB; one that does not fit is dropped and shown as `rx_ring_bytes=24576, a N byte frame did not fit behind the waiting ones`.
- Why not fixed slots of `maxFrameBytes`: with 8 slots (64 KiB) the largest block once live was 49152, under the 60398 TLS line. With 6 slots (48 KiB, one allocation) it was 65536, only 8.5% over the line. The 24 KiB ring leaves 90112 (1.49x).
- `kInboxDepth` 16 = 2x the 8 events a burst can leave queued (6 frames plus an open and a close).
- Measured: 10 `R` presses 100 ms apart from Home, with a thread open on the relay, gave 11 home, 10 thread_page and 10 ack. Up to 6 frames were handled within one 10 ms window, with no drop and no notice on screen. No thread had a pending request to add the 4th frame.

### heap with the ring

| what | free | largest block |
| --- | --- | --- |
| ready | 198724 | 135168 |
| WiFi up / connect | 197628 | 135168 |
| open | 156996 | 90112 |
| live | 155300 | 90112 |

### websocket control task (`kControlTaskStackBytes` = 4096, priority 4)

- `esp_websocket_client_stop` waits for the websocket task with no timeout. A stop issued mid-connect waited 5.0 s and 10.5 s in the two tests below (an upgrade read held by a stopped relay, up to `kNetworkTimeoutMs`; DNS has no bound at all). Start and stop now run on a control task. The main task only bumps the generation and records the wanted connection, so late events from the old socket are ignored.
- Test, run twice: the relay was stopped with SIGSTOP and the device reconnected into it (TLS done, upgrade stuck). 3.5 s later the socket was dropped again mid-connect, and keys were injected straight away. The keys were handled 200 ms after the drop and 2 s later, with the selection moving on screen, while the old websocket task took 5.0 s (first run) and 10.5 s (second run) to exit. The device was live again 4.4 s after the relay continued.

### host never logged

`websocket_client`, `transport_ws`, `transport_base`, `transport`, `esp-tls`, `esp-tls-mbedtls` and `HTTP_CLIENT` are set to `ESP_LOG_NONE` (`transport.cpp`): they print the host or the whole upgrade request on a failed connect. The cause still reaches the screen through the close reason, which is now also kept when the websocket client's ERROR event clears the TLS error before DISCONNECTED reads it. Checks:

- A build pointed at an unresolvable host showed `relay unreachable: ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME`, with 0 hits for the host in 4 failed connects.
- The stopped-relay tests (upgrade read timeouts) and both soaks had 0 hits for the real host.

### soak on the ring build

100 forced reconnects:

| what | value |
| --- | --- |
| reconnects | 100 of 100 live, no drop |
| free heap first / last | 151288 / 151276 (-0.01%) |
| free heap range | 149688 to 151300, alternating between two values |
| largest block range | 81920 to 83968, 1.36x the 60398 line |
| close to live | 4.7 to 5.4 s, two cycles at 12.1 s |

A 30-reconnect run straight after the stopped-relay test settled from 154188 to 149752 over the first 18 cycles and then held flat. The 100-reconnect run that followed was flat from the start.

## json parse budget (`kJsonParseBudgetBytes` = 49152)

- cJSON already went through the t3core hook on the device (`installJsonHooks` runs on every parse, with plain `malloc` behind it), so an allocation failure already reported `heap: parse needed more`. What was missing was a cap below "all of the heap". A degenerate 8 KiB frame (16.9x, about 138 KB) could take memory that the websocket task and lwIP need, before malloc ever failed.
- `setJsonParseBudget(49152)` at boot (65536 until the voice task, see the last bullet). It counts the bytes cJSON asks for during one `parseRelay` (cJSON frees nothing until the parse ends, so this is the tree peak). A frame that needs more is rejected with `json_parse_budget=49152, frame of N bytes needed more`. Encoders are not counted.
- Sizing:
  - 1.46x the ADV's honest worst (4.1 x 8192 = 33.6 KB, synthetic 50-row home).
  - 1.0x the host's honest bound (6.0 x 8192 = 49152).
  - Task 8's sizing at 65536: live free heap with the rx ring was 155300. A parse at the cap uses about 65536 x 1.2 for malloc overhead per node, plus up to 11 KB of typed copy, about 90 KB in all. That leaves about 65 KB free, still above the 60398 TLS line.
- Resized in Task 10 (fix round 1). The mic and the 16 KB TCP send buffer took the live heap to 133120 free, so a parse at 65536 (about 90 KB) would leave about 43 KB, under the 50332-byte TLS need. At 49152 a parse at the cap costs about 49152 x 1.2 + 11 KB = about 70 KB, which leaves about 63 KB of a 133 KB live heap. With the mic's DMA now held only while recording, live free heap is 143856 or more (`2026-10-21-firmware-voice.md` "heap").

## json nesting (`kJsonNestingMax` = 32)

- cJSON recurses once per nested object or array (`parse_value` into `parse_array` or `parse_object`). `xtensa-esp32s3-elf-gcc -Og -fstack-usage` on IDF v5.4.2's `components/json/cJSON/cJSON.c` (the ADV's debug and release builds both use `-Og`) gives `parse_value` 32 bytes and `parse_array` / `parse_object` 32 bytes each, so 64 bytes of stack per level. (`-Os` and `-O2` inline them into a 64-byte `parse_value`, the same per level.)
- The library default `CJSON_NESTING_LIMIT` is 1000, which is 64 KB of recursion. One garbled 8 KiB frame of `[[[[...` could overflow the main task, which parses every frame with 4240 bytes free at its worst ("stacks").
- The deepest relay frame is `projects` at 4 levels (`items[]`, then each item's `defaults` or `models[]`). The `docs/protocol.md` examples were measured with a script. 32 is 8x that and costs at most 32 x 64 = 2048 bytes, 48% of the free main stack.
- Set on both cJSON builds: `idf_build_set_property(COMPILE_DEFINITIONS "CJSON_NESTING_LIMIT=32")` in `firmware/CMakeLists.txt` (checked on `cJSON.c` in `build/compile_commands.json`) and `target_compile_definitions(cjson PUBLIC ...)` in `test/host/CMakeLists.txt`. A `static_assert` in `protocol.cpp` keeps both equal to `kJsonNestingMax`. A deeper frame is refused as `json_nesting_max=32, frame needed N`.
