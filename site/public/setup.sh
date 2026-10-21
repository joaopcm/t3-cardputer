#!/bin/sh
set -eu

VERSION="__VERSION__"
RELEASE_URL="https://github.com/joaopcm/t3-cardputer/releases/download/v$VERSION"
SETUP_CMD="curl -fsSL https://t3-cardputer.jopcmelo.com/setup.sh | sh"
SHARE="$HOME/.local/share/t3-cardputer"
CONFIG_DIR="$HOME/.config/t3-cardputer"
RELAY_JSON="$CONFIG_DIR/relay.json"
SECRETS_JSON="$CONFIG_DIR/secrets.json"
BIN="$HOME/.local/bin/t3-cardputer-relay"
BUNDLE="$SHARE/current/t3-cardputer-relay.mjs"
TTY="${T3_CARDPUTER_TTY:-/dev/tty}"
T3_PAIRING="t3 auth pairing create --json --ttl 5m --label t3-cardputer-relay"
FUNNEL_PORT=8443
# receipt: T3 answered GET / in 0.7-4.6 ms over 10 loopback requests on the homelab, so 5 s only trips a hung or unreachable T3
T3_PROBE_TIMEOUT_S=5
# receipt: systemd-run --user of the bundle to /healthz 200 took 161-171 ms over 10 transient units on the homelab (warm cache, temp config, no T3 tokens); cold start and slow hosts unmeasured, so 30 s (175x the slowest) only trips a relay that never comes up, and the loop exits on the first 200
HEALTHZ_TIMEOUT_S=30
# receipt: /healthz answered in 3.5 ms worst over 200 loopback probes, so 0.1 s per probe only trips a hung relay
HEALTHZ_PROBE_TIMEOUT_S=0.1
# receipt: unmeasured, a first Funnel certificate and public DNS were never timed here; 120 s is sized as a tripwire past a slow first issue, and a timeout only warns
PUBLIC_HEALTHZ_TIMEOUT_S=120
# receipt: unmeasured, tailscaled can fetch the first certificate during the TLS handshake, so 10 s per probe leaves room for that while the deadline above bounds the loop
PUBLIC_HEALTHZ_PROBE_TIMEOUT_S=10
# receipt: the bundle is 1.6 MB and the other assets are smaller, so a working link moves bytes every second; 60 s under 1 B/s only trips a stalled download
DOWNLOAD_STALL_S=60

