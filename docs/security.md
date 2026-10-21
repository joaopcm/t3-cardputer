# Security

You run every piece yourself: the relay next to your T3, the firmware on your ADV. There's no account, no hosted relay and no telemetry. The only network calls are the ones you start: setup downloading a release and the speech models, the install page loading firmware, `t3-cardputer-relay update`.

## What's stored where

| What | Where | Notes |
| --- | --- | --- |
| T3 MCP token and T3 internal token | `~/.config/t3-cardputer/secrets.json` on the relay's machine | Mode 0600. The relay won't read it if group or others can. Sent only to T3. Never to the ADV. |
| Device tokens | `secrets.json` keeps a SHA-256 of each, the ADV keeps the token | A token is only good on the relay that made it. |
| GitHub token | `secrets.json` | Only for self-repair, which only I run. |
| Relay config, including `publicUrl` | `~/.config/t3-cardputer/relay.json` | Mode 0600. |
| Admin commands (`pair`, `devices`, `revoke`) | Unix socket `~/.local/state/t3-cardputer/admin.sock` | Mode 0600 in a 0700 directory. Never over HTTP. |
| WiFi names and passwords, relay URL, device token, pending pairing code | NVS flash on the ADV | Not encrypted. See [a lost ADV](#a-lost-adv). |
| Voice recordings | Relay memory while transcribing | On disk only with `stt.keepSamples` on (off by default), 0600 files in a 0700 directory. |

Tokens and WiFi passwords never show up in command arguments, logs or the ADV's serial output. `pair-t3 --stdin`, `secrets set github` and setup's paste prompts read them from stdin with echo off.

One exception: `pair-t3 --mcp <code> --internal <code>` takes T3's pairing codes as arguments, so they can show up in `ps` and your shell history. Each code works once and expires after 5 minutes, and the relay stores the tokens it trades them for, not the codes. `pair-t3 --stdin` and setup keep them out of argv.

## What Funnel exposes

Funnel puts `https://<machine>.<tailnet>.ts.net:8443` on the public internet and forwards it to the relay on `127.0.0.1:8787`. The relay only binds loopback. Through Funnel it answers:

- `GET /healthz`, which says `ok`.
- `POST /v1/pair`, which trades a valid pairing code for a device token.
- The WebSocket at `/v1/device`, which does nothing until its first frame carries a valid device token.

Anything else gets a 404. T3 (`127.0.0.1:3773`) and whisper-server (`127.0.0.1:8788`) stay on loopback and aren't exposed.

The hostname isn't secret. Tailscale issues a public TLS certificate for it, and certificates are published in certificate transparency logs (https://tailscale.com/kb/1153/enabling-https). Anyone can learn your machine and tailnet name, so the relay can't count on it being hidden.

## Pairing and the lockout

A pairing code is 8 characters from a 31-character alphabet (31^8 is about 8.5e11 codes). It works once and for 10 minutes (`pairingCodeTtlMs`). Only `t3-cardputer-relay pair` and `install-link` make one, through the admin socket.

The relay counts failed attempts per client address. 20 failures within 10 minutes (`authFailuresPerWindow`, `authWindowMs`) lock that address out for the rest of the window. At 20 guesses per 10 minutes, guessing a live code is hopeless. A valid device token is never locked out.

The relay trusts `X-Forwarded-For` only when the TCP peer is loopback, and takes the last entry. To check that Funnel passes real client addresses, from a network outside your tailnet (a phone hotspot) send 20 wrong codes:

```
for i in $(seq 20); do curl -s -o /dev/null -X POST https://<machine>.<tailnet>.ts.net:8443/v1/pair -d '{"code":"WRONGCODE","name":"probe"}'; done
```

Then run `t3-cardputer-relay devices` on the relay's machine. The `lockout:` line names the source. A real address means Funnel forwards it. `127.0.0.1` means every stranger shares one bucket, which still locks them out but can lock out your own pairing too.

## The install link

The link looks like `https://t3-cardputer.jopcmelo.com/install#r=<relay url>&c=<pairing code>`. Browsers don't send the part after `#` to the server, so the site never sees your relay URL or the code.

The page reads the fragment, then `history.replaceState` removes it from the address bar. Your browser history may still have the full link. The code in it works once and for 10 minutes, so an old link from history can't pair anything.

The site's `Content-Security-Policy` allows `connect-src 'self'` only: the page can fetch its own files and firmware and nothing else. WiFi, relay URL and pairing code go from the page to the ADV over USB.

## USB provisioning is write-only

The install page sets WiFi, the relay URL and the pairing code over the ADV's USB serial port. The channel is write-only. It can set those three, and it can ask what's set (`T3INFO`: firmware version, protocol, whether a relay URL and a token are saved, how many networks are saved). It can never return a token, a WiFi password or what's on screen. The frames are in [protocol.md](protocol.md#usb-provisioning).

Release images are built with the debug serial channel (`CONFIG_T3_DEBUG_SERIAL`) and the keyboard trace (`CONFIG_T3_KEYBOARD_TRACE`) off. The debug channel can dump the screen, so `firmware/scripts/release.sh` refuses to build a release with either on.

Setting a relay URL different from the stored one wipes the device token, and the ADV says so on screen. The token belongs to the old relay.

## The canary spends your T3 usage

The canary is off unless you turn it on (setup asks, default no). With it on, each time T3's version changes the relay launches one real agent turn as a scratch thread: it asks the model to run `touch t3-cardputer-canary.txt` and answers the approval that comes up, to prove approvals still work. Then it archives the thread. That turn runs on your T3 account with the model you picked.

One run took 5.6 to 6.4 seconds on `claude-haiku-5-5` (`docs/receipts/2026-10-20-canary.md`). When a run can't reach a verdict (T3 down, a revoked token), retries back off up to one hour (`canaryRetryMaxMs`), so a failure that never clears costs at most 24 turns a day after the first few.

With the canary off, a broken approvals path shows up when an answer fails, as `approvals down` on Home with the command to update.

## A lost ADV

The ADV's flash isn't encrypted. Anyone holding it with a USB cable can read the WiFi passwords and the device token with standard ESP32 tools. If you lose it:

```
t3-cardputer-relay devices
t3-cardputer-relay revoke <deviceId>
```

A revoked token stops working on the next connection, and a connected ADV is dropped right away. Change the WiFi passwords that were saved on it if they matter.
