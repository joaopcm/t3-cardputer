#!/bin/sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
setup_src="$here/../../public/setup.sh"
version=9.9.9
host=t3-box.example.com
link="https://t3-cardputer.jopcmelo.com/install#r=https%3A%2F%2F$host%3A8443&c=K7Q2AB9X"
models='[{"id":"claude-opus-5-5","label":"Claude Opus 5.5","providerInstanceId":"claude-1"},{"id":"claude-haiku-5-5","label":"Claude Haiku 5.5","providerInstanceId":"claude-1"}]'
real_node=$(command -v node)
tools="sh bash cat cp mkdir ln chmod mv rm sed grep sleep cmp stty touch dirname"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir "$work/release"
cp "$here"/fixtures/* "$work/release/"
(cd "$work/release" && "$real_node" -e '
  const { createHash } = require("node:crypto");
  const { readFileSync, readdirSync } = require("node:fs");
  for (const name of readdirSync(".").sort()) console.log(createHash("sha256").update(readFileSync(name)).digest("hex") + "  " + name);
' >SHA256SUMS)
sed "s/__VERSION__/$version/g" "$setup_src" >"$work/setup.sh"

failures=0
case_name=""

fresh_case() {
  case_name=$1
  dir="$work/$1"
  mkdir -p "$dir/home" "$dir/state" "$dir/bin"
  for tool in $tools; do
    ln -s "$(command -v "$tool")" "$dir/bin/$tool"
  done
  for stub in "$here"/stubs/*; do
    ln -s "$stub" "$dir/bin/${stub##*/}"
  done
  os=Linux arch=x86_64 uid=1000 node_version=22.11.0 ts_state=Running ready_polls=3 tty="$work/no-tty" catalog=$models
}

without() {
  rm "$dir/bin/$1"
}

answers() {
  tty="$dir/tty"
  printf '%b' "$1" >"$tty"
}

run_setup() {
  : >"$dir/state/calls.log"
  set +e
  env -i HOME="$dir/home" PATH="$dir/bin" USER=tester LANG=C.UTF-8 \
    REAL_NODE="$real_node" STUB_STATE="$dir/state" STUB_FIXTURES="$work/release" STUB_RELAY_VERSION="$version" \
    STUB_OS="$os" STUB_ARCH="$arch" STUB_UID="$uid" STUB_NODE_VERSION="$node_version" STUB_TS_STATE="$ts_state" \
    STUB_HOST="$host" STUB_MODELS="$catalog" STUB_READY_POLLS="$ready_polls" T3_CARDPUTER_TTY="$tty" \
    /bin/sh "$work/setup.sh" "$@" >"$dir/out" 2>&1
  status=$?
  set -e
}

fail() {
  echo "FAIL [$case_name] $1"
  failures=$((failures + 1))
}

expect_status() {
  [ "$status" = "$1" ] || fail "exit $status, want $1"
}

expect_line() {
  grep -qxF -- "$1" "$dir/out" || fail "no line: $1"
}

expect_no() {
  if grep -qF -- "$1" "$2"; then fail "${2##*/} has: $1"; fi
}

expect_call() {
  grep -qxF -- "$1" "$dir/state/calls.log" || fail "no call: $1"
}

expect_markers() {
  grep -E '^(✓|✗) ' "$dir/out" >"$dir/markers" || true
  printf '%s\n' "$@" >"$dir/want-markers"
  cmp -s "$dir/markers" "$dir/want-markers" || fail "marker lines differ:
$(diff "$dir/want-markers" "$dir/markers" || true)"
}

expect_last_lines() {
  tail -n 2 "$dir/out" >"$dir/last"
  printf 'Plug in your ADV and open this in Chrome or Edge:\n%s\n' "$link" >"$dir/want-last"
  cmp -s "$dir/last" "$dir/want-last" || fail "last two lines are: $(cat "$dir/last")"
  tail -n 1 "$dir/out" | grep -qE '^https://t3-cardputer\.jopcmelo\.com/install#r=https%3A%2F%2F[^&]+&c=[A-Z0-9]{8}$' || fail "last line is not an install link"
  [ "$(grep -c "$host" "$dir/out")" = 1 ] || fail "tailnet host printed $(grep -c "$host" "$dir/out") times, want once"
}

