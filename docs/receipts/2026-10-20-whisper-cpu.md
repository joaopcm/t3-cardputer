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

`medium.en` is never worse than the others and is best at -10 dB. It is also a third faster than `large-v3-turbo` (8.5 s vs 12.7 s). One clip with synthetic noise is thin evidence, so this is a tie-break and not a ranking: published benchmarks put `large-v3-turbo` at or slightly above `medium.en` on English, and nothing here contradicts that. The re-check on real ADV recordings is in "ADV recordings 2026-10-21" below (`medium.en` kept). Switching is one config value: `models` already has all three.

## Limits and their receipts

| Limit | Value | Receipt |
| --- | --- | --- |
| `audioMaxSeconds` | 120 | the spec's 5-30 s prompts x4. A 120 s clip (jfk repeated, truncated at 120 s) took 60.7 s and 65.1 s on `medium.en`, peak RSS 1896 MB. 120 s of PCM is 3.84 MB in the relay |
| `audioIdleTimeoutMs` | 5000 | home WiFi worst gap 130 ms (`2026-10-21-firmware-voice.md`); hotspot unmeasured |
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
node relay/scripts/measure-whisper.mjs medium.en 8 3 clip.wav "reference text"
```

## ADV recordings 2026-10-21

Re-check promised above. Two real clips recorded on the ADV mic through the relay (`stt.keepSamples`), plus `samples/jfk.wav` for continuity. Only 2 usable ADV clips exist; 5 were planned (a 0.6 s empty tap was ignored), so this is thin evidence too. Audio stays out of the repo. Same host and tool as above (`measure-whisper.mjs`, 8 threads), 3 timed runs after a warm-up, with the live relay's own `medium.en` child idle on its port. Memory available at the time: 7.3 GiB (`free -h`, agents and the live relay running).

Clips (peak level from the relay's sidecar):

| Clip | Length | Peak | Reference |
| --- | --- | --- | --- |
| hello | 2.7 s | -17.7 dBFS | "Hello there, can you hear me?" |
| long | 13.8 s | -2.5 dBFS | "Apples worked on this speech-to-text implementation now tonight and I'm testing this so I just want to know whether you can handle more complex phrases and sentences." |

The long clip peaks at -2.5 dBFS, 2.5 dB under full scale, so loud speech is close to clipping; the hello clip at -17.7 dBFS has about 15 dB of headroom. That is the mic-gain receipt: a gain increase would clip the loud case.

Word errors (3 runs were identical for every model and clip), median latency, peak RSS:

| Model | hello (2.7 s) | long (13.8 s) | jfk (11.0 s) | Total errors | Median hello / long / jfk | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| `small.en` | 0 | 4 | 0 | 4 | 2218 / 2852 / 2667 ms | 643 MB |
| `medium.en` | 0 | 0 | 0 | **0** | 7517 / 8842 / 8313 ms | 1788 MB |
| `large-v3-turbo` | 0 | 3 | 0 | 3 | 11966 / 12623 / 12423 ms | 1748 MB |

Long-clip transcripts (the only ones that differ from the reference):

- `small.en`: "Oppos worked on this speech to text implementation now the night and I'm testing this so I just want to know whether you can handle more complex phrases and services"
- `large-v3-turbo`: "Opus worked on this speech to text implementation now the night and I'm testing this so I just want to know whether you can handle more complex phrases and sentences."
- `medium.en`: word-perfect.

Hyphens count as spaces in the normalization, so "speech-to-text" and "speech to text" match.

**Decision: keep `medium.en`.** It is the only model with 0 errors across the three clips; `small.en` has 4 and `large-v3-turbo` 3 (both miss "Apples", "tonight"). It fits: 1788 MB peak against 7.3 GiB available. `large-v3-turbo` is also 1.4x slower here (12.6 s vs 8.8 s on the long clip), so nothing argues for switching. `whisper.model` in `relay/src/config.ts` is unchanged.

`measure-whisper.mjs` now takes an optional 5th argument, the reference text: `node relay/scripts/measure-whisper.mjs medium.en 8 3 clip.wav "reference text"`.