TOOLS='
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const [command, ...args] = process.argv.slice(1);
const stdin = () => fs.readFileSync(0, "utf8");
const die = (message, code) => {
  if (message) process.stderr.write(message + "\n");
  process.exit(code || 1);
};
const readJson = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(file + " is not valid JSON: " + error.message);
  }
};
const canaryOf = (model) => JSON.stringify({ enabled: true, model: model.id, providerInstanceId: model.providerInstanceId });
const commands = {
  "config-read": (file) => {
    const config = readJson(file) || {};
    const canary = config.canary || {};
    const lines = [config.t3BaseUrl, config.port, (config.whisper || {}).binDir, canary.enabled, canary.model, config.publicUrl];
    console.log(lines.map((value) => (value === undefined ? "" : String(value))).join("\n"));
  },
  "config-set": (file, key) => {
    const value = JSON.parse(stdin());
    const config = readJson(file) || {};
    if (JSON.stringify(config[key]) === JSON.stringify(value)) return;
    config[key] = value;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  },
  verify: (dir, ...names) => {
    const sums = new Map();
    for (const line of fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").split("\n")) {
      const [hash, name] = line.trim().split(/\s+/);
      if (name) sums.set(name.replace(/^\*/, ""), hash.toLowerCase());
    }
    for (const name of names) {
      const want = sums.get(name);
      if (!want) die("SHA256SUMS has no line for " + name);
      const got = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
      if (got !== want) die(name + " does not match SHA256SUMS");
    }
  },
  "tokens-valid": (file) => {
    const secrets = readJson(file) || {};
    const expiries = [secrets.t3McpToken, secrets.t3InternalToken].map((record) => Date.parse((record || {}).expiresAt));
    if (!expiries.every((expiry) => expiry > Date.now())) process.exit(1);
    console.log(new Date(Math.min(...expiries)).toISOString().slice(0, 10));
  },
  credential: () => {
    let credential;
    try {
      credential = JSON.parse(stdin()).credential;
    } catch {
      credential = undefined;
    }
    if (typeof credential !== "string" || credential === "") die("t3 printed no JSON with a credential");
    process.stdout.write(credential);
  },
  "pair-json": () => {
    const [mcp, internal] = stdin().split("\n").map((line) => line.trim().replace(/^"|"$/g, ""));
    if (!mcp || !internal) die("a credential is empty");
    process.stdout.write(JSON.stringify({ mcp, internal }));
  },
  "ts-state": () => console.log(JSON.parse(stdin()).BackendState || "unknown"),
  "ts-cap": (cap) => {
    const self = JSON.parse(stdin()).Self || {};
    process.exit(cap in (self.CapMap || {}) || (self.Capabilities || []).includes(cap) ? 0 : 1);
  },
  "funnel-url": (funnelPort, port) => {
    const status = JSON.parse(stdin() || "{}");
    const host = Object.keys(status.Web || {}).find((key) => key.endsWith(":" + funnelPort));
    if (!host) process.exit(1);
    const proxy = (((status.Web[host] || {}).Handlers || {})["/"] || {}).Proxy || "another handler";
    if (!["http://127.0.0.1:" + port, "http://localhost:" + port].includes(proxy)) {
      console.log(proxy);
      process.exit(2);
    }
    if (!(status.AllowFunnel || {})[host]) process.exit(1);
    console.log("https://" + host);
  },
  "canary-pick": () => {
    const models = JSON.parse(stdin());
    if (models.length === 0) process.exit(4);
    const cheap = models.find((model) => /haiku|mini|flash/.test(model.id));
    if (!cheap) process.exit(3);
    console.log(canaryOf(cheap));
  },
  "json-get": (key) => console.log(JSON.parse(stdin())[key]),
  render: (template, node, bundle, logDir) => {
    const text = fs.readFileSync(template, "utf8");
    process.stdout.write(text.split("__NODE__").join(node).split("__BUNDLE__").join(bundle).split("__LOG_DIR__").join(logDir));
  },
  "models-list": () => JSON.parse(stdin()).forEach((model, i) => console.log("  " + (i + 1) + ") " + model.label + " (" + model.id + ")")),
  "canary-nth": (n) => {
    const model = JSON.parse(stdin())[Number(n) - 1];
    if (!model) process.exit(1);
    console.log(canaryOf(model));
  },
};
try {
  if (!commands[command]) die("setup.sh tool " + command + " does not exist");
  commands[command](...args);
} catch (error) {
  die(error.message);
}
'

ok() {
  printf '✓ %s\n' "$1"
}

fail() {
  if [ "$#" -eq 1 ]; then
    printf '✗ %s\n' "$1" >&2
  else
    printf '✗ %s: %s. next: %s\n' "$1" "$2" "$3" >&2
  fi
  exit 1
}

tool() {
  "$NODE" -e "$TOOLS" -- "$@"
}

relay() {
  "$NODE" "$BIN" "$@" </dev/null
}

TTY_OPEN=0
open_tty() {
  [ "$TTY_OPEN" = 0 ] || return 0
  if ! (exec 3<"$TTY") 2>/dev/null; then
    fail "$1" "no terminal to answer on" "$2"
  fi
  exec 3<"$TTY"
  TTY_OPEN=1
}

read_answer() {
  IFS= read -r ANSWER <&3 || ANSWER=""
  [ -t 3 ] || printf '\n'
}

