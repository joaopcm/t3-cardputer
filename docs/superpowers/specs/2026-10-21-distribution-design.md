# T3 Cardputer distribution and docs: design (plan 3)

Date: 2026-10-21
Status: draft, pending approval
Builds on: `docs/superpowers/specs/2026-10-20-t3-cardputer-design.md` (main spec), `docs/superpowers/specs/2026-10-20-firmware-design.md` (plan 2), `docs/protocol.md` (wire contract).

## Intent

Today the app works for exactly one person. The relay URL is compiled into the firmware, the relay setup is 10 manual sections in `docs/setup.md`, and the README describes João's homelab. This plan makes it installable by any developer who uses T3 Code and owns a Cardputer ADV, with the best developer experience we can give them.

Who it's for (João): developers using T3 Code who want to work with their agents from their ADV while away from the desk. They already run T3 on a laptop or an always-on server.

## The journey (approved with João on a mockup)

```
1. T3 machine     $ curl -fsSL https://t3-cardputer.jopcmelo.com/setup.sh | sh
                  guided: checks, installs the relay, voice, T3 pairing, Funnel, service
                  ends by printing  https://t3-cardputer.jopcmelo.com/install#r=<relay url>&c=<pairing code>

2. Browser        Chrome/Edge opens that link, the ADV is plugged in over USB
                  one button flashes the firmware, then asks for the WiFi the ADV should join
                  relay URL, pairing code and WiFi go to the device over USB, never to the site

3. ADV            reboots, joins WiFi, pairs by itself, lands on Home. no typing on the device
```

## Goals

1. **One guided setup script for the T3 machine** (João: "just run a script that guides them through the setup process, be it a laptop or an always-on server"). It:
   - checks prerequisites and says exactly what's missing and how to get it (T3 Code, Node 22, Tailscale, git or whatever the install method needs);
   - installs the relay and whisper. CPU build by default; offers a GPU build when it finds one (CUDA on Linux, Metal on macOS);
   - pairs the relay with T3 by creating the two pairing codes itself when the `t3` CLI is available, so the user never copies credentials;
   - turns on Tailscale Funnel on 8443 (never 443: on 443 it takes over the tailnet address, see `docs/setup.md` §8), after asking;
   - installs and starts the service: systemd user unit on Linux, launchd agent on macOS;
   - creates a device pairing code and prints the install link;
   - is safe to re-run: re-running repairs or updates an existing install instead of clobbering it.
2. **A static install website at `t3-cardputer.jopcmelo.com`** (João: "a website that installs it via USB", domain from João). One page, Web Serial (Chrome/Edge desktop). It flashes the public firmware, provisions WiFi, relay URL and pairing code, and shows progress and named failures. Reinstalling or updating must keep the device's settings unless the user asks for a clean install.
3. **One public firmware image for everyone.** The relay URL stops being a build-time constant and becomes a device setting (NVS), provisioned by the install page or typed in on-device Setup as a fallback. Release images are built in CI from a tag and published (GitHub Releases), so they no longer embed anyone's relay URL and the "keep release .bin local" rule goes away for public builds.
4. **Docs with a good developer experience** (João: "I just want to provide a good developer experience"; structure below is my call, approved by João):
   - `README.md`: a clean photo-style shot of Home on the ADV, one line on what it is, a 3-step quickstart, a strip of screenshots (Home, approval, thread, voice, new task), requirements (Cardputer ADV, T3 Code, Tailscale, Chrome or Edge), a small "how it works" diagram, a key cheat sheet, links.
   - `docs/install.md`: what the script does step by step, and a manual path for people who won't pipe a script into a shell (today's `docs/setup.md` becomes this).
   - `docs/using.md`: screens and keys.
   - `docs/troubleshooting.md`: keyed by the exact text the device shows (`relay unreachable: …`, `tls_heap=60398, …`, `re-pair needed`, …). Every failure already names itself, so this is a lookup table from on-screen text to fix.
   - `docs/security.md`: where tokens, WiFi and the relay URL live, what Funnel exposes, the pairing lockout.
   - `docs/development.md`: building firmware and relay, the simulator, the receipts, the debug serial channel.
   - `docs/protocol.md` stays.
5. **Clean screenshots**, reshot on the real ADV with staged data: a demo project with neutral thread names, no real WiFi names, no real thread titles. Stored in `docs/images/`.

## Non-goals

- Windows as a relay host in v1 (my call). The script detects it and says so.
- Hosting a relay for people, or any account system. Everyone runs their own relay next to their own T3.
- Keeping a sleeping laptop reachable. A laptop that sleeps takes the relay with it; the ADV shows "relay unreachable" until it wakes. The docs say this plainly.
- Alternatives to Tailscale Funnel for the public edge in v1 (my call). Tailscale is a stated requirement.
- Coexisting with Launcher (João: "let's keep it simple, let's have only the flash flow for now"). The page flashes the full image, which replaces whatever is on the ADV, Launcher included; the page warns before it does. No app-only image for Launcher, no provision-only mode. `release.sh`'s Launcher slot check can stay for local builds.
- Launcher / M5Burner catalog listings in v1 (follows from the above).
- Distributing the relay through the npm registry (my call: GitHub Releases or a tagged git checkout keep everything in one place with no extra account; the builder picks between those two).
- Self-repair for other people's relays. Repair opens PRs against João's repo with João's GitHub token; for everyone else it stays off, which the relay already handles (no `repair.projectId` → repair refuses to start and says so).

## Anti-goals

