# T3 Cardputer distribution and docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any T3 Code developer with a Cardputer ADV runs one setup script on their T3 machine, opens the link it prints, clicks install, and lands on Home with nothing typed on the device.

**Architecture:** The firmware stops baking the relay URL in: it becomes an NVS setting, written by a small write-only provisioning channel on the USB serial port (always on, release builds too) or typed in Setup. A static site at `t3-cardputer.jopcmelo.com` flashes the public image with esptool-js over Web Serial and provisions WiFi, relay URL and pairing code. The relay ships as one bundled `.mjs` file in GitHub Releases; `setup.sh` (served by the site, version-pinned) installs it, whisper, T3 pairing, Funnel and the service, then prints the install link. CI cuts a release when `main` changes and deploys the site with the release's firmware files.

**Tech Stack:** ESP-IDF v5.4.2 C++17 (t3core host-tested with doctest), Node 22 + TypeScript + vitest (relay), esbuild (relay bundle), POSIX `sh` (setup script), plain ES modules + esptool-js + `node:test` (site), GitHub Actions, Vercel.

**Spec:** `docs/superpowers/specs/2026-10-21-distribution-design.md` (read it first; it argues every decision here).

## Global Constraints

- Site and links use `https://t3-cardputer.jopcmelo.com` exactly. Install link format: `https://t3-cardputer.jopcmelo.com/install#r=<encodeURIComponent(relay https url)>&c=<8-char pairing code>`.
- Protocol stays v1, additive only; the frozen handshake section of `docs/protocol.md` is untouched.
- Funnel always on `--https=8443`, never 443.
- No relay URL, tailnet name or Tailscale IP in the repo, the site or any published artifact. Leak grep (CI `ci.yml` step) must stay empty and extends to `site/`: `[a-z0-9]\.ts\.net|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+|prod-[0-9a-f]+\.t3coderelay`.
- Secrets never leave the user's machines: no telemetry, no network call the user didn't start, the `#…` fragment never sent to the server, config and secrets files 0600, tokens and WiFi passwords never in argv, logs or the serial port's output.
- USB provisioning is write-only: it can set WiFi, relay URL and pairing code; it can never return a token, a WiFi password or screen content. The release image keeps `CONFIG_T3_DEBUG_SERIAL` and `CONFIG_T3_KEYBOARD_TRACE` off.
- Only close code 4401 wipes the device token. One new user-intent rule: setting a relay URL different from a non-empty stored one wipes the token (it belongs to the old relay) and says so on screen. Setting it from empty keeps the token.
- Updates keep NVS (WiFi, token, relay URL) unless the user picks "clean install".
- No sudo. The setup script installs user-locally; a step that needs root stops and says which command the user should run.
- Every new number has a receipt (docs/receipts/ or a `// receipt:` line); budget failures read `<budget>=<limit>, <what> needed <n>`.
- Every failure the user can hit names itself with the next step to take (device screen, setup output, install page).
- macOS and Linux relay hosts. Windows detected and refused with a named message.
- Docs in normal sentence case, João's voice otherwise (short, plain verbs, pasted output, no em dashes, no emoji), then a humanizer pass. Commits lowercase conventional, no Co-Authored-By or agent credit.
- Zero code comments except why/receipt lines.
- João's homelab install (git checkout tracking `main`, self-repair on) keeps working: `setup.sh` refuses to convert it, and his ADV moves to the public image without a re-pair.

## Review Focus

1. A pairing code in the install link that's already expired (10 min `pairingCodeTtlMs`) or used: the device must say `pair: code expired or used, run t3-cardputer-relay install-link and open the new link` and drop the stored code, never loop re-trying it. Test in Task 3.
2. The install page opened in Safari, Firefox or a phone: a named "needs Chrome or Edge on a computer" message, no dead button. Test in Task 7.
3. Re-running `setup.sh` on a machine that's already set up (including half-finished runs): it updates in place, keeps `secrets.json`, `relay.json` and paired devices, and refuses on a repair-enabled checkout. Tests in Task 8.
4. A provisioning frame with a 64-char WiFi password, an SSID with spaces and non-ASCII UTF-8, an empty password (open network), or a frame over the line budget: accepted or refused by name, never truncated silently. Tests in Task 2.
5. The relay URL typed in Setup with a trailing slash, uppercase host, `http://`, a path, or no scheme: normalized or refused by name. Tests in Task 1.

---

## File map

```
firmware/components/t3core/
  include/t3/relay_url.h, relay_url.cpp        Task 1  parse + normalize relay URL
  include/t3/provision.h, provision.cpp        Task 2  T3PROV/T3INFO frame parse/encode
  app.cpp, include/t3/app.h, screens/setup.cpp Task 1, 3  SetupRelay screen, auto-pair
firmware/main/
  settings.{h,cpp}                             Task 1, 2  relay_url, pair_code keys
  serial_port.{h,cpp}  (new)                   Task 2  one USB serial reader, routes frames
  debug_serial.{h,cpp}                         Task 2, 11 becomes a line handler; FRAME cmd (11)
  app_main.cpp, transport.cpp, CMakeLists.txt  Task 1-3
firmware/scripts/
  provision.py (new)                           Task 2  dev provisioning from a 0600 JSON file
  release.sh                                   Task 4  generic web parts + manifest
  stage-screens.py (new)                       Task 11 docs screenshots from fixtures
relay/
  scripts/bundle.mjs, install-whisper.sh       Task 5
  src/cli.ts, src/install-link.ts, src/t3/token-expiry.ts, src/config.ts, src/session.ts, src/serve.ts   Task 5, 6
site/
  public/index.html, install.html, install.js, lib/fragment.js, lib/serial-frames.js, vendor/   Task 7
  public/setup.sh                              Task 8
  test/*.test.mjs, test/setup/*.sh             Task 7, 8
  vercel.json, package.json                    Task 7
.github/workflows/ci.yml, release.yml (new), auto-release.yml (new)   Task 9
README.md, docs/{install,using,troubleshooting,security,development}.md, docs/images/   Task 10, 11
```

