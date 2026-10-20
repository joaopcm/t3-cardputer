# T3 Cardputer firmware: design (plan 2)

Date: 2026-10-20
Status: draft, pending approval
Builds on: `docs/superpowers/specs/2026-10-20-t3-cardputer-design.md` (the main spec; its goals, anti-goals and screen decisions still apply) and `docs/protocol.md` (the wire contract, the only interface to the relay).

## Intent

The relay is live on the homelab. This plan builds the other half: the app on João's Cardputer ADV. It turns the relay's view messages into the five approved screens and sends keys, text and voice back. It must work over home WiFi, public WiFi or a phone hotspot.

## Current state (2026-10-20)

**Device:**
- The ADV is empty; nothing was ever installed.
- It's plugged into the homelab over USB at `/dev/ttyACM0`. A udev rule gives the `plugdev` group, which João is in, read/write on Espressif devices.
- Chip, read with esptool: ESP32-S3 (QFN56) rev v0.2, embedded 8 MB flash, 40 MHz crystal. No PSRAM, as the main spec assumed.

**Relay:**
- Live at a public Tailscale Funnel URL.
- One device is paired, the laptop simulator.
- `docs/protocol.md` is the contract, and `relay/src/sim/` is a working reference client for it.

**Homelab tooling:**
- No ESP-IDF, esptool, cmake or ninja installed system-wide. `uv` is at `~/.local/bin/uv`. No sudo is available to the agent.

## Goals

1. **The approved screens.** Home, Approval, Thread (latest reply plus a reply line), Voice, and New task, as in `docs/superpowers/specs/2026-10-20-t3-cardputer-screens.html`. Plus Setup (WiFi, pairing) and error screens that name the problem.
2. **Exactly the documented protocol.** Hello and version handshake, every close code with its documented device action, idempotent message ids, the reconnect with backoff, heartbeat pongs, and binary audio frames.
3. **Voice.** Hold `` ` `` to talk. 16 kHz mono s16le streamed while the key is held. The transcript shows before sending, and you can send it, edit it in the reply line, or discard it.
4. **First-run setup on the device:**
   - Add WiFi networks: scan, pick or type the SSID, type the password. Several are saved and tried strongest first.
   - Type the pairing code.
   - The relay URL is baked in at build time from a local, gitignored config file, so it's never typed and never committed.
5. **Install outputs from one codebase:** a full merged image (what goes on the ADV now) and a Launcher-compatible app-only `.bin` sized for Launcher's app slot. The build fails loudly if the app-only image doesn't fit.
6. **Homelab dev loop the agent runs on its own:**
   - Build, flash over `/dev/ttyACM0`, reset, read serial logs.
   - **Screen capture over serial:** a debug command dumps the framebuffer, and a host script turns it into a PNG, so the agent can compare screens to the mockups without João.

## Non-goals

- Everything listed as a non-goal in the main spec: no transcripts or diffs, no push notifications in v1, no on-device STT, no interrupting runs.
- A watch/beep mode (main spec: later, after measuring battery).
- Captive-portal WiFi logins.
- Building for the original Cardputer, which has a different keyboard and mic.
- OTA updates in v1. João has the homelab USB path, and Launcher can install from SD later.

## Anti-goals

- **A blank or frozen screen.** Every failure shows a named reason and what to do: WiFi down, relay unreachable, TLS failure, token revoked (re-pair), version mismatch (update firmware or relay), budget hit (names the budget, the limit and the ask).
- **Wiping the token on anything except 4401.** A slow hotspot must never force a re-pair. Close code 4408 means reconnect and keep the token, per `docs/protocol.md`.
- **Unmeasured buffers.** Every buffer, budget and timeout comes from a measurement on this ADV: free internal heap with WiFi and TLS up, the TLS handshake peak, frame sizes from the live relay, audio chunk timing over the hotspot. Each one has a receipt in `docs/receipts/`. The values announced in `hello` (`maxFrameBytes`, `maxHomeRows`, `cols`, `bodyRows`) come from those measurements.
- **Secrets or homelab identifiers in the public repo.** The relay URL, WiFi credentials and device token live only on the device (NVS) and in a gitignored local build config. The repo's leak grep in CI must stay clean.

## Constraints (measured or verified)

- No PSRAM, about 512 KB SRAM. One TLS connection only. Each TLS connection takes about 40 KB of internal RAM, and the handshake can fail under heap fragmentation, so all buffers are allocated once at boot.
- The mic (ES8311 over I2S) and the speaker share I2S. The speaker is released before recording. M5Unified leaves the mic gain near minimum, so it gets raised and measured on real speech.
- Keyboard is a TCA8418 over I2C. Arrows are Fn + `; . , /`.
- Display is 240×135. The mockups use about 40 columns × 11 rows, with a monospace font at 6×12 px cells.

## Decided

- **Toolchain:** João's `podrivo/cardputer-adv-template` (ESP-IDF v5.4.2, M5GFX ≥ 0.2.29) as the base. M5Unified is added as an IDF component for keyboard and mic. The builder may pull in only the M5Cardputer ADV keyboard and mic driver code if M5Unified can't drive them from IDF without much effort, and must say why.
  - All tooling is installed user-locally on the homelab under `~/esp` and `~/.espressif`, no sudo. Use IDF's own tool installer for cmake, ninja and the toolchain.
- **Repo layout:** `firmware/` at the repo root, next to `relay/`.
- **First install:** the full merged image, flashed from the homelab. Launcher stays optional.
- **The relay simulator is the reference behavior.** Where the doc is silent, match what `relay/src/sim/device-sim.ts` does, and add the missing rule to `docs/protocol.md`.
- **Relay leftover affecting firmware:** question requests can still exceed `bodyRows` despite the doc. The firmware must degrade gracefully (scroll the request body, keep the options reachable) rather than trust the fit.

## My calls (João can override)

- Hold `` ` `` to talk, `Fn+Enter` to steer, `R` to refresh, `N` for a new task (all already in the mockups and `docs/protocol.md`).
- WiFi credentials, device token and relay URL in NVS. A setup key (`Fn+S`) reopens setup.
- Screen capture over serial for agent-side visual checks.
- Voice model re-check: record 5 real prompts on the ADV, compare `small.en`, `medium.en` and `large-v3-turbo` on them, and keep or change the relay default with a receipt.
- Screen sleep: dim and then sleep after idle. Timeouts come from battery measurements; on wake, refresh.