ask() {
  if [ "$YES" = 1 ]; then
    [ "$3" = y ]
    return
  fi
  open_tty "$1" "run setup.sh in a terminal, or add --yes to take the defaults: $SETUP_CMD -s -- --yes"
  if [ "$3" = y ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf '%s %s ' "$2" "$hint"
  read_answer
  case $ANSWER in
    "") [ "$3" = y ] ;;
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

read_hidden() {
  open_tty "$1" "put the t3 CLI on PATH, or run setup.sh in a terminal"
  printf '%s (hidden): ' "$2"
  if [ -t 3 ]; then
    trap 'stty echo <&3' EXIT
    trap 'exit 130' INT TERM QUIT
    stty -echo <&3
  fi
  IFS= read -r ANSWER <&3 || ANSWER=""
  if [ -t 3 ]; then
    stty echo <&3
    trap - EXIT INT TERM QUIT
  fi
  printf '\n'
}

usage() {
  cat <<EOF
usage: setup.sh [--yes] [--dry-run] [--update]
  --yes      take the default for every question
  --dry-run  run the checks and print the plan, write nothing
  --update   update an installed relay in place, no new install link
piped: $SETUP_CMD -s -- --yes
EOF
}

check_platform() {
  if ! OS=$(uname -s) || ! ARCH=$(uname -m); then
    fail "Platform" "uname failed, its error is above" "run setup.sh on a Linux or macOS machine"
  fi
  case $OS in
    Linux) os_name=Linux ;;
    Darwin) os_name=macOS ;;
    MINGW* | MSYS* | CYGWIN* | Windows*) fail "Windows isn't supported yet" ;;
    *) fail "$OS" "setup.sh runs on Linux and macOS only" "run it on the Linux or macOS machine where T3 runs" ;;
  esac
  if ! USER_ID=$(id -u) || ! USER_NAME=$(id -un); then
    fail "User" "id failed, its error is above" "run setup.sh as your normal user"
  fi
  if [ "$USER_ID" = 0 ]; then
    fail "Running as root" "setup.sh installs the relay for your user" "run it again as your normal user, without sudo"
  fi
  ok "$os_name $ARCH"
}

refuse_homelab() {
  if [ -f "$RELAY_JSON" ] && grep -q '"projectId"' "$RELAY_JSON"; then
    fail "This machine runs a self-repairing checkout, setup.sh leaves it alone"
  fi
}

check_node() {
  if ! NODE=$(command -v node); then
    fail "Node" "not found, the relay runs on Node 22 or newer" "install Node 22, https://nodejs.org"
  fi
  if ! node_version=$("$NODE" -p process.versions.node) || ! NODE_EXEC=$("$NODE" -p process.execPath); then
    fail "Node" "$NODE didn't run, its error is above" "install Node 22, https://nodejs.org"
  fi
  case ${node_version%%.*} in
    "" | *[!0-9]*) fail "Node" "$NODE reports version \"$node_version\", not a Node version" "install Node 22, https://nodejs.org" ;;
  esac
  if [ "${node_version%%.*}" -lt 22 ]; then
    fail "Node $node_version" "too old, the relay needs Node 22 or newer" "install Node 22, https://nodejs.org"
  fi
  ok "Node $node_version"
}