---

### Task 1: Relay URL becomes a device setting

**Files:**
- Create: `firmware/components/t3core/include/t3/relay_url.h`, `firmware/components/t3core/relay_url.cpp`
- Modify: `firmware/main/settings.{h,cpp}`, `firmware/main/app_main.cpp`, `firmware/main/CMakeLists.txt`, `firmware/CMakeLists.txt`, `firmware/local.cmake.example`, `firmware/components/t3core/include/t3/app.h`, `firmware/components/t3core/app.cpp`, `firmware/components/t3core/screens/setup.cpp`, `docs/receipts/2026-10-21-nvs-settings.md`
- Test: `firmware/test/host/relay_url_test.cpp` (new), `firmware/test/host/setup_test.cpp`

**Interfaces:**
- Produces:
  - `namespace t3 { struct RelayUrl { std::string https; std::string wss; }; std::variant<RelayUrl, std::string> parseRelayUrl(std::string_view text); constexpr size_t kRelayUrlMax = 320; }`
  - `settings::relayUrl() -> std::optional<std::string>` (stored normalized `https://host[:port]`), `settings::setRelayUrl(std::string_view https) -> std::optional<std::string>` (error text). NVS key `relay_url` in namespace `t3`.
  - `App::Screen::SetupRelay`; `App::Out` gains `std::optional<std::string> relayUrl` (normalized https form) for app_main to persist.
  - `App::onBoot(bool hasWifi, bool hasToken, bool hasRelay)` (extends the existing `onBoot`): with `hasRelay == false` the app opens on `SetupRelay`.

- [ ] **Step 1: Write failing `relay_url_test.cpp`**
  - `"https://Relay.Example.com:8443/"` → `https = "https://relay.example.com:8443"`, `wss = "wss://relay.example.com:8443"`.
  - `"wss://relay.example.com"` → `https = "https://relay.example.com"`.
  - `"relay.example.com:8443"` (no scheme) → treated as https.
  - `"http://relay.example.com"` → error `"relay url must be https:// or wss://"`.
  - `"https://relay.example.com/v1"`, `"https://u@relay.example.com"`, `"https://relay.example.com?x"` → error `"relay url: host and port only, no path"`.
  - `"https://relay.example.com:99999"` → error `"relay url: port 99999 out of range"`.
  - 321 chars → error `"relay_url_max=320, url needed 321"`.
- [ ] **Step 2:** Run `firmware/scripts/test-host.sh`. Expected: FAIL (no `relay_url.h`).
- [ ] **Step 3: Implement `parseRelayUrl`.** Host is `[a-z0-9.-]+` after lowercasing, at least one dot or `localhost`. Receipt line on `kRelayUrlMax`: DNS name max 253 + `https://` 8 + `:65535` 6 = 267, 320 is the tripwire.
- [ ] **Step 4:** Run `firmware/scripts/test-host.sh`. Expected: PASS.
- [ ] **Step 5: Write failing `setup_test.cpp` cases.**
  - Boot with no relay URL → screen `SetupRelay`, row 0 says `relay: not set, type your relay url (setup.sh prints it)`.
  - Typing `relay.example.com:8443` + Enter → `Out.relayUrl == "https://relay.example.com:8443"`.
  - An invalid URL + Enter → the parse error on row 0, the text stays.
  - `Fn+S` → setup list has a `relay` row showing the current host (no token, no password).
- [ ] **Step 6: Implement the SetupRelay screen** in `screens/setup.cpp`, reusing the existing text-field typing helper with `kRelayUrlMax` as its budget.
- [ ] **Step 7: Wire `app_main.cpp` and settings.**
  - `transport_init(settings::relayUrl())` when set. When unset, skip transport and open `SetupRelay`.
  - On `Out.relayUrl`: if the stored URL is non-empty and different, call `settings::wipeToken()` first and log/show `relay changed: token cleared, pair again`. Then `setRelayUrl`, then `esp_restart()`.
  - Remove the `T3_RELAY_URL` compile definition and the `local.cmake` FATAL_ERROR. `local.cmake` stays optional and unused by the build. Update `local.cmake.example` to say so, or delete it if nothing reads it.
  - Add the `relay_url` line to the NVS receipt (bytes used vs the 36% headroom figure).
- [ ] **Step 8:** Run `firmware/scripts/test-host.sh`, `firmware/scripts/build.sh` and `firmware/scripts/release.sh`. Expected: all pass. Then the leak grep over `firmware/build-release/`: 0 hits.
- [ ] **Step 9: Commit** `feat(firmware): relay url is a device setting, typed in setup or provisioned`

### Task 2: Write-only USB provisioning channel

