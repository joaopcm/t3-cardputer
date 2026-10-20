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

`kDmaChunks` = 4 (`firmware/main/mic.cpp`): 4 x 3200 = 12800 bytes, allocated once at boot. The driver queues `desc_num - 1` buffers, so 300 ms of audio can wait for the main loop.

- The main loop sends one chunk per pass and the I2S receive interrupt wakes it. Worst gap between two sends over every home WiFi run below is 130 ms against the 100 ms chunk period, so the main loop was at most about 30 ms late. 300 ms is 10x that.
- The only stall that overran it was the debug `\x02SHOT` (the hex dump holds the canvas lock while `draw()` waits): gap 353 to 361 ms, `voice: mic_buffer_ms=300, a stall lost 100 ms of audio` on screen. That is the loud failure path working; release builds have no SHOT.
- Heap cost: see "heap".

## warm-up

`kWarmUpMs` = 2000 (`firmware/main/mic.cpp`).

| what | zero chunks at the start of a recording |
| --- | --- |
| codec set up at each talk-down, powered down at each release (M5Unified's disable table) | first recording 0 (one -14 dBFS power-up thump), every later one 9 (0.9 s of zeros) |
| codec set up once at boot, clock running only for the register writes, never powered down | first recording 10 (1.0 s), later ones 0 |
| codec set up at boot with the clock running for 2 s, never powered down (shipped) | 0 on every recording, first one included |

So the ADC needs about 1 s of clock once per power-up. 2000 ms is 2x the measured 1.0 s. It runs after the first draw, while WiFi is already joining (boot to `wifi up` took 8 to 26 s in these runs), so it adds no time to `live`. The analog side stays powered between recordings; its current is not measured (add it to the Task 9 discharge run).

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

Audio frames use the text path's `kSendWaitTicks` (5000 ms, `firmware/main/transport.cpp`) and its open-generation check (`sendable()`): a frame for a connection that is no longer the open one is refused, never sent into the next connection. No new timeout: with 16 KB in flight a send only blocks after 0.5 s of unacknowledged audio, past the 300 ms the DMA can hold, so a long block already shows `mic_buffer_ms` on screen, and a failed send ends the recording with `voice: <why>`.

## streaming on home WiFi

| recording | chunks | rate | send max | gap max | relay received |
| --- | --- | --- | --- | --- | --- |
| 5 s (50 ms chunks) | 100 | 31942 B/s | 14 ms | 60 ms | 80000 samples, 5.0 s |
| 60 s (50 ms chunks) | 1201 | 31996 B/s | 12 ms | 64 ms | 960800 samples, 60.0 s |
| 7 s, SHOT taken mid-recording | 70 | 31469 B/s | 61 ms | 359 ms | 112000 samples, 7.0 s |
| 7 s after a forced reconnect | 69 | 31461 B/s | 58 ms | 357 ms (SHOT) | 110400 samples, 6.9 s |
| 3 x 20 s, modem sleep on | 201, 201, 200 | 31969 to 31971 B/s | 19 to 47 ms | 116 to 128 ms | 320000 samples, 20.0 s (one checked) |
| 30 s | 301 | 31980 B/s | 48 ms | 130 ms | 481600 samples, 30.1 s |

- Every recording arrived whole: samples received = chunks x chunk size.
- Worst gap 130 ms (SHOT runs aside) against the relay's `audio_idle_timeout_ms` = 5000: 38x. The hotspot gap is measured at Checkpoint B, and `audioIdleTimeoutMs` moves in Task 11 (controller ruling). `relay/src/config.ts` is unchanged here.
- Transcript after `audio_end`: 7.4 to 8.4 s for 4 to 30 s clips, 22.5 s for the 60 s clip. Silence came back as an empty transcript (`voice: nothing heard`), room noise as `(whistling)` or `(muffled speaking)`.

## heap

| what | free | largest block |
| --- | --- | --- |
| live before this task (`firmware-network.md`, ring build) | 155300 | 90112 |
| ready | 180068 | 116736 |
| live | 133120 to 136664 | 67584 to 69632 |
| while recording | 130588 to 132116 | 63488 to 67584 |
| live again after a recording and a forced reconnect | 134992 | 65536 |

The largest block stays above the 60398 TLS line (`firmware-network.md` "soak"), but with less room than before: 1.09x to 1.15x, from 1.49x. The mic's 12800 DMA bytes are most of the drop; the rest was not broken down.

## stacks

| task | free (min) of size |
| --- | --- |
| main | 4768 of 8192 after recordings (5024 before the first) |
| websocket | 2544 of 6144 |
| websocket control | 1804 of 4096 |
