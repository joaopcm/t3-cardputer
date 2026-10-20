# T3 Cardputer: design

Date: 2026-10-20
Status: draft, pending approval

## Intent

João runs coding agents (Claude Code, Codex, Cursor) 24/7 on an Ubuntu homelab through T3 Code. Today his macOS laptop is the only window into them, over T3 Connect. When he's away from home he wants to check on agents, unblock them, and start new work **without opening a laptop**, using an M5Stack Cardputer ADV: a pocket device with a real keyboard and a mic.

Why the ADV instead of a phone: a dedicated device with a physical keyboard is nicer for this than another phone app.

Success: from a café, on public WiFi or a phone hotspot, João opens the app, immediately sees which agents are waiting on him, approves a command with one key, reads the latest reply of a finished thread, answers it by voice, and starts a new task on any project. None of it needs the laptop.

## Goals

1. **Home screen sorted by urgency.**
   - **Needs you** comes first: an approval (`!`), a question (`?`), or a thread that failed, errored, or was interrupted (`✗`). Then **running**, then **done in the last 24 hours**.
   - It shows every non-archived T3 thread, including ones started from the laptop.
   - Each row shows the project, the thread title, and how long it has been in that state.
2. **Approvals and questions:** opening a waiting thread jumps to the request. One key answers it. The options mirror whatever T3 offers for that request (allow once, always allow, deny, deny with a reason). Questions show the agent's choices.
3. **Thread view:** the latest agent reply only, word-wrapped and scrollable, with a reply line below. The reply goes to the same thread with the same model.
   - If the thread is still running, Enter **queues** the reply behind the current turn. A separate key (`Fn+Enter`) **steers** instead.
   - Interrupting a run is not available from the device, so a stray keypress can't kill hours of work.
4. **Voice prompts, English only:** hold a key to talk and release to stop. The transcript shows before sending, and you can send it, edit it in the keyboard line, or discard it. Transcription happens on the homelab; audio never leaves it.
5. **New task:** pick a project (most recent first), then type or speak a prompt. Model, workspace (main checkout or new worktree), and mode default to the last used **for that project**, and Tab changes them.
6. **Works anywhere:** home WiFi, public WiFi, or a phone hotspot.
7. **Lives alongside other apps:** installable through the community Launcher (app-only `.bin` on the SD card). The same code also builds a full image for the browser installer, if the device should ever be dedicated to this app.

The approved screen mockups are in `docs/superpowers/specs/2026-10-20-t3-cardputer-screens.html`, drawn at the real 240×135 resolution.

## Non-goals

- Full transcripts, diffs, file browsing, or code review on the device. The latest reply is enough.
- Interrupting runs from the device.
- Push notifications in v1. You find out when you open the app, and the app keeps updating live while it's open. A "watch mode" that beeps on new approvals may come later, once its battery cost is measured and shown.
- Speech-to-text on the device. The ESP32-S3 can't do free-form dictation.
- Languages other than English for voice.
- The device speaking T3's internal protocol directly.
- Public WiFi behind a captive login page. The ADV can't complete those; the hotspot is the fallback.

## Anti-goals (failure even if it "works")

- **A T3 credential on the device.** A lost ADV must not equal a stolen T3 session. The device holds only a relay device token, revocable from the homelab.
- **Firmware that breaks when T3 updates.** T3's internal protocol changes almost daily. All T3 coupling lives in the relay, which is quick to fix and redeploy. Re-flashing the ADV because T3 shipped is a failure.
- **Silent failures.** No blank screens. Every error and every budget names itself on screen, for example:
  - `reply truncated: max_reply_bytes=N, reply was M`
  - `relay unreachable: https://…`
  - `T3 token expired: run 't3-cardputer-relay pair' on homelab`
- **Unmeasured limits.** Every number in the code (buffer sizes, chunk sizes, timeouts, list lengths) comes from a measurement noted next to it, sized as a tripwire well past normal use.
- **Leaking the homelab in a public repo.** The repo is public. No hostnames, tailnet names, tokens, or relay URLs get committed, including in docs and receipts. Those live in local config only.