**Files:**
- Create: `firmware/components/t3core/include/t3/provision.h`, `firmware/components/t3core/provision.cpp`, `firmware/main/serial_port.{h,cpp}`, `firmware/scripts/provision.py`
- Modify: `firmware/main/debug_serial.{h,cpp}`, `firmware/main/settings.{h,cpp}`, `firmware/main/app_main.cpp`, `docs/protocol.md` (new section "USB provisioning", additive)
- Test: `firmware/test/host/provision_test.cpp` (new)

**Interfaces:**
- Produces (wire format; Task 7 implements the browser side, so copy it exactly):
  - Host → device: `\x02T3PROV <json>\n` with `json = {"wifi"?:{"ssid":string,"password":string},"relay"?:string,"code"?:string}`. Every key is optional, and at least one must be present.
  - Host → device: `\x02T3INFO\n`.
  - Device → host: `\x02T3PROV ok\n` or `\x02T3PROV err <reason>\n`. After `ok` the device restarts within 500 ms.
  - Device → host: `\x02T3INFO {"fw":string,"protocol":1,"relaySet":bool,"paired":bool,"wifiSaved":int}\n`.
  - Baud 115200 (USB-JTAG serial ignores baud; the page still opens with it).
- Produces (C++):
  - `namespace t3 { struct ProvisionWifi { std::string ssid; std::string password; }; struct ProvisionRequest { std::optional<ProvisionWifi> wifi; std::optional<RelayUrl> relay; std::optional<std::string> code; }; std::variant<ProvisionRequest, std::string> parseProvision(std::string_view json); struct DeviceInfo { std::string fw; bool relaySet; bool paired; int wifiSaved; }; std::string encodeInfo(const DeviceInfo &); constexpr size_t kProvisionLineMax = 1024; }`
  - `serial_port_start() -> bool`, `serial_port_poll_provision() -> std::optional<std::string>` (the json), `serial_port_poll_info() -> bool`, `serial_port_reply(std::string_view line)`.
  - `debug_serial_handle(std::string_view line)` (debug builds only). Its existing `debug_serial_poll_*` API is unchanged.
  - `settings::pendingPairCode() / setPendingPairCode(std::string_view) / clearPendingPairCode()`, NVS key `pair_code`.

- [ ] **Step 1: Write failing `provision_test.cpp`.**
  - Full frame → all three fields set. `relay` is normalized through `parseRelayUrl`.
  - `{}` → error `"provision: nothing to set"`.
  - SSID `"Café wifi 5G"` (UTF-8, spaces) → kept byte-exact.
  - 64-char password → accepted. 7-char password → `"wifi password: 8-63 chars or empty for an open network, got 7"`. Empty → open network.
  - 33-byte SSID → `"wifi_ssid_max=32, ssid needed 33"`.
  - `code` must be 8 chars of `[A-Z0-9]` after uppercasing, else `"pair code: 8 letters or digits, got <n>"`.
  - Unknown key → error naming it.
  - `encodeInfo({...})` → exact JSON above. It has no field that could carry a secret.
- [ ] **Step 2:** Run `firmware/scripts/test-host.sh`. Expected: FAIL.
- [ ] **Step 3: Implement `parseProvision` and `encodeInfo`** with the existing cJSON allocator hook and nesting limit. Receipt on `kProvisionLineMax`: worst frame is about 32 + 63 + 320 + 8 + JSON overhead ≈ 480 bytes; 1024 is the tripwire.
- [ ] **Step 4:** Run `firmware/scripts/test-host.sh`. Expected: PASS.
- [ ] **Step 5: Move the USB reader into `serial_port.cpp`.**
  - It always runs, in release builds too.
  - It routes `\x02T3PROV ` and `\x02T3INFO` lines itself. Other `\x02` lines go to `debug_serial_handle` only under `CONFIG_T3_DEBUG_SERIAL`; in release builds they're dropped silently, so nothing is echoed.
  - A line over `kProvisionLineMax` gets `\x02T3PROV err provision_line_max=1024, line needed <n>`.
  - Keep the existing rx/tx buffer and task receipts.
- [ ] **Step 6: Apply provisioning in `app_main.cpp`.**
  - Write in this order: wifi (`addWifi`), relay (`setRelayUrl` with the Task 1 token rule), code (`setPendingPairCode`).
  - Reply `ok`, or `err <first failure>` with nothing after the failure written.
  - Flush, then `esp_restart()`.
  - On `T3INFO`, reply with `encodeInfo` from settings.
  - Never log frame contents. Log `provision: wifi, relay, code` with field names only.
- [ ] **Step 7: Write `firmware/scripts/provision.py`.**
  - It reads the frame JSON from a file path argument. The file must be mode 0600, otherwise it refuses: `provision file must be 0600`.
  - It opens `/dev/ttyACM0` (`--port`) with RTS low before DTR.
  - It sends `T3PROV`, prints the device's reply line, and exits 0 on `ok`.
- [ ] **Step 8: Add the "USB provisioning" section to `docs/protocol.md`** with the exact frames above.
- [ ] **Step 9:** Run `firmware/scripts/test-host.sh`, `firmware/scripts/build.sh` and `firmware/scripts/release.sh`. Expected: pass. Check that `release.sh` still reports both debug Kconfigs off.
- [ ] **Step 10: Commit** `feat(firmware): write-only usb provisioning for wifi, relay url and pairing code`

