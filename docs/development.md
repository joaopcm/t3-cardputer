# Development

```
relay/      Node 22 + TypeScript relay, the t3-cardputer-relay CLI
firmware/   ESP-IDF v5.4.2 app for the ADV
  components/t3core/   screens, protocol, link logic; builds on the host too
  main/                hardware: display, keyboard, mic, WiFi, transport, USB serial
site/       static install site and setup.sh, deployed to t3-cardputer.jopcmelo.com
docs/       these docs, protocol.md, receipts/
```

## Relay

```
cd relay
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm bundle
```

`build` writes `dist/cli.js`, which a git checkout runs. `bundle` writes `dist-bundle/t3-cardputer-relay.mjs`, the single file a release ships.

To run a second relay next to a real one, point it at other files with `T3_CARDPUTER_RELAY_CONFIG` and `T3_CARDPUTER_RELAY_SECRETS`, and give it another `port` and `stateDir` in that config.

## Simulator

`t3-cardputer-relay sim` drives a relay as a fake ADV, over the same protocol. Pair it once with a code from `t3-cardputer-relay pair`, then run it:

```
t3-cardputer-relay sim pair https://<machine>.<tailnet>.ts.net:8443 <code>
t3-cardputer-relay sim --wav ~/.local/share/t3-cardputer/whisper/samples/jfk.wav
```

`pair` saves its own token to `~/.config/t3-cardputer/sim.json`. `sim` shows Home and streams the wav for transcription. `jfk.wav` comes with the whisper.cpp clone. `relay/test/e2e.test.ts` runs the same simulator against a relay with a fake T3.

## Firmware

```
firmware/scripts/setup-idf.sh
firmware/scripts/test-host.sh
firmware/scripts/build.sh
firmware/scripts/flash.sh
firmware/scripts/monitor.sh 10
```

- `setup-idf.sh` clones ESP-IDF v5.4.2 into `~/esp/esp-idf` (or `$IDF_PATH`) and installs the esp32s3 tools.
- `test-host.sh` builds and runs the `t3core` tests on your machine, no ADV needed.
- `build.sh` is a debug build in `firmware/build`, with the debug serial channel on.
- `flash.sh` flashes that build. `PORT` defaults to `/dev/ttyACM0`. It keeps NVS (WiFi, token, relay URL).
- `monitor.sh 10` prints 10 seconds of the serial log.

Release builds:

```
T3_VERSION=0.0.0-dev firmware/scripts/release.sh
firmware/scripts/flash-app.sh
```

`release.sh` builds into `firmware/build-release` with `sdkconfig.release` on top of the defaults, and refuses to finish if `CONFIG_T3_DEBUG_SERIAL` or `CONFIG_T3_KEYBOARD_TRACE` is on. `T3_VERSION` becomes the app version that `hello` and `T3INFO` report, and falls back to `git describe`. It's at most 31 characters, because `esp_app_desc_t.version` is `char[32]`. The script also writes the install page's parts to `build-release/web` and fails if any shipped file has a relay URL, tailnet name or Tailscale IP in it. `flash-app.sh` writes only the app, so NVS stays.

Set the ADV up over USB without the install page:

```
firmware/scripts/provision.py frame.json
```