read_config() {
  if ! config=$(tool config-read "$RELAY_JSON"); then
    fail "Config" "$RELAY_JSON can't be read, the error is above" "fix or remove it, then run setup.sh again"
  fi
  t3_url=$(printf '%s\n' "$config" | sed -n 1p)
  port=$(printf '%s\n' "$config" | sed -n 2p)
  whisper_dir=$(printf '%s\n' "$config" | sed -n 3p)
  canary_enabled=$(printf '%s\n' "$config" | sed -n 4p)
  canary_model=$(printf '%s\n' "$config" | sed -n 5p)
  public_url=$(printf '%s\n' "$config" | sed -n 6p)
  t3_url=${t3_url:-http://127.0.0.1:3773}
  port=${port:-8787}
  whisper_dir=${whisper_dir:-$SHARE/whisper}
}

check_tailscale() {
  if TAILSCALE=$(command -v tailscale); then
    :
  elif [ "$OS" = Darwin ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  else
    fail "Tailscale" "not found, the ADV reaches the relay through Tailscale Funnel" "install Tailscale, https://tailscale.com/download"
  fi
  if ! ts_status=$("$TAILSCALE" status --json </dev/null); then
    fail "Tailscale" "tailscale status failed, its error is above" "start Tailscale, then run setup.sh again"
  fi
  if ! ts_state=$(printf '%s' "$ts_status" | tool ts-state); then
    fail "Tailscale" "tailscale status --json printed something setup.sh can't read, the error is above" "tailscale status"
  fi
  if [ "$ts_state" != Running ]; then
    fail "Tailscale" "not logged in (state $ts_state)" "tailscale up"
  fi
  ok "Tailscale logged in"
}

check_t3() {
  if ! curl -s -o /dev/null --max-time "$T3_PROBE_TIMEOUT_S" "$t3_url/" </dev/null; then
    fail "T3" "no answer at $t3_url" "start T3 Code, or set t3BaseUrl in $RELAY_JSON"
  fi
  ok "T3 answers at $t3_url"
}

print_plan() {
  if [ "$OS" = Darwin ]; then service="launchd agent ~/Library/LaunchAgents/com.t3-cardputer.relay.plist"; else service="systemd user unit ~/.config/systemd/user/t3-cardputer-relay.service"; fi
  cat <<EOF
Dry run, nothing written. setup.sh would:
  download relay $VERSION from $RELEASE_URL and check it against SHA256SUMS
  install it in $SHARE/releases/$VERSION and link $BIN
  build voice (whisper.cpp) in $whisper_dir
  pair with T3 at $t3_url, unless $SECRETS_JSON has unexpired tokens
  ask about the canary, unless $RELAY_JSON already has canary.enabled
  turn on Tailscale Funnel on port $FUNNEL_PORT for 127.0.0.1:$port, after asking
  install and start the $service, then wait for /healthz
  check that the Funnel URL answers /healthz, then print the install link
EOF
}

install_relay() {
  if [ "$OS" = Darwin ]; then unit_asset=com.t3-cardputer.relay.plist; else unit_asset=t3-cardputer-relay.service; fi
  release_dir="$SHARE/releases/$VERSION"
  staging="$SHARE/releases/.$VERSION.partial"
  rm -rf "$staging"
  mkdir -p "$staging"
  for asset in t3-cardputer-relay.mjs install-whisper.sh "$unit_asset" SHA256SUMS; do
    curl_status=0
    curl -fsSL --proto '=https' --speed-limit 1 --speed-time "$DOWNLOAD_STALL_S" -o "$staging/$asset" "$RELEASE_URL/$asset" </dev/null || curl_status=$?
    if [ "$curl_status" = 28 ]; then
      fail "Relay download" "download_stall_s=$DOWNLOAD_STALL_S, $RELEASE_URL/$asset sent nothing for longer than that" "check your connection to github.com, then run setup.sh again"
    fi
    if [ "$curl_status" != 0 ]; then
      fail "Relay download" "$RELEASE_URL/$asset failed (curl exit $curl_status)" "check that github.com is reachable, then run setup.sh again"
    fi
  done
  if ! why=$(tool verify "$staging" t3-cardputer-relay.mjs install-whisper.sh "$unit_asset" 2>&1); then
    fail "Relay download" "$why" "run setup.sh again, and report it at https://github.com/joaopcm/t3-cardputer/issues if it repeats"
  fi
  chmod 755 "$staging/t3-cardputer-relay.mjs"
  rm -rf "$release_dir"
  mv "$staging" "$release_dir"
  ln -sfn "releases/$VERSION" "$SHARE/current"
  mkdir -p "$(dirname "$BIN")"
  ln -sfn "$BUNDLE" "$BIN"
  reported=$(relay --version) || reported="nothing"
  if [ "$reported" != "t3-cardputer-relay $VERSION" ]; then
    fail "Relay" "the bundle reports $reported, want t3-cardputer-relay $VERSION" "run setup.sh again"
  fi
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ok "Relay $VERSION installed" ;;
    *) ok "Relay $VERSION installed, add ~/.local/bin to your PATH to run t3-cardputer-relay" ;;
  esac
}

existing_gpu() {
  cache="$whisper_dir/build/CMakeCache.txt"
  if [ ! -f "$cache" ]; then
    echo ""
  elif grep -q '^GGML_CUDA:BOOL=ON' "$cache"; then
    echo cuda
  elif grep -q '^GGML_METAL:BOOL=ON' "$cache"; then
    echo metal
  else
    echo none
  fi
}

install_voice() {
  built=$(existing_gpu)
  gpu=${built:-none}
  if [ "$OS" = Darwin ] && [ "$ARCH" = arm64 ]; then
    default=y
    [ "$built" != none ] || default=n
    if ask Voice "Build voice with Metal for this Mac's GPU?" "$default"; then gpu=metal; else gpu=none; fi
  elif [ "$OS" = Linux ] && command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then
    default=n
    [ "$built" != cuda ] || default=y
    if ask Voice "Build voice for your NVIDIA GPU with CUDA? It needs the CUDA toolkit." "$default"; then gpu=cuda; else gpu=none; fi
  fi
  case $gpu in
    none) label=CPU ;;
    metal) label=Metal ;;
    cuda) label=CUDA ;;
  esac
  if ! bash "$release_dir/install-whisper.sh" --gpu "$gpu" --prefix "$whisper_dir" </dev/null >/dev/null; then
    fail "Voice" "install-whisper.sh --gpu $gpu failed, its error is above" "fix that error, or pick the CPU build, then run setup.sh again"
  fi
  ok "Voice built for $label"
}