## Facts the design rests on (from recon, 2026-10-20)

**Cardputer ADV:**
- ESP32-S3FN8: 8 MB flash, ~512 KB SRAM, **no PSRAM**.
- ST7789V2 240×135 display; 56-key keyboard through a TCA8418 (I2C).
- Mic through an ES8311 codec over I2S at a 16 kHz default. Mic and speaker share I2S and can't run at the same time.
- 1500 mAh battery; SD card slot.
- The M5Unified ADV mic setup leaves the codec at minimum gain, so speech will be quiet until the gain is raised.

**TLS on ESP32:** ~40 KB of internal RAM per connection, and the handshake fails under fragmentation. → **One TLS connection only.**

**T3 Code on the homelab:**
- Server on `127.0.0.1:3773`. T3 Connect is a T3-managed Cloudflare Tunnel to that port.
- The server exposes **MCP at `/mcp`**, with its own OAuth: a pairing code, PKCE, a 30-day bearer token, and a selectable access level.
  - Its tools cover everything **except permission approvals**: `t3_project_list`, `t3_thread_list` (filter by `statuses`, including `waiting`), `t3_thread_read`, `t3_thread_wait`, `t3_thread_send` (`mode`: `auto` | `queue` | `steer` | `restart`), `t3_thread_launch` (`runtimeMode` includes `approval-required`; `scratch: true` launches without a project), `t3_pending_request_list`/`read`/`respond`.
  - `t3_pending_request_respond` **"cannot approve a permission request"**, and `t3_pending_request_list` excludes approvals. Both quotes come from the tool descriptions, read 2026-10-20. MCP only covers the agent's *questions*.
- **Approvals go through T3's internal protocol.** The Mac client uses it.
  - A bearer token comes from `t3 pair` traded at `POST /oauth/token`. Without DPoP it lasts 30 days.
  - It talks over `GET /ws?orchestrationProtocol=2` using Effect RPC over JSON. Requests look like `{_tag:"Request",id,tag,payload}`, and every stream chunk needs an `Ack` back.
  - The command is `orchestration.dispatchCommand` with `runtime-request.respond {requestId, decision}`.
  - The server rejects unknown protocol versions with HTTP 426 and exposes capability flags.
  - This protocol is internal and changes often.
- Raw payloads are large: the thread list is ~100 KB of JSON for 57 threads, and one thread snapshot can be up to 1 MiB. The MCP list is ~700 B per thread.
- Source: github.com/pingdotgg/t3code (MIT).

**Homelab:**
- Ubuntu 26.04, Ryzen 7 3700X (16 threads), 15 GiB RAM.
- GTX 1060 6GB, currently on `nouveau`, so no CUDA. `nvidia-driver-580` is Ubuntu's recommended driver for it.
- Tailscale is running, with no `serve`/`funnel` config yet. Node is installed; Bun is not.

## Architecture

```
 Cardputer ADV ──── one wss, small JSON + binary audio ────▶ relay (homelab, Node/TS)
   firmware (ESP-IDF)                                          │
   ▲ screen-sized view models                                  ├─ T3 MCP  http://127.0.0.1:3773/mcp   (everything but approvals)
   │ live updates while app open                               ├─ approvals adapter  ws://127.0.0.1:3773/ws  (internal protocol, self-repairing)
   │                                                           └─ whisper.cpp (local STT, English)
   └──────────────────────────────────────────────────────────────┘
           reachable from anywhere via Tailscale Funnel:
           https://<homelab>.<tailnet>.ts.net  →  relay port
```

### Relay (homelab)