`frame.json` is mode 0600 and looks like `{"wifi": {"ssid": "...", "password": "..."}, "relay": "https://<machine>.<tailnet>.ts.net:8443", "code": "<code>"}`. Every key is optional. The frames are in [protocol.md](protocol.md#usb-provisioning).

When you open the port yourself, lower RTS before DTR. The chip resets on DTR=0 with RTS=1. The scripts already do this.

## Debug serial channel

Debug builds (`CONFIG_T3_DEBUG_SERIAL`, on by default, off in releases) answer commands on the USB port. A command is `\x02<command>\n` and every answer is `\x02<answer>\x03`.

| Command | Does |
| --- | --- |
| `SHOT` | Dumps the screen. `firmware/scripts/screenshot.py out.png` turns it into a PNG. |
| `KEY <name>` | Presses a key, like `enter`, `char:a` or `fn+s`. `screenshot.py --key` sends one before the shot. |
| `HEAP` | Free internal heap and the largest block. |
| `POWER <dim_ms> <off_ms>` | Changes the dim and screen-off timeouts. |
| `DROP` | Drops the relay socket, the link reconnects. |
| `WIFIOFF` | Leaves the WiFi network. |
| `NETDOWN`, `NETUP` | Black-holes the network and brings it back, without leaving WiFi. |
| `STAGE` | Cuts the relay link so the screen takes `FRAME`s instead. It lasts until reset. |
| `FRAME <json>` | Hands the app one relay frame, as if the relay sent it. Needs `STAGE` first. |

`SHOT` sends what's on screen over USB, which is why release builds have the channel off. The screenshots in `docs/images` come from `firmware/scripts/stage-screens.py`, which stages the frames in `docs/images/fixtures` with `STAGE` and `FRAME` and shoots each screen. Reset the ADV when it's done.

## Site

```
cd site
npm test
sh test/setup/run.sh
shellcheck -s sh public/setup.sh
```

`npm test` covers the install page's logic in `public/lib`. `test/setup/run.sh` runs `setup.sh` against stubbed `node`, `t3`, `tailscale`, `systemctl` and friends, for Linux and macOS.

To try the install page with your own firmware, copy a release build's parts in and serve `site/public`. Web Serial works on `localhost` without https.

```
V=$(node -p 'require("./firmware/build-release/web/manifest.json").version')
mkdir -p "site/public/fw/latest" "site/public/fw/$V"
cp firmware/build-release/web/* site/public/fw/latest/
cp firmware/build-release/web/* "site/public/fw/$V/"
python3 -m http.server -d site/public 8000
```

Then open `http://localhost:8000/install.html` with an install link's `#r=…&c=…` on the end. `site/public/fw/` is ignored by git.

## Receipts

Every limit, timeout and size has a measurement behind it. `docs/receipts/` holds the measurements, and the number in code carries a `// receipt:` line that says where it came from. A limit someone can hit fails loudly with the budget, the limit and the ask: `reply_text_max=4000, reply needed 4012`. If normal use hits one, the limit is wrong. Measure again, then update the receipt and the number together.

## Checks

CI (`.github/workflows/ci.yml`) runs the relay's typecheck, tests and build, the `setup.sh` harness with shellcheck, the site tests, and the leak grep:

```
.github/scripts/leak-grep.sh .
```

It has to print nothing. Use placeholders like `<machine>.<tailnet>.ts.net` for hosts in docs, never a real one.

`relay/test/docs-troubleshooting.test.ts` checks that every first-column entry in `docs/troubleshooting.md` is text the firmware, relay or site really prints, and that every relative link in `README.md` and `docs/*.md` points at a file. Change an on-screen message and the test tells you which row to update.

## Releases

A push to `main` that touches `relay/`, `firmware/` or `site/` runs `.github/workflows/auto-release.yml`. It runs CI first, works out the next patch version and calls `.github/workflows/release.yml`, which:

1. builds the relay bundle with that version,
2. builds the firmware in the `espressif/idf:v5.4.2` container with `T3_VERSION` set to it,
3. publishes the GitHub release with the bundle, `install-whisper.sh`, the service files, the firmware parts and `SHA256SUMS`, creating the `v<x.y.z>` tag as it publishes,
4. deploys the site to Vercel with the firmware under `fw/<x.y.z>/` and `fw/latest/`, and `setup.sh` pinned to that version.

A failed run leaves no tag, so the next run takes the same number. Pushing a `v<x.y.z>` tag by hand does the same as the auto release. To build everything without publishing, run the release workflow from the Actions tab with `dry_run` on.

Only the release workflow deploys the site: Vercel's Git deploys are off in `site/vercel.json`. Publishing needs the `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` repository secrets, which only I have. Contributors never need them.
