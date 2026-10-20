# setup

how i run the relay on the homelab. placeholders: `<homelab>`, `<tailnet>`, `<port>` (default 8787).

```
 device / sim ──https──► funnel (tailscaled) ──► 127.0.0.1:<port> relay ──► T3 (127.0.0.1:3773)
                                                       │
                                                       └──► whisper-server (127.0.0.1:8788)
```

## 1. install

```
git clone https://github.com/joaopcm/t3-cardputer.git ~/.local/share/t3-cardputer/deploy
cd ~/.local/share/t3-cardputer/deploy/relay
pnpm install --frozen-lockfile
pnpm build
~/.local/share/t3-cardputer/deploy/relay/scripts/install-whisper.sh
ln -sf ~/.local/share/t3-cardputer/deploy/relay/dist/cli.js ~/.local/bin/t3-cardputer-relay
```

the symlink puts `t3-cardputer-relay` on PATH for the commands below.

node 22 and pnpm go in `~/.local/bin`. the unit puts that dir on its PATH.

the relay's self-repair runs `git pull --ff-only origin main` in this clone, so it needs git access to the repo without a prompt.

`install-whisper.sh` builds whisper.cpp v1.9.5 (cpu only) and downloads the models. it falls back to a user-local cmake via `uv` when cmake is missing.

## 2. config

optional. defaults are in `~/.local/share/t3-cardputer/deploy/relay/src/config.ts`, `~/.local/share/t3-cardputer/deploy/relay/relay.example.json` shows every key. the file is `~/.config/t3-cardputer/relay.json`, only set what you change:

```json
{ "port": 8787, "repair": { "projectId": "<t3 project id>" } }
```

unknown keys and bad values fail at start with the key name.

## 3. pair T3

the relay needs two T3 tokens, an MCP one and an internal one. both come from one-time pairing codes, so make two.

```
t3 auth pairing create --json --ttl 5m --label t3-cardputer-relay
t3 auth pairing create --json --ttl 5m --label t3-cardputer-relay
```

`t3 pair` gives the same code with a QR. take `credential` from each. then:

```
t3-cardputer-relay pair-t3 --mcp <credential 1> --internal <credential 2>
```

- `--mcp` goes through T3's MCP OAuth at `full-access`. only full-access can launch full-access threads (receipt: `docs/receipts/2026-10-20-approvals-spike.md` (d)).
- `--internal` is the bearer for the internal websocket that answers approvals (same receipt, (c)).
- tokens land in `~/.config/t3-cardputer/secrets.json` (0600). the device never sees them.
- both expire after 30 days and neither refreshes. re-run this section before then.

## 4. register the repo in T3

the repair agent runs as a T3 thread in this repo, so T3 needs it as a project. from a T3 thread with the MCP tools:

1. `t3_project_create` with the repo's path on the homelab.
2. `t3_project_list`, copy its id.
3. put it in `relay.json` as `repair.projectId`.

without it repair refuses to start and says so.

## 5. github

fine-grained token, resource owner = me, **only** repo `joaopcm/t3-cardputer`:

- Contents: read and write
- Pull requests: read and write
- Checks: read
- Commit statuses: read

```
t3-cardputer-relay secrets set github
```

paste the token on stdin (hidden on a tty), or `... < token.txt`.

## 6. branch protection

repair only merges its own PR when the required checks passed, and the relay's `repair.requiredChecks` default is `["test"]`. so `main` requires the `test` job from ci. 15368 is the GitHub Actions app id.

```
gh api -X PUT repos/joaopcm/t3-cardputer/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "test", "app_id": 15368 }] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

`strict` is "require branches up to date". the job is named `test` in `.github/workflows/ci.yml`. don't turn it into a matrix, that renames the check.

## 7. run it

```
mkdir -p ~/.config/systemd/user
cp ~/.local/share/t3-cardputer/deploy/relay/deploy/t3-cardputer-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now t3-cardputer-relay
loginctl enable-linger $USER
journalctl --user -u t3-cardputer-relay -f
```

linger keeps the unit alive after logout. stop waits up to 240 s (a canary can be mid-run, receipts are in the unit file).

## 8. funnel

the relay binds `127.0.0.1:<port>` only. tailscaled is the public edge.

```
tailscale funnel --bg <port>
tailscale funnel status
```

the tailnet policy needs the `funnel` node attribute for this machine, or the command tells you to enable it. the url is `https://<homelab>.<tailnet>.ts.net`.

check which client address the relay sees. the lockout is keyed on it, and the relay trusts `X-Forwarded-For` only when the tcp peer is loopback, taking the last entry.

1. from a network outside the tailnet (phone hotspot), post a wrong code 20 times (`authFailuresPerWindow`):

   ```
   for i in $(seq 20); do curl -s -o /dev/null -X POST https://<homelab>.<tailnet>.ts.net/v1/pair -d '{"code":"WRONGCODE","name":"probe"}'; done
   ```

2. on the homelab run `t3-cardputer-relay devices`.
3. the `lockout:` line names the source. a real client address means funnel forwards it. `127.0.0.1` (or an `::/64` loopback key) means it doesn't, and every stranger shares one bucket (valid device tokens are never locked out either way).

it locks that source out of pairing for `authWindowMs` (10 min).

## 9. device

```
t3-cardputer-relay pair
```

type the printed code on the ADV. it expires after `pairingCodeTtlMs` (10 min).

without the device, drive the relay from a laptop (clone, build and symlink as in section 1; `jfk.wav` is in the whisper clone's `samples/`, adjust the path if the laptop's differs):

```
t3-cardputer-relay sim pair https://<homelab>.<tailnet>.ts.net <code>
t3-cardputer-relay sim --wav ~/.local/share/t3-cardputer/whisper/samples/jfk.wav
```

`pair` saves the token to `~/.config/t3-cardputer/sim.json`. `sim` opens a simulated device, shows home, and streams the wav for transcription.

`t3-cardputer-relay devices` lists paired devices, `t3-cardputer-relay revoke <deviceId>` removes one.

## 10. check approvals

```
t3-cardputer-relay canary
```

exit 0 means the approvals path works against the current T3. the running relay does the same on every T3 version change and repairs the adapter if it breaks.