mode_of() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"
}

expect_private() {
  [ -f "$1" ] || { fail "missing $1"; return; }
  [ "$(mode_of "$1")" = 600 ] || fail "${1##*/} is mode $(mode_of "$1"), want 600"
}

expect_json() {
  "$real_node" -e '
    const [file, path, want] = process.argv.slice(1);
    const got = JSON.stringify(path.split(".").reduce((node, key) => node?.[key], JSON.parse(require("node:fs").readFileSync(file, "utf8"))));
    if (got !== want) { console.log(path + " is " + got + ", want " + want); process.exit(1); }
  ' "$1" "$2" "$3" >"$dir/json-diff" 2>&1 || fail "$(cat "$dir/json-diff")"
}

expect_home_empty() {
  [ -z "$(find "$dir/home" -mindepth 1 ! -path "$dir/home/.config" ! -path "$dir/home/.config/t3-cardputer" ! -path "$dir/home/.config/t3-cardputer/relay.json")" ] || fail "setup wrote: $(find "$dir/home" -mindepth 1)"
}

expect_no_secrets() {
  for secret in SECRET-CRED SECRET-PASTE; do
    expect_no "$secret" "$dir/out"
    expect_no "$secret" "$dir/state/calls.log"
  done
}

expect_installed() {
  share="$dir/home/.local/share/t3-cardputer"
  [ "$(readlink "$share/current")" = "releases/$version" ] || fail "current points at $(readlink "$share/current")"
  [ "$(readlink "$dir/home/.local/bin/t3-cardputer-relay")" = "$share/current/t3-cardputer-relay.mjs" ] || fail "bin link points at $(readlink "$dir/home/.local/bin/t3-cardputer-relay")"
  [ -x "$share/releases/$version/t3-cardputer-relay.mjs" ] || fail "bundle is not executable"
  expect_private "$dir/home/.config/t3-cardputer/relay.json"
  expect_private "$dir/home/.config/t3-cardputer/secrets.json"
  expect_json "$dir/home/.config/t3-cardputer/relay.json" publicUrl "\"https://$host:8443\""
}

finish_case() {
  if [ "$failures" = "$1" ]; then
    echo "ok   $case_name"
  else
    echo "--- $case_name output:"
    cat "$dir/out"
    echo "--- $case_name calls:"
    cat "$dir/state/calls.log"
  fi
}

before=$failures
fresh_case linux-fresh
answers 'n\ny\ny\n'
run_setup
expect_status 0
expect_markers \
  "✓ Linux x86_64" \
  "✓ Node 22.11.0" \
  "✓ Tailscale logged in" \
  "✓ T3 answers at http://127.0.0.1:3773" \
  "✓ Relay $version installed, add ~/.local/bin to your PATH to run t3-cardputer-relay" \
  "✓ Voice built for CPU" \
  "✓ T3 paired" \
  "✓ Canary on, using claude-haiku-5-5" \
  "✓ Funnel on port 8443" \
  "✓ Relay service running (systemd user unit, starts at boot)" \
  "✓ Install link ready, the code expires in 10 min"
expect_line "Build voice for your NVIDIA GPU with CUDA? It needs the CUDA toolkit. [y/N] "
expect_line "On each T3 update the relay runs one short agent turn to check approvals still work. It uses your usage. Enable? [y/N] "
expect_line "Turn on Tailscale Funnel on port 8443 so the ADV can reach the relay? [Y/n] "
expect_last_lines
expect_installed
expect_no_secrets
expect_no "Available on the internet" "$dir/out"
expect_json "$dir/home/.config/t3-cardputer/relay.json" canary '{"enabled":true,"model":"claude-haiku-5-5","providerInstanceId":"claude-1"}'
expect_json "$dir/state/paired.json" mcp '"SECRET-CRED-1"'
expect_json "$dir/state/paired.json" internal '"SECRET-CRED-2"'
expect_call "install-whisper --gpu none --prefix $dir/home/.local/share/t3-cardputer/whisper"
expect_call "tailscale funnel --bg --https=8443 8787"
expect_call "loginctl enable-linger tester"
expect_call "systemctl --user daemon-reload"
expect_call "systemctl --user -q enable t3-cardputer-relay"
expect_call "systemctl --user restart t3-cardputer-relay"
unit="$dir/home/.config/systemd/user/t3-cardputer-relay.service"
grep -qxF "ExecStart=$dir/bin/node $dir/home/.local/share/t3-cardputer/current/t3-cardputer-relay.mjs serve" "$unit" || fail "unit ExecStart: $(grep ExecStart "$unit")"
finish_case "$before"

