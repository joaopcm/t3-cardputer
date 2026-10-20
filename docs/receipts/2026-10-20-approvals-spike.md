# Receipt: T3 approvals over MCP vs the internal protocol (2026-10-20)

Measured against the homelab T3 server: `serverVersion 0.1.0`, `orchestrationProtocolVersion 2`, `http://127.0.0.1:3773`.
Source read: `github.com/pingdotgg/t3code` at `67c0fc0c` (2026-10-20). Spike: `relay/spikes/approvals-spike.ts`. Fixtures: `relay/test/fixtures/t3/`.

**Verdict:** approvals can be seen and answered over the internal WebSocket with a bearer token from `t3 pair` + `/oauth/token`. The stop condition did not trigger.

```
 device ── relay ──┬── MCP  /mcp  (OAuth bearer, access level caps runtime mode)
                   │     list/read/launch/send/wait, answer *questions*
                   │     sees approvals only as pendingRequestCount + an activity item
                   │
                   └── WS   /ws?orchestrationProtocol=2&wsTicket=…  (internal bearer)
                         subscribeThread ──► runtime-request.updated {status:"pending"}
                         dispatchCommand ◄── runtime-request.respond {requestId, decision}
```

## (a) How a pending approval appears

### MCP: no status change, only a count and an activity item

- `t3_thread_list` keeps reporting `status: "running"` while an approval is pending. In 57 polls over 15 s with the approval pending, it never reported `waiting`. `statuses: ["waiting"]` returns `threads: []`. List entries have **no** `pendingRequestCount`. A pending *question* behaves the same way (`running`, not `waiting`). `status` is the durable *run* status. The only `waiting` seen was a run passing through `waiting` for a few ms on its way to `completed`. **`waiting` cannot be used to detect approvals or questions.**
- `t3_thread_read` → `thread.pendingRequestCount: 1`. This is the cheapest MCP-side signal, and it counts both approvals and questions.
- `t3_thread_read {view:"activity"}` shows the request as an item:
  - `{type:"approval_request", status:"waiting", text:"<Claude's tool description>"}`
  - It sits next to `{type:"command_execution", status:"running", text:"$ touch t3-cardputer-canary.txt"}`.
  - The `view:"messages"` default doesn't show either one.
- `t3_pending_request_list` → `{"requestIds": []}`, so approvals are excluded, as documented.
- Fixture: `mcp-thread-list-waiting.json`, which holds all four captures above, taken while the approval was pending.

### Internal WS: subscribe to the thread, get the request as stream events

The client sends `orchestration.subscribeThread {threadId}`. The first `Chunk` value is `{kind:"snapshot", snapshotSequence, projection}`. A fresh thread's snapshot frame was ~12.7 KB. After that, every value is `{kind:"event", sequence, event}`.

A Claude command approval arrives as three events in one chunk (`ws-approval-frames.jsonl`, line 8; the resolution is line 14):

1. `node.updated`, with `payload.kind:"approval_request"` and `status:"waiting"`.
2. `runtime-request.updated`, whose `payload` is the request:
   ```json
   { "id": "runtime-request:provider:claudeAgent:…:native-request:toolu_…:<uuid>",
     "nodeId": "node:runtime-request:…", "providerTurnId": "…",
     "nativeRequestRef": {"driver":"claudeAgent","nativeId":"toolu_…","strength":"strong"},
     "kind": "command", "status": "pending",
     "responseCapability": {"type":"live","providerSessionId":"…"},
     "createdAt": "…", "resolvedAt": null }
   ```