### Task 3: Pair by itself from a provisioned code

**Files:**
- Modify: `firmware/components/t3core/include/t3/app.h`, `firmware/components/t3core/app.cpp`, `firmware/components/t3core/screens/setup.cpp`, `firmware/main/app_main.cpp`
- Test: `firmware/test/host/app_test.cpp`

**Interfaces:**
- Consumes: `settings::pendingPairCode()`, `settings::clearPendingPairCode()` (Task 2); the existing pair path (`Out.pair {code, name}` → `t3::encodePair` → `App::onPairResult`).
- Produces: `App::startAutoPair(std::string code)`. It emits `Out.pair` with device name `cardputer` once WiFi is up and there's no token, then shows `pairing with relay...`. Also `App::Out.pairCodeSpent` (bool), set on any pair result, success or failure.

- [ ] **Step 1: Write failing `app_test.cpp` cases.**
  - Boot with a pending code, no token, WiFi up → exactly one `Out.pair` with that code.
  - Success → token stored, `pairCodeSpent`, the app goes to Connecting/Home.
  - HTTP 401/404 (relay says unknown or expired) → row 0 reads `pair: code expired or used, run t3-cardputer-relay install-link and open the new link`, `pairCodeSpent`, screen `SetupPair`, no second `Out.pair`.
  - Network error → named error, `pairCodeSpent`, no retry loop.
  - A pending code with a token already present → no pair. The code is spent (stale).
- [ ] **Step 2:** Run `firmware/scripts/test-host.sh`. Expected: FAIL.
- [ ] **Step 3: Implement** `startAutoPair` in `App`. In app_main, call `clearPendingPairCode()` when `Out.pairCodeSpent` is set.
- [ ] **Step 4:** Run `firmware/scripts/test-host.sh`. Expected: PASS.
- [ ] **Step 5: Device check (debug build, controller-run)**, using `provision.py` with a fresh `t3-cardputer-relay pair` code and the home WiFi from `~/.config/t3-cardputer/wifi.local.json`.
  - Expected: the device restarts, joins, pairs and reaches Home without a key press.
  - Then send an expired code. Expected: the named message, and no retry.
  - A frame dump has no secrets: grep the serial log for the WiFi password and the token, with 0 hits.
- [ ] **Step 6: Commit** `feat(firmware): pair by itself from a provisioned code, once`

### Task 4: Generic release parts for the web

**Files:**
- Modify: `firmware/scripts/release.sh`, `firmware/scripts/flash-app.sh` (wording only), `docs/receipts/2026-10-21-launcher-slot.md` (note that the public image no longer embeds a URL)
- Create: `firmware/scripts/web-manifest.py`

**Interfaces:**
- Produces, in `firmware/build-release/web/`:
  - `bootloader.bin` @0x0, `partition-table.bin` @0x8000, `t3-cardputer.bin` @0x10000
  - `manifest.json` = `{"name":"T3 Cardputer","version":"<git describe>","chip":"esp32s3","protocol":1,"parts":[{"path":"bootloader.bin","offset":0,"sha256":"…"},{"path":"partition-table.bin","offset":32768,"sha256":"…"},{"path":"t3-cardputer.bin","offset":65536,"sha256":"…"}],"nvs":{"offset":36864,"size":24576}}`
  - Task 7 and Task 9 consume this exact shape. NVS is never written by an update; "clean install" erases the whole flash first.

- [ ] **Step 1:** `release.sh` stops warning "artifacts embed the relay URL" and instead runs the leak grep over `build-release/` and fails if it finds anything. It writes the three parts and calls `web-manifest.py` to emit `manifest.json`, taking offsets from `partitions.csv` and the build's `flasher_args.json` (never hard-coded).
- [ ] **Step 2:** Run `firmware/scripts/release.sh`. Expected:
  - the existing Launcher slot line;
  - `web parts: 3, manifest version <v>`;
  - `jq` on `manifest.json` shows offsets 0, 32768, 65536 and nvs 36864/24576;
  - each sha256 matches `sha256sum` of its file.
- [ ] **Step 3: Commit** `build(firmware): publishable web flash parts with a manifest, no relay url inside`

### Task 5: Relay ships as one file; whisper builds on macOS and with a GPU

**Files:**
- Create: `relay/scripts/bundle.mjs`
- Modify: `relay/package.json` (`"bundle"` script, `esbuild` devDependency pinned), `relay/src/cli.ts` (`--version`), `relay/scripts/install-whisper.sh`, `relay/deploy/` (add `com.t3-cardputer.relay.plist` launchd template next to the systemd unit)
- Test: `relay/test/bundle.test.ts` (new), `relay/test/cli.test.ts`

**Interfaces:**
- Produces:
  - `relay/dist-bundle/t3-cardputer-relay.mjs`: one file with a `#!/usr/bin/env node` shebang, mode 0755, that runs with no `node_modules`.
  - `t3-cardputer-relay --version` prints `t3-cardputer-relay <version>`. The version comes from `package.json`, set by the release workflow.
  - `install-whisper.sh [--gpu none|cuda|metal] [--prefix <dir>]`. The default is `none`, except on macOS arm64, where it's `metal` (whisper.cpp's default there). The script prints the path of the built `whisper-server`.
  - The launchd plist template uses placeholders `__NODE__`, `__BUNDLE__`, `__LOG_DIR__`.