before=$failures
case_name=linux-rerun
cp "$dir/home/.config/t3-cardputer/relay.json" "$dir/relay.before" || fail "no relay.json to keep"
cp "$dir/home/.config/t3-cardputer/secrets.json" "$dir/secrets.before" || fail "no secrets.json to keep"
tty="$work/no-tty"
run_setup --yes
expect_status 0
cmp -s "$dir/relay.before" "$dir/home/.config/t3-cardputer/relay.json" || fail "relay.json bytes changed"
cmp -s "$dir/secrets.before" "$dir/home/.config/t3-cardputer/secrets.json" || fail "secrets.json bytes changed"
grep -qE '^✓ T3 paired, tokens valid until [0-9]{4}-[0-9]{2}-[0-9]{2}$' "$dir/out" || fail "no tokens-valid line"
expect_line "✓ Canary on, using claude-haiku-5-5"
expect_line "✓ Funnel on port 8443"
expect_no "t3 auth" "$dir/state/calls.log"
expect_no "relay pair-t3" "$dir/state/calls.log"
expect_no "funnel --bg" "$dir/state/calls.log"
expect_no "enable-linger" "$dir/state/calls.log"
expect_last_lines
expect_installed
finish_case "$before"

before=$failures
case_name=linux-update
run_setup --update
expect_status 0
[ "$(tail -n 1 "$dir/out")" = "✓ Relay updated to $version" ] || fail "last line is: $(tail -n 1 "$dir/out")"
expect_no "install-link" "$dir/state/calls.log"
expect_call "systemctl --user restart t3-cardputer-relay"
cmp -s "$dir/relay.before" "$dir/home/.config/t3-cardputer/relay.json" || fail "relay.json bytes changed"
finish_case "$before"

before=$failures
fresh_case macos-fresh
os=Darwin arch=arm64 uid=501
run_setup --yes
expect_status 0
expect_markers \
  "✓ macOS arm64" \
  "✓ Node 22.11.0" \
  "✓ Tailscale logged in" \
  "✓ T3 answers at http://127.0.0.1:3773" \
  "✓ Relay $version installed, add ~/.local/bin to your PATH to run t3-cardputer-relay" \
  "✓ Voice built for Metal" \
  "✓ T3 paired" \
  "✓ Canary off" \
  "✓ Funnel on port 8443" \
  "✓ Relay service running (launchd agent, starts at login)" \
  "✓ Install link ready, the code expires in 10 min"
expect_line "This machine must be awake for the ADV to reach your agents."
expect_last_lines
expect_installed
expect_no_secrets
expect_json "$dir/home/.config/t3-cardputer/relay.json" canary '{"enabled":false}'
expect_call "install-whisper --gpu metal --prefix $dir/home/.local/share/t3-cardputer/whisper"
plist="$dir/home/Library/LaunchAgents/com.t3-cardputer.relay.plist"
expect_call "launchctl bootstrap gui/501 $plist"
expect_no "systemctl" "$dir/state/calls.log"
expect_no "__" "$plist"
grep -qF "<string>$dir/home/.local/share/t3-cardputer/current/t3-cardputer-relay.mjs</string>" "$plist" || fail "plist has no bundle path"
grep -qF "<string>$dir/home/Library/Logs/t3-cardputer/relay.log</string>" "$plist" || fail "plist has no log path"
[ -d "$dir/home/Library/Logs/t3-cardputer" ] || fail "no log dir"
finish_case "$before"