t3_pairing() {
  t3 auth pairing create --json --ttl 5m --label t3-cardputer-relay </dev/null
}

pair_t3() {
  if valid_until=$(tool tokens-valid "$SECRETS_JSON"); then
    ok "T3 paired, tokens valid until $valid_until"
    return
  fi
  if command -v t3 >/dev/null; then
    if ! mcp=$(t3_pairing | tool credential) || ! internal=$(t3_pairing | tool credential); then
      fail "T3 pairing" "$T3_PAIRING failed, its error is above" "run $T3_PAIRING yourself to see why, then run setup.sh again"
    fi
  else
    printf 'T3 pairing needs two codes. Run this twice where T3 runs and take "credential" from each:\n'
    printf '  %s\n' "$T3_PAIRING" "$T3_PAIRING"
    read_hidden "T3 pairing" "First credential"
    mcp=$ANSWER
    read_hidden "T3 pairing" "Second credential"
    internal=$ANSWER
  fi
  if ! printf '%s\n%s\n' "$mcp" "$internal" | tool pair-json | "$NODE" "$BIN" pair-t3 --stdin >/dev/null; then
    fail "T3 pairing" "t3-cardputer-relay pair-t3 failed, its error is above" "run setup.sh again with two fresh codes"
  fi
  ok "T3 paired"
}

set_canary() {
  if [ "$canary_enabled" = true ]; then
    ok "Canary on${canary_model:+, using $canary_model}"
    return
  fi
  if [ "$canary_enabled" = false ]; then
    ok "Canary off"
    return
  fi
  canary='{"enabled":false}'
  off_reason=""
  if ask Canary "On each T3 update the relay runs one short agent turn to check approvals still work. It uses your usage. Enable?" n; then
    if ! models=$(relay models --json); then
      fail "Canary" "t3-cardputer-relay models --json failed, its error is above" "t3-cardputer-relay models"
    fi
    pick_status=0
    picked=$(printf '%s' "$models" | tool canary-pick) || pick_status=$?
    case $pick_status in
      0) canary=$picked ;;
      3)
        printf 'No small model found. Pick one for the canary, or press enter for none:\n'
        printf '%s' "$models" | tool models-list
        printf 'Model number: '
        read_answer
        if [ -n "$ANSWER" ] && ! canary=$(printf '%s' "$models" | tool canary-nth "$ANSWER"); then
          fail "Canary" "$ANSWER is not on the list" "run setup.sh again and pick a listed number"
        fi
        ;;
      4) off_reason=", T3 lists no usable models" ;;
      *) fail "Canary" "t3-cardputer-relay models --json printed something setup.sh can't read, its error is above" "t3-cardputer-relay models --json" ;;
    esac
  fi
  printf '%s' "$canary" | tool config-set "$RELAY_JSON" canary
  if [ "$(printf '%s' "$canary" | tool json-get enabled)" = true ]; then
    ok "Canary on, using $(printf '%s' "$canary" | tool json-get model)"
  else
    ok "Canary off$off_reason"
  fi
}