- [ ] **Step 1: Write a failing `bundle.test.ts`.** Run `pnpm bundle`, copy the output to an empty temp dir, run `node t3-cardputer-relay.mjs --version` there. Expected: exit 0 and the version line. `--help` lists every command.
- [ ] **Step 2:** Run `cd relay && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement `bundle.mjs`** (esbuild, platform node, format esm, target node22, banner shebang) and `--version`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: `install-whisper.sh`.**
  - Add `--gpu`.
  - On macOS, use Homebrew cmake when present, else the existing uv fallback.
  - `cuda` requires `nvcc` on PATH, else it stops with `--gpu cuda needs the CUDA toolkit (nvcc not found)`.
  - Never sudo.
  - Verify on the homelab with `--gpu none` into a temp `--prefix`. Expected: it builds, and `whisper-server --help` exits 0.
- [ ] **Step 6: Commit** `build(relay): single-file bundle, --version, whisper on macos and gpu`

### Task 6: Relay features strangers need

**Files:**
- Create: `relay/src/install-link.ts`, `relay/src/t3/token-expiry.ts`
- Modify: `relay/src/config.ts`, `relay/src/cli.ts`, `relay/src/session.ts`, `relay/src/serve.ts`, `relay/src/canary.ts` call sites, `relay/relay.example.json`, `docs/protocol.md` (only if a frame changes, it shouldn't)
- Test: `relay/test/install-link.test.ts`, `relay/test/token-expiry.test.ts` (new), `relay/test/cli.test.ts`, `relay/test/config.test.ts`, `relay/test/session.test.ts`

**Interfaces:**
- Produces:
  - Config:
    - `publicUrl?: string`, the https URL devices reach. It must be `https://host[:port]`.
    - `canary: { enabled: boolean; model: string; providerInstanceId?: string }`, default `{ enabled: false, model: "claude-haiku-5-5" }`. `enabled: false` means version changes never launch a canary.
  - `installLink(publicUrl: string, code: string): string` → the Global Constraints format. `INSTALL_SITE = "https://t3-cardputer.jopcmelo.com"`.
  - CLI:
    - `install-link` creates a pairing code via the admin socket and prints the link plus `code expires in 10 min`. It errors with `install-link needs publicUrl in relay.json (setup.sh sets it)`.
    - `pair-t3 --stdin` reads `{"mcp":string,"internal":string}` from stdin, and the `--mcp/--internal` flags keep working.
    - `renew`: if `t3` is on PATH, it runs `t3 auth pairing create --json --ttl 5m --label t3-cardputer-relay` twice and pairs both, without printing codes. Otherwise it prints the two commands to run in T3 and `then: t3-cardputer-relay pair-t3 --stdin`.
    - `update`: if `repair.projectId` is set, it refuses with `this relay updates itself from main (self-repair), update skipped`. Otherwise it downloads `https://t3-cardputer.jopcmelo.com/setup.sh` and execs `sh <file> --update`.
    - `models --json`: prints `[{"id","label","providerInstanceId"}]` from the same usable-model catalog `projects.models` uses (empty constraints only). `setup.sh` picks the canary model from it.
    - `serve` prints `relay ready on 127.0.0.1:<port>` once it's listening, and `GET /healthz` on the relay port returns `200 ok`. Both are new and are what `setup.sh` waits on.
  - `tokenExpiryWarnings(secrets: Secrets, now: Date): string[]` → `T3 tokens expire in <n> days: run t3-cardputer-relay renew` when the nearer of the two expires within `T3_TOKEN_WARN_DAYS = 5` days, and `T3 tokens expired: run t3-cardputer-relay renew` after. Receipt: tokens last 30 days (`docs/setup.md` §3), and 5 days spans a weekend plus a work week.
  - The approvals-down home reason gets `; update: t3-cardputer-relay update` when repair isn't configured, inside the existing `clipText` budget.

- [ ] **Step 1: Write failing tests.**
  - `installLink("https://relay.example.com:8443","K7Q2AB9X")` → `https://t3-cardputer.jopcmelo.com/install#r=https%3A%2F%2Frelay.example.com%3A8443&c=K7Q2AB9X`.
  - Token expiry at 6, 5, 0 and -1 days.
  - The config defaults, and a strict-schema rejection of `canary.enabled: "yes"`.
  - `pair-t3 --stdin` stores both tokens, with no token in stdout or stderr.
  - `models --json` with a fake catalog returns only usable models.
  - `GET /healthz` returns 200 `ok`.
  - `update` refuses on a repair config.
  - A session home with repair off and approvals broken has a reason ending in the update hint. With repair on, the reason is unchanged.
  - Version change with `canary.enabled=false` → `runCanary` is never called.
