# Voice: capture, gain and streaming

Measured on the real ADV (ESP32-S3, no PSRAM, ES8311 codec) with the Task 10 firmware on home WiFi (2.4 GHz, WPA2), ESP-IDF v5.4.2, `espressif/esp_websocket_client` 1.8.0, against the live relay (whisper `medium.en`) through Tailscale Funnel on 8443. Device numbers come from the `t3: voice sent: ...` line logged at the end of every recording and from temporary measurement builds (gain sweep, per-chunk timing, send timing) that are not in the tree. Relay-side numbers come from whisper-server's `processing 'audio.wav' (N samples, S sec)` line in the relay journal. The room is the homelab room, nobody talking to the device: real speech accuracy and level are Checkpoint B.

## chunk

`kMicChunkSamples` = 1600, `kMicChunkMs` = 100 (`firmware/main/mic.h`).

- 100 ms of 16 kHz mono s16le is 3200 bytes: one I2S DMA buffer (the IDF cap is 4092 bytes per buffer) and the simulator's chunk (`docs/protocol.md` "Audio").
- A 50 ms chunk was also run (60 s, 1201 chunks): same rate, but twice the sends and redraws per second. 100 ms halves both and still gives a 40-column meter 4 s of history.

## one slot

The ES8311 clocks itself from BCLK (M5Unified's ADV table writes `0x01 = 0xBA`, MCLK from BCLK, `0x02 = 0x18`, x8), so every frame carries two 16-bit slots.

| I2S mode | DMA buffers per second (expected 10 at 1600 samples) | samples |
| --- | --- | --- |
| std, `I2S_SLOT_MODE_MONO` | about 22 | equal pairs (`-1 -1 0 0 -1 -1`): both slots land in DMA, so the stream ran at twice the rate |
| std, stereo, left slot kept | 20 per 800-frame buffer | correct, but every 100 ms costs 6400 DMA bytes |
| TDM, 2 slots, `I2S_TDM_SLOT0` only (shipped) | 40 chunks of 800 in 1950 ms = 20.5/s, i.e. 16 kHz | smooth audio, one sample per frame |

TDM with only slot 0 active halves the DMA memory against stereo.

## dma

`kMicDmaChunks` = 4 (`firmware/main/mic.h`): 4 x 3200 = 12800 bytes. The driver queues `desc_num - 1` buffers, so `kMicBufferMs` = 300 ms of audio can wait for the main loop.

- The main loop sends one chunk per pass, and the I2S receive interrupt wakes it. The worst gap between two sends over every home WiFi run below is 130 ms against the 100 ms chunk period, so the main loop was at most about 30 ms late. 300 ms is 10x that.
- The only stall that overran it was the debug `\x02SHOT` (the hex dump holds the canvas lock while `draw()` waits): gaps of 353 to 361 ms, and `voice: mic_buffer_ms=300, a stall lost 100 ms of audio` on screen. That is the loud failure path working; release builds have no SHOT.
- The channel and its DMA buffers exist only while the clock runs (warm-up and recordings, `i2s_new_channel` / `i2s_del_channel`). The controller allows this exception to allocate-at-boot after the first soak (see "heap").

## warm-up

`kWarmUpUs` = 2 s (`firmware/main/mic.cpp`).

| what | zero chunks at the start of a recording |
| --- | --- |
| codec set up at each talk-down, powered down at each release (M5Unified's disable table) | first recording 0 (one -14 dBFS power-up thump), every later one 9 (0.9 s of zeros) |
| codec set up once at boot, clock running only for the register writes, never powered down | first recording 10 (1.0 s), later ones 0 |
| codec set up with the clock left running for 2 s after power-up (shipped) | 0 (first sound at 116 ms, the first chunk) |

So the ADC needs about 1 s of clock after each power-up. 2 s is 2x the measured 1.0 s.

Shipped: the codec powers up on the first main-loop pass at boot and on every screen wake, and powers down when the screen goes off (current estimate in `2026-10-21-firmware-power.md` "mic codec"). The warm-up does not block: the channel runs in the background and `mic_tick()` closes it when the 2 s are up. Measured:

| when talk-down came | first sound |
| --- | --- |
| first recording after boot | 116 ms (warm) |
| 0.8 s after a screen wake | 318 ms, so 2 chunks (200 ms) of zeros |
| 4.0 s after a screen wake | 116 ms (warm) |

The waking key is swallowed, so talk needs a second press. A recording started within about 1 s of a wake loses up to that second's head.

## gain

`kPgaGainSteps` = 10 (PGA +30 dB), `kAdcScaleSteps` = 3 (ADC scale +18 dB), `kAdcVolume` = `0xBF` (0 dB). M5Unified's ADV table leaves PGA at 0 dB and scale at 0 (`REG14 = 0x10`, read back `REG16 = 0x00`).

Room noise, 2 s per setting after 1 s of settling, nobody speaking:

| PGA | ADC scale | room RMS | chunk RMS range | peak |
| --- | --- | --- | --- | --- |
| 0 dB | 0 dB (M5Unified default) | -95.1 dBFS (under 1 LSB) | -96..-94 | 1 |
| +12 dB | 0 dB | -88.3 dBFS | -92..-87 | 4 |
| +21 dB | 0 dB | -75.8 dBFS | -83..-64 | 85 |
| +30 dB | 0 dB | -69.9 dBFS | -73..-67 | 116 |
| +30 dB | +12 dB | -56.4 dBFS | -59..-54 | 201 |
| +30 dB | +24 dB | -46.5 dBFS | -49..-45 | 482 |
| +30 dB | +36 dB | -34.3 dBFS | -37..-33 | 1975 |
| 0 dB | +24 dB | -76.6 dBFS | -80..-70 | 269 |
| +21 dB | +24 dB | -55.1 dBFS | -57..-53 | 900 |

- The default is unusable: room noise is under one LSB. All analog gain first (PGA +30 dB), then digital scale.
- Shipped +30/+18 dB: room noise per 100 ms chunk measured -66..-45 dBFS over 13 recordings.
- Loud sounds at this gain, from the room (not aimed at the device, distance unknown): voices in the room during the 60 s run (whisper transcribed them as sentences) reached -21 dBFS chunk RMS with a 20773 peak (-4 dBFS); a transient in another run peaked at 27744 (-1.4 dBFS). No sample hit 32767.
- Normal speech into the device is NOT measured (no voice in this task). Checkpoint B reads `rms` and `peak` from João's 5 `voice sent:` lines. Retune: peak at 32767 (clipping) means one step down (`kAdcScaleSteps` 2, -6 dB); a speech max under -35 dBFS means one step up.

## meter

`kMeterStepDbfs` = {-80, -40, -25} (`firmware/components/t3core/screens/voice.cpp`), ramp ` .:|`.

- `.` at -80: between digital silence (-96, a dead or cold mic, drawn blank) and the quietest live room chunk (-66), so a working mic always shows a dotted line.
- `:` at -40: 5 dB above the loudest room-noise chunk (-45).
- `|` at -25: room speech reached -21.

## tail

`kTailWaitMs` = 2 x `kMicChunkMs` = 200 ms (`firmware/main/app_main.cpp`). At talk-up the chunk being filled finishes within one chunk period (100 ms); waiting for it keeps the last word. 2x is the tripwire for a stopped clock.

## tcp send buffer

`CONFIG_LWIP_TCP_SND_BUF_DEFAULT` = 16384 (`firmware/sdkconfig.defaults`, was the IDF default 5760).

| send buffer | 1600-byte audio sends | result |
| --- | --- | --- |
| 5760 | alternating 8 ms and 92 to 121 ms | under 32 KB/s; `mic_buffer_ms` overran and audio was lost every few chunks |
| 16384 | 7 to 9 ms each, every 50 ms | 31942 B/s over 5 s, no loss |

With 5760 bytes the sends behave like one buffer per round trip through the Funnel (the round trip itself was not measured), under the 32 KB/s a recording needs. 16384 holds 0.5 s of audio in flight. lwIP takes it from the heap only for unacknowledged data: free heap fell from 136664 at `live` to 130588 while recording (6 KB). A 4096-byte websocket buffer was tried first, while capture still ran at twice the rate (see "one slot"), and sends still took about 100 ms. With the 16 KB send buffer the 1024-byte fragments (`kWsChunkBytes`) stream fine, so it stays 1024.

## power save

Not changed. A build that turned WiFi modem sleep off while recording was a misdiagnosis of the send-buffer stall above. With modem sleep left on (`WIFI_PS_MIN_MODEM`), 3 x 20 s recordings ran at 31969 to 31971 B/s, send max 19 to 47 ms, gap max 116 to 128 ms. If the hotspot shows gaps at Checkpoint B, modem sleep is the first knob to try.

## send

`kAudioSendWaitMs` = 300 (`firmware/main/app_main.cpp`): 6x the home WiFi `send max` (48 ms, "streaming on home WiFi"), and no longer than the 300 ms the mic buffer holds (`static_assert`). Retune at Checkpoint B: 4x the hotspot `send max` from the `voice sent:` line, keeping total tolerance under the relay's 5000 ms `audio_idle_timeout_ms`. One send writes up to four 1024-byte websocket fragments with that wait each, so the worst main-loop block is 1.2 s.

Audio frames go through the text path's open-generation check (`sendable()`): a frame for a connection that is no longer the open one is refused, never sent into the next connection. `transport_send_audio` says which failure it was:

- `NotConnected`: the frame was refused, or the send failed and the websocket client had already marked itself disconnected. The device sends nothing more and waits for the socket's own queued close. That close carries the real code: 4000 must stop and 4401 must re-pair, and a synthesized 1006 would have bumped the generation, dropped that close as stale and reconnected. The close ends the recording as `voice: connection lost` on the next pass.
- `Stalled`: the send failed and the client still says connected. Only then does the device close the socket itself with 1006 (`relay unreachable: audio send stalled 300 ms, ...`), because nothing else would close it until the ping timeout.

After a talk-up whose tail could not be sent, the stats line reads `voice cut short:` (not `voice sent:`), and `audio_end` is not attempted, so its `not connected` notice can't replace `voice: connection lost, transcript lost`.

## link lost while talking

- Black hole (debug `\x02NETDOWN`: the WiFi netif swallows every outgoing frame while the association and socket stay up, like an access point that went out of range before the beacon timeout; `\x02NETUP` restores it).
  - With the 5000 ms text send timeout, the main loop froze 5.2 s: from 44236 to 49456 ms the REC timer stopped and the DMA overflowed, then `voice: audio send failed, 3200 bytes not sent`.
  - With the 300 ms wait: the 16 KB send buffer filled, then one send waited 300 ms. In 12 of 12 cycles the send failed exactly 520 ms after the cut. Each time the websocket client had already marked itself disconnected (`NotConnected`, `connection closed, 3200 audio bytes not sent`). Its own close (1006) ended the recording with `voice: connection lost` (`/tmp/t3-task10-netdown-cancel.png`).
  - Talk-up 0.2 s after the cut, so the tail stalls: `voice cut short: 16 chunks`, no `audio_end`, and the bar keeps `voice: connection lost, transcript lost` (`/tmp/t3-task10-tail-stall.png`). The link came back after NETUP.
- Leaving the access point (debug `\x02WIFIOFF`, `esp_wifi_disconnect`): `link wifi down` and `voice cancelled` in the same millisecond, 10 ms after the cut. After talk-up, WiFi and the link came back by themselves, and the next hold streamed 20 chunks and got its transcript.
- Socket drop (debug `\x02DROP`): cancelled in the same pass (Review Focus 1, in the report).

## streaming on home WiFi

| recording | chunks | rate | send max | gap max | relay received |
| --- | --- | --- | --- | --- | --- |
| 5 s (50 ms chunks) | 100 | 31942 B/s | 14 ms | 60 ms | 80000 samples, 5.0 s |
| 60 s (50 ms chunks) | 1201 | 31996 B/s | 12 ms | 64 ms | 960800 samples, 60.0 s |
| 7 s, SHOT taken mid-recording | 70 | 31469 B/s | 61 ms | 359 ms | 112000 samples, 7.0 s |
| 7 s after a forced reconnect | 69 | 31461 B/s | 58 ms | 357 ms (SHOT) | 110400 samples, 6.9 s |
| 3 x 20 s, modem sleep on | 201, 201, 200 | 31969 to 31971 B/s | 19 to 47 ms | 116 to 128 ms | 320000 samples, 20.0 s (one checked) |
| 30 s | 301 | 31980 B/s | 48 ms | 130 ms | 481600 samples, 30.1 s |

- Every recording arrived whole: samples received = chunks x chunk size. Rows above the fix round were taken with the DMA held from boot and the 5000 ms send wait; the streaming path is otherwise the same.
- Worst gap 130 ms (SHOT runs aside) against the relay's `audio_idle_timeout_ms` = 5000: 38x. The hotspot gap is measured at Checkpoint B, and `audioIdleTimeoutMs` moves in Task 11 (controller ruling). `relay/src/config.ts` is unchanged here.
- Transcript after `audio_end`: 7.4 to 8.4 s for 4 to 30 s clips, 22.5 s for the 60 s clip. Silence came back as an empty transcript (`voice: nothing heard`), room noise as `(whistling)` or `(muffled speaking)`.

## heap

| what | free | largest block |
| --- | --- | --- |
| live before this task (`firmware-network.md`, ring build) | 155300 | 90112 |
| DMA held from boot: live | 133120 to 136664 | 65536 to 69632 |
| DMA held from boot: 32-cycle soak (16 drops mid-recording) | 130208 at least | 49152 at least (connect and live) |
| DMA only while the clock runs: ready | 193624 | 131072 |
| DMA only while the clock runs: live, screen off | 148708 | 79872 |
| DMA only while the clock runs: 32-cycle soak (16 drops mid-recording), at connect | 145456 at least | 62464 at least, 79872 at most |
| same soak, at live | 143856 at least | 63488 at least |
| same soak, at mic on | 128432 at least | 65536 |
| 12 NETDOWN, NETUP cycles mid-recording (connect after a stall), at TLS start (`tls start after ... heap wait`) | | 60416 at least (once), 61440, 63488, 79872 in the other 9 |
| same cycles, at live | 143556 at least | 61440 at least, 79872 in 9 of 12 |

- First soak: with the DMA held for good, the largest block fell to 49152 at both connect and live, under the 60398 TLS line (`firmware-network.md` "soak"). The ruling fix moved the DMA to "only while the clock runs". Re-soak: connect never went under 62464 (1.03x the line).
- TLS start is gated (`kTlsHeapBytes` = 60398 in `firmware/main/transport.cpp`): the control task waits up to one link backoff step (500 ms, 10 checks) for a largest block of 60398 bytes, then connects anyway. If that handshake fails, the close reason reads `tls_heap=60398, largest block N`. In the 12 connects after a stall the gate never had to wait: the stalled client's stop already ran first, so the heap was free by then. The main task's `connect` log line comes earlier (at the link's decision) and read 59392 in the same cycles.
- Connects after a plain drop always had 79872 (1.32x). The low readings (62464, 63488) were all connects after a drop mid-recording. There, the old socket's TLS session and up to 16 KB of unacknowledged audio are still being freed when the 500 ms backoff reconnects, so free heap at connect is about 145 KB instead of about 184 KB.
- USB provisioning (`serial_port.cpp`, task 2 of the distribution plan) re-soak, debug build, same ADV and relay, 16 drops mid-recording on the new-task prompt (talk-down, 2 s, `\x02DROP`, talk-up): connect and TLS start never went under 71680 (1.19x the line), live never under 69632. Commit 21f4b30 under the same procedure: 73728 in 12 of 12. The first provisioning build created the debug key queue before the driver's ring buffers, and that order alone left 55296 in 12 of 12 (`tls_heap=60398, largest block 55296, connecting anyway`, still went live). Free heap was the same in both orders, so the heap at reconnect is placement-sensitive: re-soak after any change to what boots before the link.
- Auto-pair from a provisioned code (task 3 of the distribution plan) reads the pending code from NVS before the link starts. Re-soak, debug build, same ADV and relay, 8 drops mid-recording on a thread (talk-down, 2 s, `\x02DROP`, talk-up): connect and TLS start never went under 75776 (1.25x the line), live never under 75776. Right after the auto-pair itself, connect read 83968.
- Staged screenshots (`\x02STAGE`, `\x02FRAME`, task 11 of the distribution plan) add three debug-only atomics and nothing on the heap at boot; a frame is copied to the heap only when it arrives. Re-soak, debug build, same ADV and relay, 8 drops mid-recording on the new-task prompt (talk-down, 2 s, `\x02DROP`, talk-up): TLS start never went under 75776 (1.25x the line), live never under 73728. The main task's earlier `connect` line read 75776 in 7 of 8 and 58368 once, with TLS start at 75776 in that same cycle.

## stacks

| task | free (min) of size |
| --- | --- |
| main | 4240 of 8192 at live, device check 2026-10-21 at a4f6842 (3952 used, 2.07x headroom); 4768 after recordings and 5024 before the first in Task 10; 3040 after an auto-pair from a provisioned code (5152 used, 1.59x), 4576 on a boot that did not pair |
| websocket | 2544 of 6144 |
| websocket control | 1804 of 4096 |