before=$failures
fresh_case homelab
mkdir -p "$dir/home/.config/t3-cardputer"
printf '{"repair":{"projectId":"p-1"}}\n' >"$dir/home/.config/t3-cardputer/relay.json"
cp "$dir/home/.config/t3-cardputer/relay.json" "$dir/relay.before"
run_setup --yes
expect_status 1
expect_line "✗ This machine runs a self-repairing checkout, setup.sh leaves it alone"
cmp -s "$dir/relay.before" "$dir/home/.config/t3-cardputer/relay.json" || fail "relay.json bytes changed"
expect_home_empty
[ ! -s "$dir/state/calls.log" ] || fail "calls made: $(cat "$dir/state/calls.log")"
finish_case "$before"

before=$failures
fresh_case root
uid=0
run_setup --yes
expect_status 1
expect_line "✗ Running as root: setup.sh installs the relay for your user. next: run it again as your normal user, without sudo"
expect_home_empty
finish_case "$before"

before=$failures
fresh_case node-20
node_version=20.11.1
run_setup --yes
expect_status 1
expect_line "✗ Node 20.11.1: too old, the relay needs Node 22 or newer. next: install Node 22, https://nodejs.org"
expect_home_empty
finish_case "$before"

before=$failures
fresh_case t3-missing
without t3
without nvidia-smi
answers 'SECRET-PASTE-1\n"SECRET-PASTE-2"\n'
run_setup --yes
expect_status 0
expect_line "T3 pairing needs two codes. Run this twice where T3 runs and take \"credential\" from each:"
[ "$(grep -cxF "  t3 auth pairing create --json --ttl 5m --label t3-cardputer-relay" "$dir/out")" = 2 ] || fail "pairing command not shown twice"
expect_line "First credential (hidden): "
expect_line "Second credential (hidden): "
expect_line "✓ T3 paired"
expect_json "$dir/state/paired.json" mcp '"SECRET-PASTE-1"'
expect_json "$dir/state/paired.json" internal '"SECRET-PASTE-2"'
expect_no_secrets
expect_last_lines
expect_installed
finish_case "$before"

before=$failures
fresh_case canary-choice
without nvidia-smi
catalog='[{"id":"gpt-5","label":"GPT-5","providerInstanceId":"codex-1"},{"id":"claude-opus-5-5","label":"Claude Opus 5.5","providerInstanceId":"claude-1"}]'
answers 'y\n2\ny\n'
run_setup
expect_status 0
expect_line "No small model found. Pick one for the canary, or press enter for none:"
expect_line "  1) GPT-5 (gpt-5)"
expect_line "  2) Claude Opus 5.5 (claude-opus-5-5)"
expect_line "✓ Canary on, using claude-opus-5-5"
expect_json "$dir/home/.config/t3-cardputer/relay.json" canary '{"enabled":true,"model":"claude-opus-5-5","providerInstanceId":"claude-1"}'
expect_last_lines
finish_case "$before"

before=$failures
fresh_case dry-run
answers 'y\ny\ny\n'
run_setup --dry-run
expect_status 0
expect_markers \
  "✓ Linux x86_64" \
  "✓ Node 22.11.0" \
  "✓ Tailscale logged in" \
  "✓ T3 answers at http://127.0.0.1:3773"
expect_line "Dry run, nothing written. setup.sh would:"
expect_home_empty
expect_no "github.com" "$dir/state/calls.log"
expect_no "systemctl" "$dir/state/calls.log"
expect_no "loginctl" "$dir/state/calls.log"
expect_no "funnel" "$dir/state/calls.log"
expect_no "relay " "$dir/state/calls.log"
expect_no "t3 " "$dir/state/calls.log"
finish_case "$before"

before=$failures
fresh_case windows
os=MINGW64_NT-10.0-19045
run_setup --yes
expect_status 1
expect_line "✗ Windows isn't supported yet"
expect_home_empty
finish_case "$before"

before=$failures
fresh_case never-ready
ready_polls=1000
run_setup --yes
expect_status 1
expect_line "✗ Relay service: healthz_polls=12, the relay needed more than 12 polls 100 ms apart to answer /healthz. next: journalctl --user -u t3-cardputer-relay -n 50"
expect_no "install-link" "$dir/state/calls.log"
finish_case "$before"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all setup.sh cases pass"