- [ ] **Step 2:** Run `cd relay && pnpm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Merge `tokenExpiryWarnings` into the home `warnings` in `session.ts` where the snapshot warnings are assembled. When `canary.providerInstanceId` is set, pass it to `runCanary` as the launch's `providerInstanceId`.
- [ ] **Step 4:** Run `pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(relay): install links, token expiry warnings, renew, update, opt-in canary`

### Task 7: Install site

**Files:**
- Create: `site/package.json` (esptool-js pinned; `test` = `node --test test/`), `site/vercel.json` (static, `outputDirectory: "public"`, `cleanUrls: true`, security headers incl. `Referrer-Policy: no-referrer`), `site/public/index.html`, `site/public/install.html`, `site/public/install.js`, `site/public/lib/fragment.js`, `site/public/lib/serial-frames.js`, `site/public/lib/flash-plan.js`, `site/public/vendor/esptool-js/` (copied from the pinned package by `site/scripts/vendor.mjs`), `site/public/styles.css`
- Test: `site/test/fragment.test.mjs`, `site/test/serial-frames.test.mjs`, `site/test/flash-plan.test.mjs`, `site/test/browser-support.test.mjs`

**Interfaces:**
- Consumes: Task 2 wire format, Task 4 `manifest.json`, served at `/fw/latest/manifest.json` and `/fw/<version>/…` (Task 9 puts them there).
- Produces:
  - `parseFragment(hash: string) -> {relay?: string, code?: string, error?: string}`. It rejects a non-https relay and a code that isn't 8 `[A-Z0-9]` chars, with named errors.
  - `encodeProvision({wifi?, relay?, code?}) -> Uint8Array`: `\x02T3PROV ` + JSON + `\n`, with UTF-8 SSIDs kept.
  - `parseDeviceLine(line) -> {kind:"prov-ok"} | {kind:"prov-err", reason} | {kind:"info", info} | {kind:"other"}`.
  - `flashPlan(manifest, {clean: boolean}) -> {eraseAll: boolean, writes: [{offset, path}]}`. It never writes inside `manifest.nvs`.
  - `browserSupport(navigatorLike) -> {ok: true} | {ok: false, message: "Installing needs Chrome or Edge on a computer (Web Serial). Safari, Firefox and phones can't talk to USB devices."}`

Page flow (`install.html`), as approved on the mockup:
1. Show the relay host and "pairing code filled in" from the fragment. With no fragment, show "Run setup.sh on your T3 machine first" and the command. Never send the fragment anywhere, and replace it out of the address bar with `history.replaceState`.
2. Warn: "This replaces everything on the ADV, Launcher included."
3. Clean install checkbox, off by default.
4. Click **Connect ADV and install**. Then `T3INFO` first: if the device already answers, say "keeps your settings". Flash per `flashPlan` with progress, verify each part's sha256, reset.
5. Collect WiFi (SSID, password, "open network" checkbox), reopen the port at 115200, send `T3PROV` with wifi, relay and code, and show `ok` or the device's `err` reason verbatim.
6. Show "Your ADV is restarting. It joins WiFi and pairs by itself." with a link to troubleshooting.

Every failure names itself and the next step: port picker cancelled, port busy, wrong chip, sha mismatch, no reply within `kProvisionReplyMs`.

- [ ] **Step 1: Write failing tests** for the four pure modules.
  - Each Review Focus 2 and 4 case.
  - A fragment with `%2F` escapes.
  - The manifest plan: clean → `eraseAll: true`; update → three writes, none in 36864..61439.
- [ ] **Step 2:** Run `cd site && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules and the page. `kProvisionReplyMs` gets a receipt: the device replies before restart, and its restart is within 500 ms (Task 2). Measure the reply time with `provision.py` on the ADV (10 runs) and set it to 5× the slowest, with the receipt.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Run the leak grep over `site/`: 0 hits.
- [ ] **Step 5: Local smoke.** Serve `site/public` with the Task 4 parts copied into `public/fw/dev/`, and render `install.html` through the `html_preview` tool. Expected: the unsupported-browser path renders in a non-Chromium user agent, and the supported path shows the steps. The real flash happens at Checkpoint D.
- [ ] **Step 6: Commit** `feat(site): usb install page that flashes and provisions the adv`

### Task 8: `setup.sh`

**Files:**
- Create: `site/public/setup.sh`, `site/test/setup/run.sh` (harness), `site/test/setup/stubs/` (fake `node`, `t3`, `tailscale`, `systemctl`, `launchctl`, `uname`, `curl`, `nvidia-smi`)
- Modify: `.github/workflows/ci.yml` (run shellcheck on `setup.sh`, then the harness)

**Interfaces:**
- Consumes:
  - the Task 6 commands `models --json` and `/healthz`;
  - the Task 5 bundle and `install-whisper.sh`, plus the launchd/systemd templates, from `https://github.com/joaopcm/t3-cardputer/releases/download/v__VERSION__/…`;
  - Task 6's CLI (`pair-t3 --stdin`, `pair`, `install-link`, `--version`);
  - the config keys `publicUrl` and `canary`.
- Produces: `sh setup.sh [--update] [--yes] [--dry-run]`. `__VERSION__` is replaced at release (Task 9). Files it writes:
  - `~/.local/share/t3-cardputer/releases/<v>/`, with symlink `current`;
  - `~/.local/bin/t3-cardputer-relay` → `current/t3-cardputer-relay.mjs`;
  - `~/.config/t3-cardputer/{relay.json,secrets.json}` (0600);
  - the service unit: systemd user on Linux, launchd agent on macOS.