funnel_url() {
  if ! funnel_status=$("$TAILSCALE" funnel status --json </dev/null); then
    fail "Funnel" "tailscale funnel status failed, its error is above" "tailscale funnel status"
  fi
  url=$(printf '%s' "$funnel_status" | tool funnel-url "$FUNNEL_PORT" "$port") || url_status=$?
}

set_funnel() {
  url_status=0
  funnel_url
  if [ "$url_status" = 2 ]; then
    fail "Funnel" "port $FUNNEL_PORT already serves $url" "free it with tailscale funnel --https=$FUNNEL_PORT off, then run setup.sh again"
  fi
  if [ "$url_status" = 1 ]; then
    if ! ask Funnel "Turn on Tailscale Funnel on port $FUNNEL_PORT so the ADV can reach the relay?" y; then
      fail "Funnel" "the ADV reaches the relay only through Funnel" "tailscale funnel --bg --https=$FUNNEL_PORT $port, then run setup.sh again"
    fi
    if ! printf '%s' "$ts_status" | tool ts-cap https; then
      fail "Funnel" "HTTPS certificates are off on your tailnet, Funnel needs them" "turn on HTTPS at https://login.tailscale.com/admin/dns, then run setup.sh again"
    fi
    if ! printf '%s' "$ts_status" | tool ts-cap funnel; then
      fail "Funnel" "this machine isn't allowed to use Funnel" "add the funnel node attribute in your tailnet policy, https://tailscale.com/kb/1223/funnel"
    fi
    if ! funnel_out=$("$TAILSCALE" funnel --bg --https="$FUNNEL_PORT" "$port" </dev/null 2>&1); then
      printf '%s\n' "$funnel_out" >&2
      if printf '%s' "$funnel_out" | grep -qi 'access denied'; then
        fail "Funnel" "tailscale funnel needs root or the Tailscale operator" "sudo tailscale set --operator=\$USER, then run setup.sh again"
      fi
      fail "Funnel" "tailscale funnel failed, its error is above" "tailscale funnel --bg --https=$FUNNEL_PORT $port"
    fi
    url_status=0
    funnel_url
    if [ "$url_status" != 0 ]; then
      fail "Funnel" "tailscale funnel status shows no funnel on $FUNNEL_PORT after turning it on" "tailscale funnel status"
    fi
  fi
  if [ "$url" != "$public_url" ]; then
    printf '"%s"' "$url" | tool config-set "$RELAY_JSON" publicUrl
  fi
  ok "Funnel on port $FUNNEL_PORT"
}

render() {
  if ! tool render "$release_dir/$unit_asset" "$NODE_EXEC" "$BUNDLE" "$2" >"$1"; then
    fail "Relay service" "rendering $unit_asset failed, its error is above" "run setup.sh again"
  fi
  if grep -q '__' "$1" || ! grep -qF "$BUNDLE" "$1"; then
    fail "Relay service" "$1 still has a placeholder or doesn't run $BUNDLE, the $unit_asset in release $VERSION is wrong" "report it at https://github.com/joaopcm/t3-cardputer/issues"
  fi
}

systemd_user() {
  if ! systemctl --user "$@"; then
    fail "Relay service" "systemctl --user $* failed, its error is above" "systemctl --user status t3-cardputer-relay"
  fi
}

install_systemd() {
  if ! command -v systemctl >/dev/null; then
    fail "Relay service" "systemctl not found, setup.sh installs a systemd user unit on Linux" "run t3-cardputer-relay serve under your own supervisor"
  fi
  unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  render "$unit_dir/t3-cardputer-relay.service" ""
  if [ "$(loginctl show-user "$USER_NAME" -p Linger 2>/dev/null)" != Linger=yes ] && ! loginctl enable-linger "$USER_NAME"; then
    fail "Relay service" "loginctl enable-linger failed, so the relay would stop when you log out" "sudo loginctl enable-linger $USER_NAME, then run setup.sh again"
  fi
  systemd_user daemon-reload
  systemd_user -q enable t3-cardputer-relay
  systemd_user restart t3-cardputer-relay
  service_kind="systemd user unit, starts at boot"
  logs_cmd="journalctl --user -u t3-cardputer-relay -n 50"
}