- **TypeScript on Node** (my call: João's stack, and the official MCP TypeScript SDK). Runs as a systemd user service.
- **Talks to T3 through MCP on localhost for everything except approvals.** MCP tool names are the most stable interface T3 has.
  - Paired once through T3's MCP OAuth with a pairing code, at the lowest access level that still allows send, queue/steer, launch, and respond.
- **Approvals go through one isolated adapter** that speaks T3's internal protocol (see below). It's the only relay code that knows that protocol.
- **Credentials:** both T3 tokens (MCP and internal) are stored on the homelab with `0600` permissions, outside the repo.
  - When a token is near expiry, the device shows how many days are left.
  - When one is rejected, the device shows the exact command to re-pair.
  - The builder checks whether either token can be refreshed without re-pairing, and does so if possible.
- **Does all the shaping.** It turns MCP results into **screen-sized view models** (home rows, one approval, one reply split into pages, the project list), so the device never parses large JSON. Page and row budgets come from measuring real replies and threads; when a budget truncates, the device says so.
- **Live updates:**
  - While a device is connected, the relay watches T3 and pushes diffs of the home screen and the open thread. It uses `t3_thread_wait` or polls `t3_thread_list`, whichever measures cheaper.
  - On every (re)connect, the relay sends full state first, then diffs.
- **Per-project defaults:** remembers the last model, workspace strategy, and mode used from the device for each project. The first time, it falls back to the project's T3 defaults.
- **Speech-to-text:** receives the audio stream and runs `whisper.cpp` with an English-only (`.en`) model.
  - Start on CPU, and record latency for real 5–30 s prompts with a few `.en` model sizes in a receipt.
  - If CPU is too slow, the GPU path (CUDA after João installs `nvidia-driver-580`, which needs a reboot that stops all agents) is a config switch, not a rewrite.
  - Returns partial transcripts while you talk if streaming proves fast enough; otherwise the final text after release.
- **Device auth:**
  - `t3-cardputer-relay pair` prints a short one-time code; the device trades it for a long-lived device token.
  - `t3-cardputer-relay devices` lists tokens and `revoke` kills one.
  - Every wss connection must present a valid token or it's closed before any data flows.
  - **Failed-auth lockout**, because the relay is on the public internet and the repo is public. Failed token and pairing attempts are rate-limited per source, with the limit sized as a tripwire a real device never hits. Lockouts are logged and visible in `t3-cardputer-relay devices`.
  - Tokens are compared in constant time, and pairing codes expire quickly and are single-use.
- **Exposure:** Tailscale Funnel publishes the relay on HTTPS 443 at a stable `*.ts.net` address. João has accepted that this is public, protected by the device token. Funnel has to be allowed in the tailnet policy.

### Approvals adapter and self-repair

Approvals need T3's internal protocol, which changes often. The adapter is built to break loudly and fix itself.

```
T3 version changes ──▶ relay runs the canary
                         │
                passes ──┴── fails
                  │            │
               all good        ▼
                         ADV: "approvals down, fix in progress" (+ the repair thread on Home)
                         relay launches a repair thread on t3-cardputer
                         │
                         ▼
                   PR from the repair thread ──▶ GitHub CI green
                         │
                         ▼
                   relay runs the canary against the PR's adapter (staging copy)
                         │
                passes ──┴── fails ──▶ repair thread told why, keeps going
                  │
                  ▼
           relay merges the PR, pulls main, restarts itself, re-runs the canary
```

- **Adapter boundary:** all internal-protocol code lives in `relay/src/approvals/`, behind one interface (list pending approvals for a thread, read one, respond). The rest of the relay never imports anything else from that folder.
- **Version watch:** the relay reads the T3 server version and capability flags (`/.well-known/t3/environment`) at startup and on a schedule. A change triggers the canary.
- **Canary:**
  - Launches a scratch thread (`t3_thread_launch` with `scratch: true` and `runtimeMode: "approval-required"`) asking the agent to run a harmless command (`true`).
  - Waits for the approval to appear through the adapter, approves it through the adapter, and confirms through MCP that the run completed.
  - Archives or settles the scratch thread afterward.
  - Runs only on version change, after a deploy, and on demand (`t3-cardputer-relay canary`), never on a timer, because each run costs one short agent turn.
- **Failure path:**
  - Approvals are marked unavailable. The device shows `approvals down: <reason>, fix in progress` on approval screens, and Home flags it.
  - The relay launches **one** repair thread (deduplicated per T3 version) on the `t3-cardputer` project in a new worktree. The prompt includes the canary failure and the adapter error, the old and new T3 versions, the instruction to fix `relay/src/approvals/` against the `pingdotgg/t3code` source for the new version, and to make the contract tests pass and open a PR from a `repair/` branch.
  - The repair thread runs in a mode that needs no approvals, since approvals are the thing that's broken.
- **Auto-merge (decided by João), with guardrails (my call, because the repo is public and anyone can open a PR):**
  - Only PRs opened from the repair thread the relay launched, which the relay tracks by thread ID and PR number, and only from a `repair/` branch.
  - The PR diff touches only `relay/src/approvals/**` and its tests. Anything else blocks the merge and is reported in the repair thread.
  - GitHub CI is green, **and** the homelab canary passes against the PR's adapter, built in a staging directory and run without touching the live relay.
  - Then the relay merges with a fine-grained GitHub token scoped to this repo only, pulls `main`, restarts through systemd, and re-runs the canary on the live build.
- **Redeploy from `main`** also covers normal changes: when `main` moves, the relay pulls, builds, restarts, and runs the canary.
- **Tripwire:** if repair fails repeatedly for the same T3 version, the relay stops launching repair threads and the device says so, with the number of attempts. Approvals then wait for the laptop. The attempt limit is sized as a tripwire, with a receipt.

### Device ↔ relay protocol

- **One wss connection**, opened on app start and reconnected with backoff. The status bar shows the connection state.
- **Text frames are small JSON messages** with a `type` field. Device → relay:
  - `hello` (token, firmware version, protocol version)
  - `open_thread`, `page`, `reply` (with `queue` or `steer`), `respond`, `launch`, `list_projects`, `audio_start`, `audio_end`, `audio_cancel`
  
  Relay → device:
  - `home`, `thread_page`, `request`, `projects`, `transcript_partial`, `transcript_final`, `error`
  
  The exact schema is the builder's to define. The protocol is versioned, and a mismatch shows "update firmware" or "update relay" on screen, never undefined behavior.
- **Audio uses binary frames:** 16 kHz, 16-bit mono PCM, streamed in small chunks while the key is held (~32 KB/s). The chunk size comes from measuring heap and latency. Compression (µ-law/ADPCM) only if a slow hotspot measurably needs it.
- **Message size cap on the device:** the relay never sends a frame bigger than the device's measured receive budget, and the protocol declares that budget in `hello`.

### Firmware (Cardputer ADV)

- **Built on João's `podrivo/cardputer-adv-template`:** ESP-IDF 5.4.x, M5GFX, with M5Unified added as a component for keyboard and mic. (My call: build on the template he chose. The builder may switch to Arduino-as-component if M5Cardputer's ADV mic/keyboard helpers can't be used from IDF without much effort, and should note why.)
- **Two build outputs from one codebase:**
  - app-only `.bin` sized for Launcher's app partition (measure the real partition size and fail the build loudly if it doesn't fit);
  - full merged image for the browser installer.
