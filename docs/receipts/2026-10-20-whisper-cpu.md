# Receipt: whisper.cpp on CPU for voice prompts (2026-10-20)

Host: Ryzen 7 3700X (8 cores, 16 threads), GTX 1060 on nouveau (no CUDA), CPU build only. Memory available when measured: 8.3 GiB with agents running (`free -h`).
Build: `ggml-org/whisper.cpp` tag `v1.9.5`, `relay/scripts/install-whisper.sh` (Release, `-march=native`, whisper-server target). cmake came from `uv tool install cmake` (4.4.4, user-local, no sudo) because the host had none.
Models: `ggml-*.bin` f16 files from the whisper.cpp download script, in `~/.local/share/t3-cardputer/models/`.
Tool: `relay/scripts/measure-whisper.mjs`. It starts `whisper-server` on 127.0.0.1, sends one untimed warm-up request, then times 5 `POST /inference` requests of `samples/jfk.wav` (11.0 s, 16 kHz mono) and reads the child's `VmHWM` (peak resident set) from `/proc`. Raw data: `2026-10-20-whisper-cpu.measure.json`.

**Default: `medium.en`, 8 threads.** Most accurate model measured that fits with room to spare: peak RSS 1.8 GB against 8.3 GiB available. Latency was not a criterion (João picked accuracy over speed).

## Per model, `samples/jfk.wav`, 8 threads, 5 runs

| Model | Median | p95 | Peak RSS | Load | Word errors (5 runs) |
| --- | --- | --- | --- | --- | --- |
| `small.en` | 2552 ms | 2657 ms | 641 MB | 0.4 s | 0, 0, 0, 0, 0 |
| `medium.en` | 8517 ms | 8622 ms | 1795 MB | 1.8 s | 0, 0, 0, 0, 0 |
| `large-v3-turbo` | 12738 ms | 12904 ms | 1754 MB | 1.3 s | 0, 0, 0, 0, 0 |

Reference text: "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country." Word errors are word-level edit distance after lowercasing and dropping punctuation, so "And so, my" and "And so my" match. p95 of 5 runs is the slowest run.

Transcripts (identical across the 5 runs of each model):

- `small.en`: "And so, my fellow Americans, ask not what your country can do for you. Ask what you can do for your country."
- `medium.en`: "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country."
- `large-v3-turbo`: "And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country."

Through the relay's own `createWhisperStt` (medium.en, same clip): first request 9.5 s including model load, then 8.1 s. The relay path adds no measurable overhead.

## Thread count

`small.en`, 5 runs each: 4 threads 4393 ms median, **8 threads 2565 ms**, 16 threads 2742 ms. 8 matches the physical cores, so `whisper.threads` is 8.

## Why medium.en and not large-v3-turbo

The clean clip does not separate the models: all three made 0 errors. To get a signal I added white noise to the same clip (Python stdlib, seeded `random.Random(1234)`, Gaussian sigma = RMS / 10^(SNR/20)) and ran each model once after a warm-up:

| SNR | `small.en` | `medium.en` | `large-v3-turbo` |
| --- | --- | --- | --- |
| 0 dB | 0 errors | 0 errors | 0 errors |
| -5 dB | 2 | 2 | 2 |
| -10 dB | 16 | **10** | 12 |

`medium.en` is never worse than the others and is best at -10 dB. It is also a third faster than `large-v3-turbo` (8.5 s vs 12.7 s). One clip with synthetic noise is thin evidence, so this is a tie-break and not a ranking: published benchmarks put `large-v3-turbo` at or slightly above `medium.en` on English, and nothing here contradicts that. **Re-check all three on real ADV recordings in plan 2** (coding vocabulary, hotspot audio) and flip `whisper.model` if `large-v3-turbo` wins. Switching is one config value: `models` already has all three.

## Limits and their receipts

| Limit | Value | Receipt |
| --- | --- | --- |
| `audioMaxSeconds` | 120 | the spec's 5-30 s prompts x4. A 120 s clip (jfk repeated, truncated at 120 s) took 60.7 s and 65.1 s on `medium.en`, peak RSS 1896 MB. 120 s of PCM is 3.84 MB in the relay |
| `audioIdleTimeoutMs` | 5000 | pending plan 2: needs the measured jitter on a phone hotspot |
| `whisperStartTimeoutMs` | 60000 | model load measured 0.4 to 1.8 s (file in page cache), so 60 s is about 33x the slowest |
| `whisperRequestTimeoutMs` | 260000 | 4x the 65.1 s worst case for the longest allowed recording |
| `whisperRestartsPerWindow` | 3 | whisper-server died 0 times in 59 requests over 17 starts (measurement runs, noise runs, 120 s runs, relay path) |
| `whisperRestartWindowMs` | 600000 | sized with the restart count: a one-off crash ages out in 10 min, a crash loop trips within a second |

Latency is stepped, not linear: whisper pads every request to 30 s windows. The 11 s clip costs about the same as a 30 s prompt, and the 120 s clip costs about 4 windows (65 s vs 8.5 s). Prompts of 5-30 s transcribe in about 8-9 s on `medium.en`.

## Crash loop behaviour

The relay spawns `whisper-server` once, bound to 127.0.0.1 on `whisper.port`, and respawns it when it dies. More than `whisperRestartsPerWindow` deaths inside `whisperRestartWindowMs` stops the respawning and puts `voice down: whisper-server died N times, whisperRestartsPerWindow=3, whisperRestartWindowMs=600000, see relay log` on the device's home screen. Transcription requests fail with the same text until old deaths age out of the window, then the next request starts the server again. Covered by `relay/test/stt.test.ts` with a fake `whisper-server` that exits on start.

## Reproduce

```
relay/scripts/install-whisper.sh
node relay/scripts/measure-whisper.mjs medium.en 8 5
```