install_launchd() {
  log_dir="$HOME/Library/Logs/t3-cardputer"
  plist="$HOME/Library/LaunchAgents/com.t3-cardputer.relay.plist"
  agent="gui/$USER_ID/com.t3-cardputer.relay"
  mkdir -p "$log_dir" "$(dirname "$plist")"
  if launchctl print "$agent" >/dev/null 2>&1 && ! launchctl bootout "$agent"; then
    fail "Relay service" "launchctl bootout failed, its error is above" "launchctl bootout $agent, then run setup.sh again"
  fi
  render "$plist" "$log_dir"
  if ! launchctl bootstrap "gui/$USER_ID" "$plist"; then
    fail "Relay service" "launchctl bootstrap failed, its error is above" "launchctl bootstrap gui/$USER_ID $plist"
  fi
  service_kind="launchd agent, starts at login"
  logs_cmd="tail -n 50 $log_dir/relay.log"
}

start_service() {
  if [ "$OS" = Darwin ]; then install_launchd; else install_systemd; fi
  deadline=$(($(date +%s) + HEALTHZ_TIMEOUT_S))
  until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time "$HEALTHZ_PROBE_TIMEOUT_S" "http://127.0.0.1:$port/healthz" </dev/null)" = 200 ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "Relay service" "healthz_timeout_s=$HEALTHZ_TIMEOUT_S, the relay needed longer than that to answer /healthz" "$logs_cmd"
    fi
    sleep 0.1
  done
  ok "Relay service running ($service_kind)"
}

on_battery_power() {
  if [ "$OS" = Darwin ]; then
    pmset -g batt 2>/dev/null | grep -q InternalBattery
  else
    cat /sys/class/power_supply/*/type 2>/dev/null | grep -qx Battery
  fi
}

check_public() {
  deadline=$(($(date +%s) + PUBLIC_HEALTHZ_TIMEOUT_S))
  until curl -sf -o /dev/null --max-time "$PUBLIC_HEALTHZ_PROBE_TIMEOUT_S" "$url/healthz" </dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf '! Funnel: public_healthz_timeout_s=%s, %s/healthz didn'"'"'t answer in that time. next: a first Funnel certificate and DNS can take a few minutes, open the link once curl -sf %s/healthz prints ok\n' "$PUBLIC_HEALTHZ_TIMEOUT_S" "$url" "$url"
      return
    fi
    sleep 1
  done
  ok "Funnel answers at /healthz"
}

print_link() {
  if ! link_out=$(relay install-link); then
    fail "Install link" "t3-cardputer-relay install-link failed, its error is above" "t3-cardputer-relay install-link"
  fi
  if ! link=$(printf '%s\n' "$link_out" | grep '^https://t3-cardputer.jopcmelo.com/install#'); then
    fail "Install link" "t3-cardputer-relay install-link printed no link" "t3-cardputer-relay install-link"
  fi
  expires=$(printf '%s\n' "$link_out" | grep '^code expires') || expires=""
  ok "Install link ready${expires:+, the $expires}"
  if on_battery_power; then
    printf 'This machine must be awake for the ADV to reach your agents.\n'
  fi
  printf 'Plug in your ADV and open this in Chrome or Edge:\n%s\n' "$link"
}

main() {
  YES=0
  DRY_RUN=0
  UPDATE=0
  for arg in "$@"; do
    case $arg in
      --yes) YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --update) UPDATE=1 YES=1 ;;
      -h | --help) usage; exit 0 ;;
      *) fail "Option $arg" "setup.sh takes --yes, --dry-run and --update" "$SETUP_CMD" ;;
    esac
  done

  check_platform
  refuse_homelab
  check_node
  read_config
  check_tailscale
  check_t3
  if [ "$DRY_RUN" = 1 ]; then
    print_plan
    return
  fi

  for file in "$RELAY_JSON" "$SECRETS_JSON"; do
    if [ -f "$file" ]; then chmod 600 "$file"; fi
  done
  install_relay
  install_voice
  pair_t3
  set_canary
  set_funnel
  start_service
  if [ "$UPDATE" = 1 ]; then
    ok "Relay updated to $VERSION"
    return
  fi
  check_public
  print_link
}

main "$@"