- **Screens, as in the approved mockups:**
  - Home, Approval, Thread (latest reply + reply line), Voice, New task (project picker, then prompt with Tab options).
  - Setup: add WiFi network, pair with relay.
  - Error screens that name the problem.
- **Keys:**
  - Fn + `; . , /` are arrows. Enter opens/sends (queues if running). `Fn+Enter` steers. Backspace goes back. `N` starts a new task. `R` refreshes.
  - On Approval: `Y`/`A`/`N`/`T`.
  - **Hold `` ` `` to talk.** Push-to-talk on key-up; the mic runs only while it's held.
- **Power (my call):**
  - While the app is open, the screen dims and then turns off after idle; any key wakes it. The timeouts are chosen by measuring battery drain and are configurable.
  - The wss connection may drop while the screen is off. On wake the device reconnects and the relay sends full state, so nothing depends on staying connected.
- **Settings in NVS:**
  - several saved WiFi networks (home, hotspot, others), tried strongest-first;
  - relay URL;
  - device token.
- **Setup and pairing:** first run (or a setup key) opens setup. The relay URL can be preloaded from `/t3-cardputer/config.json` on the SD card so it doesn't have to be typed (my call). The pairing code is typed on the device.
- **Mic:** raise ES8311 gain until speech levels are good, measured on real recordings. Release I2S from the speaker before recording.
- **Memory:** one TLS socket. All buffers are allocated once at startup from measured sizes, and free internal heap is shown on a debug screen.

## Repository

`/srv/repositories/t3-cardputer` (git, `main`), pushed to a new **public** GitHub repo `joaopcm/t3-cardputer` (personal account). MIT license (my call, matches T3 Code). Monorepo:

```
firmware/   ESP-IDF app (from the template)
relay/      Node/TS relay + CLI (pair, devices, revoke)
docs/       specs, plans, receipts (measurements)
```

Local config (relay URL, tokens, tailnet names) is gitignored; the repo ships `*.example` files only.

## Decided by João

- Away-from-home use over any WiFi or hotspot, through the internet.
- Approvals are first-class.
- Latest reply only; no full transcripts or diffs.
- Notifications: none in v1. Check on open; watch mode maybe later.
- Speech-to-text runs on the homelab, not in the cloud. English only. GPU driver install is approved, done by João at a time he picks.
- New-task flow: pick a project each time; other options remembered per project, changed with Tab.
- Replies to a running thread queue by default; one key steers instead.
- Relay exposed publicly via Tailscale Funnel, protected by device token.
- Approvals via an internal-protocol adapter that repairs itself through an agent thread. Fix PRs **auto-merge** when CI and the canary pass.
- All five screen mockups approved.
- Keep other apps on the ADV (Launcher); a full image is also built.
- Repo at `/srv/repositories/t3-cardputer`, public on GitHub as `joaopcm/t3-cardputer`.

## My calls (João can override)

- Repo name `t3-cardputer`; MIT license.
- Relay in TypeScript on Node.
- Relay talks to T3 via MCP, not the internal WS protocol.
- whisper.cpp with an English-only model, CPU first, GPU if measured too slow.
- Firmware on the ESP-IDF template plus M5Unified.
- Hold `` ` `` to talk; `Fn+Enter` to steer.
- Failed/errored/interrupted threads show under **Needs you**.
- Home shows all non-archived threads; "done" means the last 24 hours.
- Screen dims/sleeps when idle; the device fetches full state again on wake.
- Relay URL preloadable from the SD card.
- Failed-auth lockout on the relay.
- Auto-merge guardrails: repair-thread PRs only, `repair/` branch, diff limited to `relay/src/approvals/**`.
- Canary runs on version change, deploy, or on demand, never on a timer.

## Left to the builder

- How approvals show up through each interface: verify against a real approval in the first task (a spike) before building on it.
- Which repair-thread runtime mode avoids approvals, and how the relay links a repair thread to its PR.

- Exact device↔relay message schema and version handshake.
- How the relay detects state changes (`t3_thread_wait` vs polling): pick by measurement.
- Which MCP tool or argument does queue vs steer.
- whisper.cpp `.en` model size and partial-transcript strategy: pick by latency receipt.
- Page sizes, row counts, audio chunk size, reconnect backoff, idle timeouts, lockout thresholds: all measured, each with a receipt.
- UI drawing approach (direct M5GFX vs a sprite double buffer), fonts within the mockup's ~40×11 grid.
- Build tooling and CI.