- **A setup that dies with a stack trace or silently.** Every check that fails names what's missing and the next command to run. Same rule as the device: an agent reading the output can fix it.
- **Secrets leaving the user's machines.** The install link's `#…` fragment never reaches the website server. The page talks only to the device over USB. The setup script never sends tokens anywhere but T3 and the local config files (0600). No telemetry.
- **The install page exposing session data.** The release firmware's debug serial channel stays off (`SHOT` would dump session text). Provisioning over USB is write-only: it can set WiFi, relay URL and pairing code, it can never read back tokens, WiFi passwords or anything on screen.
- **Updates that wipe a working device.** Reflashing to update keeps NVS (WiFi, token, relay URL) by default.
- **João-specific values in public artifacts.** No relay URL, tailnet name or Tailscale IP in the repo, the site, or the published images. The repo's leak grep keeps running in CI and extends to the site.
- **Unmeasured limits.** Every new timeout and size (setup script steps, flashing, provisioning) follows the receipts rule; failures read `<budget>=<limit>, <what> needed <n>`.

## Constraints

- **Hardware and firmware:** see plan 2. ESP32-S3, no PSRAM, 8 MB flash, our partition table (nvs 24K, factory 3M). NVS headroom is measured in `docs/receipts/2026-10-21-nvs-settings.md`. The relay URL setting must fit there with a receipt.
- **Protocol:** stays v1, additive only, frozen handshake untouched. Firmware and relay from different releases must keep talking within v1.
- **Web Serial** works only in desktop Chromium browsers (Chrome, Edge, Opera). The page detects others (Safari, Firefox, mobile) and says so instead of showing a dead button.
- **T3 tokens expire after 30 days and don't refresh** (`docs/setup.md` §3). Strangers will hit this monthly. The relay must warn ahead of expiry on the device's home screen with the command to fix it, and the script must have a renew path.
- **The `t3` CLI** may not be on PATH on every T3 machine. When it isn't, the script falls back to asking the user to paste the pairing codes, with the exact command to run in T3.
- **No sudo by default.** The script installs user-locally like the current homelab setup. If a step truly needs root (a GPU toolkit, a system package), it says so and stops rather than escalating.
- **João's own setup keeps working.** His homelab relay, Funnel on 8443, his paired ADV and the self-repair path must survive the change. His device moves to the public firmware with its relay URL provisioned, without a re-pair.

## Decided

- Install via a guided script on the T3 machine, laptop or server (João).
- Firmware install via a website over USB at `t3-cardputer.jopcmelo.com` (João).
- Full-image flash flow only, no Launcher support in v1 (João).
- The 3-step journey above, including "no typing on the device" (João, on the mockup).
- Docs structure and screenshot reshoot as listed in Goal 4 and 5 (my call, approved by João).
- Docs are written in normal sentence case (João: "don't write them in lowercase"). The rest of João's voice applies: short, plain verbs, evidence pasted raw, no em dashes, no emoji, then a humanizer pass. Commits and PRs stay lowercase as before.

## My calls (João can override)

- macOS and Linux are both first-class relay hosts; Windows is out for v1.
- GPU whisper is opt-in during setup, CPU is the default. `medium.en` stays the default model on CPU (plan 2 receipt). The builder may pick a smaller default on slow CPUs only with a measurement.
- Firmware releases are built by CI on a version tag and attached to a GitHub Release. The site serves its own copies of the release images (browsers can't rely on CORS for GitHub Release assets), so a release redeploys the site.
- The site is hosted on Vercel, like `jopcmelo.com` (DNS for `jopcmelo.com` is on Cloudflare, the apex on Vercel). It deploys from this repo. Adding the `t3-cardputer` record in Cloudflare and the domain in Vercel are João's steps; the plan lists them.
- The setup script is served from the site (`https://t3-cardputer.jopcmelo.com/setup.sh`) and pins a release version, so `curl | sh` and the manual path install the same thing.
- The install link carries the relay URL and pairing code in the URL fragment. Pairing codes already expire after 10 minutes (`pairingCodeTtlMs`); the page says so and the script can print a fresh link.
- On-device Setup gains a relay URL field as the fallback when there's no link.
- **Approvals-adapter fixes reach other relays through releases, not self-repair.** When a repair (or any relay fix) merges to `main`, CI cuts a release. Other relays never update themselves and never call home (no telemetry). When their approvals adapter breaks, the device's home warning names the fix: the command that updates the relay (`setup.sh` re-run or an `update` subcommand). Self-repair stays João-only.
- **The script leaves João's homelab alone.** It detects a repair-enabled git checkout (a `repair.projectId` in `relay.json`) and refuses to convert it to a release install, saying why. João's relay keeps tracking `main`.
- **The canary is opt-in per relay, with consent.** On a T3 version change it launches a real agent turn, which spends the user's usage. The script asks during setup, explains the cost, and picks a cheap model from the providers that user actually has (today it's hard-coded to `claude-haiku-5-5`, which fails for a Codex-only user). Declined or impossible means no canary: approvals breakage then shows when an answer fails, with the same named fix. `docs/security.md` documents it.

## Left to the builder

- How the relay is packaged in a release (prebuilt tarball vs tagged checkout plus build), and what the script needs on the machine as a result.
- The provisioning channel on the device: Improv Serial (supported by ESP Web Tools) for WiFi plus a small write-only extension for relay URL and pairing code, or an equivalent, within the anti-goals above.
- The web flashing library (ESP Web Tools / esptool-js) and the site's build, as long as it stays static.
- How the docs screenshots are staged (a demo T3 project, the relay simulator, a fake T3), as long as no real data appears.
- Script language and structure, and how it detects GPU, T3 and Tailscale.
- Image framing for the README hero (plain capture vs a drawn device bezel).