Steps the script runs, in order. Each prints `✓ <thing>` or `✗ <thing>: <why>. next: <command>`; the first ✗ ends the run with exit 1, and `--dry-run` prints the plan only.
1. **Platform.** Linux or macOS. Windows/WSL-less → `✗ Windows isn't supported yet`. No root: refuse to run as root.
2. **Refuse a homelab checkout.** If `~/.config/t3-cardputer/relay.json` has `repair.projectId`: `✗ this machine runs a self-repairing checkout, setup.sh leaves it alone`.
3. **Prerequisites.** Node ≥ 22 (`next: install Node 22, https://nodejs.org`), Tailscale CLI logged in, T3 reachable at the configured `t3BaseUrl` (default `http://127.0.0.1:3773`).
4. **Relay.** Download the bundle and `SHA256SUMS`, verify, install, link.
5. **Voice.** Ask for the GPU build only when `nvidia-smi` (Linux) or arm64 macOS is detected. `--yes` takes the default (CPU on Linux, Metal on arm64 macOS). Run `install-whisper.sh`.
6. **T3 pairing.** If `secrets.json` already has unexpired tokens, skip it. Else if `t3` is on PATH, run it twice and feed `pair-t3 --stdin`. Else print the two commands and read the two codes from the tty without echo.
7. **Canary consent.** "On each T3 update the relay runs one short agent turn to check approvals still work. It uses your usage. Enable? [y/N]". If yes, pick a model from `t3-cardputer-relay models --json`: the first whose id contains `haiku`, `mini` or `flash`, else ask. Write `canary` with `enabled`, `model` and `providerInstanceId`.
8. **Funnel.** Ask, then run `tailscale funnel --bg --https=8443 <port>`. Read the https URL from `tailscale funnel status --json`, write `publicUrl`, and never print the tailnet name more than once in the final link.
9. **Service.** Install, start, and poll `http://127.0.0.1:<port>/healthz` until it returns 200. Measure first: time from `systemctl --user start` to `relay ready` on the homelab, 10 runs. The timeout is 5× the slowest run, with that receipt in the script's why line.
10. **Link.** Run `t3-cardputer-relay install-link` and print it as the last line with "plug in your ADV and open this in Chrome or Edge". On a laptop, also print "this machine must be awake for the ADV to reach your agents".

- [ ] **Step 1: Write the failing harness `site/test/setup/run.sh`.** It runs setup.sh with `HOME` set to a temp dir and the stubs on PATH. Cases:
  - a fresh Linux run;
  - a fresh macOS run (launchd);
  - a re-run that keeps the existing `secrets.json` and `relay.json` bytes;
  - a repair-enabled `relay.json`, which refuses and exits 1;
  - running as root, which refuses;
  - Node 20, which gives the named error;
  - `t3` missing, which takes the paste path from a fake tty;
  - `--dry-run`, which writes nothing.

  Assert the output lines, the file modes (0600) and the final link format.