3. `turn-item.updated`, with `payload.type:"approval_request"`, `requestId`, `requestKind:"command"`, `prompt` (Claude's own description of the tool call, e.g. "Create empty canary file in working directory"), and `status:"waiting"`.

The fields the device needs come from these places:

| Field | Where it lives |
|---|---|
| request id | `runtime-request.updated` → `payload.id`. This is the value to send back. It is long (333 chars here, nested URL-encoding), so treat it as opaque. |
| command text | **Not on the request.** It is on the `command_execution` turn item whose `nativeItemRef.nativeId` equals the request's `nativeRequestRef.nativeId` (`toolu_…`), in the field `input: "touch t3-cardputer-canary.txt"`. That item arrives in the same chunk, just before the request. |
| human summary | `turn-item.updated` (`approval_request`) → `prompt`. |
| cwd | **Not on the request.** It is the thread's `projection.thread.worktreePath` from the snapshot (for a scratch thread: `<home>/.t3/scratch/<slug>`). For a project thread with no worktree it is presumably null, so fall back to the project's `workspaceRoot`. |
| available decisions | Claude approvals carry **no `options`** (the field is absent in all 5 captures). The web UI then falls back to `cancel`, `decline`, `acceptForSession` ("Always allow this session"), and `accept` (`ComposerPendingApprovalActions.tsx`). Other providers (Codex MCP elicitation, Antigravity) do send `options`. |
| kind | `payload.kind`: `command` here. Other values: `file-read`, `file-change`, `mcp-elicitation`, `permission`, `user_input`, `dynamic_tool_call`, `auth_refresh`. |

On resolution, the server emits `runtime-request.updated` with `status:"resolved"`, `resolvedAt`, and `decision`. The `approval_request` item becomes `completed` (accept, acceptForSession, acceptAlways) or `cancelled` (decline, cancel).

A side finding: `true` ran **without** any approval, because Claude treats it as read-only. The canary needs a command that writes. The spike uses `touch t3-cardputer-canary.txt` inside the scratch folder. Task 14's canary must not use `true`.

## (b) `runtime-request.respond` payloads

Wire frame (Effect RPC JSON; ids are strings; every `Chunk` is followed by `{"_tag":"Ack","requestId":"<same>"}`):

```json
{"_tag":"Request","id":"2","tag":"orchestration.dispatchCommand","headers":[],
 "payload":{"type":"runtime-request.respond","commandId":"<random uuid v4>",
            "threadId":"mcp:<thread-uuid>","requestId":"<runtime-request id>","decision":"accept"}}
```

Reply: `{"_tag":"Exit","requestId":"2","exit":{"_tag":"Success","value":{"sequence":<n>}}}` in **7-17 ms** (5 runs). Then `t3_thread_wait` reported `completed` in every scenario.

| Intent | `decision` | Observed |
|---|---|---|
| approve once | `"accept"` | command ran; approval item `completed` |
| deny | `"decline"` | Claude gets "User declined tool execution." and does not retry; item `cancelled` |
| deny with reason | `"decline"`, **then** `t3_thread_send {threadId, message: reason, mode:"auto"}` | there is **no reason field**. An extra `reason` key was accepted (`Success`) and silently dropped, so Claude still saw only the generic decline. The follow-up send returned `delivery:"steered"` into the same run, and Claude obeyed it. |
| always allow (Claude) | `"acceptForSession"` | the first run was approved; the identical second `touch` ran with no second approval |
| `"acceptAlways"` (Claude) | **landmine** | Exit was `Success` and the item was marked `completed`, **but Claude was told "User declined tool execution."** `ClaudeAdapterV2.permissionResultFromDecision` maps anything other than `accept`/`acceptForSession` to deny. Never send `acceptAlways` to a Claude thread. |
| interrupt the turn | `"cancel"` | not exercised. Per source, it denies and sets `interrupt: true`. |

Server-side errors (from source) for a stale request: the dispatch fails when the request is not found, is no longer `pending`, or is `not_resumable`.

## (c) Auth, headless, for both surfaces

**Internal bearer** (used for WS):

1. `t3 auth pairing create --json --ttl 5m --label <label>` → `{id, credential, scopes, expiresAt}`. The credential is a 12-char one-time code. `t3 pair` gives the same thing with a QR code.
2. `POST /oauth/token`, `application/x-www-form-urlencoded`:
   ```
   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
   subject_token=<credential>
   subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
   requested_token_type=urn:ietf:params:oauth:token-type:access_token
   [scope=…] [client_label=…] [client_device_type=bot] [client_os=…]
   ```
   → `{access_token, issued_token_type, token_type:"Bearer", expires_in:2592000, scope}`. That is 30 days, with the pairing code's 13 default scopes.
3. WS auth, both measured:
   - `Authorization: Bearer` on the upgrade → **101**.
   - Or `POST /api/auth/websocket-ticket` (Bearer) → `{ticket, expiresAt}` (~300 s TTL), then `/ws?orchestrationProtocol=2&wsTicket=<ticket>`. Node 22's global `WebSocket` can't set headers, so the spike uses this route.
   - Failures: no auth → 401 or connection reset. MCP bearer on `/ws` → **401**, and on `/api/orchestration/shell` → 401 (by design, `EnvironmentAuth.ts`). Bad protocol version (99) → **426**. Missing `orchestrationProtocol` → connection reset.
   - An alternative with no pairing step: `t3 auth session issue --token-only --scope … --ttl …` mints a bearer directly. Not used here.

**MCP OAuth** (`/.well-known/oauth-authorization-server` advertises `grant_types_supported:["authorization_code"]`, PKCE S256, `token_endpoint_auth_method: none`):

1. `POST /oauth/mcp/register` with JSON `{client_name, redirect_uris:["http://127.0.0.1:<any port>/callback"]}` → 201 `{client_id, …}`. The client id is a signed blob, with no server state. Redirects must be https or loopback http; the loopback port is ignored when matching.
2. *(optional)* `GET /oauth/mcp/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&resource=<base>/mcp` → 302 to the web page `/connect-agent`. Headless clients skip this.
3. `POST /oauth/mcp/decision` with JSON `{authorization:{…same params…}, decision:{_tag:"pairing-code", access:"<level>", code:"<pairing credential>"}}` → `{redirectTo:"<redirect_uri>?code=…&state=…&iss=…"}`. The pairing code is consumed, and its scopes must cover the requested access.
4. `POST /oauth/mcp/token`, form: `grant_type=authorization_code&code&redirect_uri&client_id&code_verifier&resource` → `{access_token, token_type:"Bearer", expires_in:2592000, scope}`. The auth code lives 60 s.

**Refresh:** neither surface refreshes.
- MCP `grant_type=refresh_token` → 400 `unsupported_grant_type` "Only authorization_code is supported."
- The internal `/oauth/token` only does token exchange from a one-time pairing code.
- Both bearers last 30 days, then need a fresh pairing code. The relay must surface expiry loudly. A re-pair flow (`t3 auth pairing create` run on the homelab) is the only renewal.

Both kinds of session show up in `t3 auth session list` (label = pairing label for internal, `client_name` for MCP). Revoke them with `t3 auth session revoke <sessionId>`.

## (d) Access level needed to launch a `full-access` thread

Each level was tested with a `t3_thread_launch {scratch:true, runtimeMode:"full-access"}` (`access-levels.json` in the spike output):

| MCP access | Result |
|---|---|
| `read-only` | `capability_denied`: "this MCP client was approved for read-only access." |
| `approval-required` | `runtime_mode_escalation_denied`: "Child runtime mode full-access is broader than parent mode approval-required." |
| `auto-accept-edits` | `runtime_mode_escalation_denied` |
| `auto` | `runtime_mode_escalation_denied` |
| `full-access` | launched; `t3_thread_configuration.runtimeMode = "full-access"`; completed |

**Only `full-access`.** Scopes: `orchestration:read` + `orchestration:operate` + `settings:write` + `source-control:write`, and the session's `runtimeModeCeiling` is the access level (`EnvironmentAuth.mcpClientScopes`, `issueMcpClientSession`). A relay token at `approval-required` can launch and steer `approval-required` threads only. `t3_thread_send` has the same rule: the target can't have broader modes than the caller.

## (e) MCP list sizes and latency

10 calls each, loopback, read-only MCP token, default arguments. p95 is nearest-rank over 10 samples, so it equals the max. Raw per-call samples (`ms`, `bytes`, projects labelled `<project-N>`) are in `2026-10-20-approvals-spike.measure.json`, next to this receipt. The table is that run (2026-10-20 13:3x UTC).

| Call | Items | Bytes | Median ms | p95 ms |
|---|---|---|---|---|
| `t3_project_list` | 8 projects | 11,427 | 6.1 | 113.9 (one cold outlier; min 4.5) |
| `t3_thread_list {projectId}`, busiest project (`<project-3>`) | 50 of 57 (page cap, `nextCursor` set) | 73,590 | 17.6 | 21.5 |
| `t3_thread_list {projectId}`, scratch project (`<project-8>`) | 9 | 13,478 | 9.8 | 10.9 |
| `t3_thread_list {projectId}`, 6 projects | 0 | 356 | 6.6-8.2 | 6.7-9.8 |

- About **1.47 KB per thread** in the MCP list (73,590 B / 50). That is twice the spec's ~700 B estimate, which needs updating.
- About 1.4 KB per project.
- `t3_thread_list` without `projectId` fails for an MCP client outside a T3 thread (`target_required`), so the relay must iterate projects.
- An earlier run gave the same sizes, with latencies within a few ms (project list median 4.8, p95 43.8).

## (f) `modelSelection` defaults

The model catalog, by model id, from MCP `orchestrator_capabilities` (2026-10-20):

| providerInstanceId | usable | model ids |
|---|---|---|
| `claudeAgent` | yes | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-sonnet-5`, `claude-haiku-5-5` |
| `cursor` | no (not authenticated) | `grok-4.7`, `composer-2.5`, `gemini-4-argon`, `muse-wonder-1.0`, `gpt-5.6-sol`, `gpt-5.6-terra`, `claude-sonnet-5-5`, `gpt-5.6-luna`, `claude-haiku-5-5`, `glm-5p3`, `glm-5p3-flash`, `condor` |
| `grok` | no (disabled) | `grok-build` |
| `pi` | no (disabled) | `default` |
| `codex`, `opencode`, `antigravity`, `muse` | no (disabled) | none |

Project defaults such as `claude-opus-5` (seen in `mcp-project-list.json`) are stored per project. They are not catalog entries.

Both defaults were proven with a real turn. Each launched a scratch thread with the selection below and the message "Reply with the single word ok." (`models` phase). Then `t3_thread_wait` returned `completed`, and the run and reply were checked as follows:

- **repair:** `{"instanceId":"claudeAgent","model":"claude-opus-5-5"}`.
  - Run: `{status:"completed", providerInstanceId:"claudeAgent", model:"claude-opus-5-5"}`.
  - Reply: assistant message `ok`, with no error items.
- **canary** (cheapest usable: Haiku at low effort): `{"instanceId":"claudeAgent","model":"claude-haiku-5-5","options":[{"id":"effort","value":"low"}]}`.
  - Run: `{status:"completed", model:"claude-haiku-5-5"}`.
  - Reply: assistant message `ok`.
  - Every approval canary in this spike also ran on it.

`provider` is accepted as an alias for `instanceId` (`modelSelection.ts`). `options` is an array of `{id, value}`, and a legacy object form is also decoded.

## Scratch threads created (all `settled: true`, `archived: true`, verified via `t3_thread_read`)

1. approval: `true` (ran with no approval)
2. approval: approve (exploratory)
3. approval: approve (exploratory, MCP polling)
4. approval: deny
5. approval: deny with reason
6. approval: always (acceptForSession)
7. approval: acceptAlways
8. pending question (answered "Blue" via `t3_pending_request_respond`)
9. access: full-access (the other four levels were refused before creating a thread)
10. model: repair (idle, first round)
11. model: canary (idle, first round)
12. approval: approve (the run the fixtures come from)
13. model: repair, `claude-opus-5-5`, one "ok" turn (fix round 1)
14. model: canary, `claude-haiku-5-5`, one "ok" turn (fix round 1)
15. approval: approve (fix round 1: re-run check of the sequence below, in a scratch copy of the repo)
16. pending question (fix round 1: same re-run check, answered "Blue")

## Re-running

From the repo root, Node 22, no install. Raw captures and the token cache go to `$SPIKE_OUT` (default `/tmp/t3-spike/out`, mode 0700/0600). Override the server and CLI with `T3_BASE_URL` and `T3_BIN`. Each step mints pairing codes through the `t3` CLI and creates real scratch threads; every phase settles and archives what it creates.

To regenerate the fixtures, run these in this exact order. `fixtures` reads what the earlier steps leave in `$SPIKE_OUT`.

```
S=relay/spikes/approvals-spike.ts
npx -y tsx $S approvals approve    # writes approval-approve.json, ws-approve.jsonl, appends created-threads.jsonl
npx -y tsx $S measure              # writes mcp-project-list.raw.json (project ids for redaction) + docs/receipts/…measure.json
npx -y tsx $S question             # writes question.json; waits for the agent's question
RID=$(node -p 'require((process.env.SPIKE_OUT ?? "/tmp/t3-spike/out") + "/question.json").list.result.requestIds[0]')
                                   # same id is printed by `question` under list.result.requestIds[0]
npx -y tsx $S answer-question "$RID" '{"Red or blue?":"Blue"}'   # writes question-answer.json, settles/archives
npx -y tsx $S fixtures             # rewrites relay/test/fixtures/t3; needs the cached tokens for its leak check
npx -y tsx $S revoke               # revokes every t3-cardputer-spike* session, deletes the token cache
```

The sequence was verified end to end on 2026-10-20, from a clean `$SPIKE_OUT` in a scratch copy of the repo root. All six steps exited 0, and the regenerated fixtures had the same files and line counts as the committed ones.

- If `question` prints no `list` (the agent did not ask within 90 s), re-run it with the thread id from `created-threads.jsonl`: `question <threadId>`.
- Answers (a)-(f) also use these optional phases, run before `revoke`: `approvals [deny|deny-reason|always|accept-always]`, `access`, `models`, `probe`, `verify-cleanup`.
- `rm -rf "$SPIKE_OUT"` afterwards: it holds unredacted captures.
- `relay/spikes/` must be excluded from the relay build (Task 2).
- The internal protocol is unversioned beyond `orchestrationProtocol=2`. Re-run the sequence above after every T3 update.