## Settled after the builder check (my calls)

1. **Relay changes are allowed in this plan, kept small and additive.**
   - Protocol stays v1. New fields are optional, nothing is removed or renamed, and the frozen handshake is untouched. Every protocol change updates `docs/protocol.md`, `relay/src/protocol/messages.ts`, the sim and the tests together.
   - Expected relay changes:
     - a `models` list for New task;
     - `audio_idle_timeout_ms` set from hotspot measurements;
     - the voice default, if the re-check says so;
     - doc fixes.
   - Merging to `main` does not redeploy the live relay by itself. After a merge, the plan redeploys explicitly: pull the deploy clone, build, restart the service, run the canary.
2. **Tab cycles model too.** The relay adds an optional `models` list to `projects`: the usable models from T3's catalog, each with an id and a short ASCII label. New task cycles that list with Tab, along with workspace (root or worktree) and mode.
3. **`Fn+Enter` steers without interrupting.** The relay sends T3's `steer` mode, which delivers the message into the running turn. Interrupt-and-restart is T3's separate `restart` mode, which the relay never uses. `docs/protocol.md:146` says "interrupts it", which is wrong; the plan fixes that wording. Steer stays a single chord.
4. **Home scrolls.**
   - The device announces a `maxHomeRows` sized by measurement against its frame budget, not one screen's worth, so every waiting thread is reachable.
   - The list scrolls with the arrows. `needs` rows always sort first, so the top screen still shows what's waiting on João.
   - Section headers like `NEEDS YOU (2)` are drawn by the device from `counts`. "Done" isn't collapsed in v1; it's just further down the list.
5. **Launcher slot.** Size the app-only image against Launcher's default partition scheme for the Cardputer ADV in its current release, recorded as a receipt with the Launcher version. The full image uses our own partition table. The build fails if the app-only image exceeds that slot, naming the slot size and the image size.

## Where João is needed

Only at checkpoints, with the device in hand:
1. Typing feel and screen readability on the first build with real screens.
2. Real WiFi and hotspot setup on the device.
3. Voice in a real room: record the 5 test prompts and confirm the transcripts.
4. A walk away from home: use it over the phone hotspot end to end.

## Left to the builder

- Module layout inside `firmware/`, the UI drawing approach (sprite double buffer vs direct), and the font choice within the 40×11 grid.
- The JSON parsing approach on-device (streaming vs bounded document), within measured budgets.
- Reconnect backoff and idle timeouts, by measurement.
- How the screen-capture debug command is framed on serial.