- [ ] **Step 2:** Run `sh site/test/setup/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement `setup.sh`** in POSIX sh. `shellcheck -s sh` must be clean.
- [ ] **Step 4:** Run `sh site/test/setup/run.sh` and `shellcheck -s sh site/public/setup.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(site): guided setup.sh for the t3 machine`

### Task 9: Releases and site deploy

**Files:**
- Create: `.github/workflows/release.yml` (`workflow_call` + `push: tags: ['v*']`), `.github/workflows/auto-release.yml`
- Modify: `.github/workflows/ci.yml` (add `site` job: `npm test`, leak grep incl. `site/`), `docs/development.md` stub line pointing at the release process (Task 10 writes it fully)

**Interfaces:**
- Consumes: Task 4 web parts and manifest, Task 5 bundle, Task 7 site, Task 8 `setup.sh`.
- Produces:
  - GitHub Release `v<x.y.z>` with these assets: `t3-cardputer-relay.mjs`, `install-whisper.sh`, `t3-cardputer-relay.service`, `com.t3-cardputer.relay.plist`, `SHA256SUMS`, and the firmware `bootloader.bin`, `partition-table.bin`, `t3-cardputer.bin`, `manifest.json`.
  - A Vercel production deploy of `site/public` with `fw/<v>/` and `fw/latest/` filled from the release, and `setup.sh` with `__VERSION__` replaced.
- Secrets João adds in GitHub: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

- [ ] **Step 1: `release.yml` jobs.**
  - `relay`: pnpm, set the version from the tag, `bundle`.
  - `firmware`: `espressif/idf:v5.4.2` container, `firmware/scripts/release.sh`, with no `local.cmake`. The leak grep runs inside the job.
  - `publish`: `gh release create`, plus `SHA256SUMS`.
  - `site`: assemble `public/fw`, substitute the version, `vercel deploy --prebuilt --prod`.
- [ ] **Step 2: `auto-release.yml`.**
  - On push to `main` touching `relay/**`, `firmware/**` or `site/**`, compute the next patch from the latest `v*` tag, tag it, and call `release.yml`.
  - A reusable call is needed because tags pushed with `GITHUB_TOKEN` don't trigger workflows.
  - Skip when the head commit is itself a release tag.
- [ ] **Step 3: Validate.**
  - `actionlint` on all workflows is clean.
  - A dry run with `workflow_dispatch` (`dry_run: true`) on the PR branch builds everything and uploads the artifacts to the run, without publishing.
  - Expected: the run is green and the artifacts list matches the asset list above.
- [ ] **Step 4: Commit** `ci: releases with relay bundle and firmware parts, site deploy, auto patch releases`

### Task 10: Docs

**Files:**
- Rewrite: `README.md`
- Create: `docs/install.md` (from `docs/setup.md`: script walkthrough plus the manual path), `docs/using.md`, `docs/troubleshooting.md`, `docs/security.md`, `docs/development.md`
- Delete: `docs/setup.md`. Leave a one-line pointer to `docs/install.md` only if something links to it (check `git grep setup.md`).
- Test: `relay/test/docs-troubleshooting.test.ts` (new)

**Interfaces:**
- Consumes: the image paths from Task 11 (`docs/images/home.png`, `approval.png`, `thread.png`, `voice.png`, `new-task.png`, `hero.png`). Use those names; Task 11 produces them.

Content (spec Goal 4):
- README order: hero, one line, 3-step quickstart (exact `curl -fsSL https://t3-cardputer.jopcmelo.com/setup.sh | sh`, open the printed link, plug in and click install), screenshot strip, requirements, a "how it works" mermaid diagram, key cheat sheet, links.
- `troubleshooting.md` is a table: `| On screen | What it means | Fix |`. Its first column is the exact device text prefix.
- `security.md` says what's stored where, what Funnel exposes, the pairing lockout, the canary's usage cost, and that USB provisioning is write-only.

- [ ] **Step 1: Write the failing docs test.** For every first-column entry in `docs/troubleshooting.md`, assert the literal prefix appears in `firmware/components/**` or `relay/src/**`. Also assert every relative link in `README.md` and `docs/*.md` resolves to a file.
- [ ] **Step 2:** Run `cd relay && pnpm test docs-troubleshooting`. Expected: FAIL (no docs yet).
- [ ] **Step 3: Write the docs.**
  - Write in sentence case and João's voice (write-like-joao rules, except casing), then run the humanizer pass.
  - Cover the error strings users can hit: every `inform(... Color::Red/Warn)` text and every home warning.
- [ ] **Step 4:** Run `pnpm test docs-troubleshooting` and the leak grep. Expected: PASS, 0 hits.
- [ ] **Step 5: Commit** `docs: readme and guides for installing, using and fixing the adv app`

### Task 11: Clean screenshots from staged data

**Files:**
- Modify: `firmware/main/debug_serial.cpp` (debug-only `\x02FRAME <json>`: feeds one relay frame into `App::onFrame(json, nowMs)` exactly as the transport would, only while the link is stopped via `NETDOWN`)
- Create: `firmware/scripts/stage-screens.py`, `docs/images/fixtures/*.json` (home, approval request, thread page, voice transcript, projects for new task; neutral names: `demo-api`, `landing-page`, `migrate-db`; no real data), `docs/images/*.png`

**Interfaces:**
- Consumes: `firmware/scripts/screenshot.py` (SHOT decode), and the fixture frames in the protocol v1 shapes from `docs/protocol.md`.
- Produces the PNG names Task 10 links.

- [ ] **Step 1:** Each fixture parses with the host `parseRelay`. Add `doc_examples_test.cpp`-style coverage: `docs/images/fixtures/*.json` all parse.
- [ ] **Step 2:** Run `firmware/scripts/test-host.sh`. Expected: PASS once the fixtures are valid.
- [ ] **Step 3: Device capture, controller-run, debug build.**
  - Run `stage-screens.py`: `NETDOWN`, feed each fixture, `KEY` into the right screen, `SHOT`. The voice screen needs a hold.
  - Expected: 5 PNGs at the device's 240×135, scaled 3× like the existing shots.
  - The hero frames `home.png` in a simple drawn device outline.
  - Restore the release app afterwards with `flash-app.sh`.
- [ ] **Step 4:** Review every PNG by eye for real SSIDs or thread titles. Expected: none.
- [ ] **Step 5: Commit** `docs(images): staged device screenshots for the readme`

### Task 12: Rollout (Checkpoint D, needs João)

No code. Ordered steps; each is an outward action, so each one waits for João.

1. **João:**
   - In Cloudflare, add `CNAME t3-cardputer → cname.vercel-dns.com` (DNS only).
   - In Vercel, create a project for `site/` and add the domain `t3-cardputer.jopcmelo.com`.
   - In GitHub, add the `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` secrets.
2. Open the PR for `feat/distribution`, babysit it, and merge when green. `auto-release` cuts `v0.1.0` and deploys the site. Check that `https://t3-cardputer.jopcmelo.com/setup.sh` serves the pinned version and `/fw/latest/manifest.json` matches the release.
3. **Homelab relay:**
   - Add `canary.enabled: true` and `publicUrl` to João's `relay.json`, so his canary keeps running.
   - Pull the deploy clone, build, restart, run `t3-cardputer-relay canary`. Expected: exit 0.
4. **Migrate João's ADV to the public image.** Run `t3-cardputer-relay install-link` on the homelab. João opens it in Chrome on his laptop with the ADV plugged into the laptop, and leaves clean install off. Expected:
   - `T3INFO` reports `paired: true`;
   - the update keeps the token, because the relay URL goes from empty to set;
   - Home comes up with no re-pair.
5. **Stranger dry run:** `setup.sh --dry-run` on the homelab (it must refuse the self-repair checkout by name), then a run in a temp `HOME` with `--dry-run`, then the Task 8 harness. There's no second T3 machine.

---

## Resolved questions

1. No second T3 machine (João). Checkpoint D's stranger run is `setup.sh --dry-run` on the homelab plus the Task 8 stubbed harness in CI, which covers fresh Linux, fresh macOS, re-run, refusal and paste paths.
2. Automatic patch releases on every relay, firmware or site change to `main` (João).
