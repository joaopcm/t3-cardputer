# Device protocol, v1

Contract between the Cardputer firmware and the relay. Source of truth for the relay side is `relay/src/protocol/messages.ts`. Every fenced `json device` and `json relay` block below is parsed by `relay/test/protocol.test.ts`, so these examples cannot drift from the schemas.

## Transport

- One secure WebSocket (`wss`) to path `/v1/device`.
- Text frames: one JSON object per frame, UTF-8, with a string `type` field. Unknown `type`, unknown fields, missing required fields, or wrong types are rejected with `error {code:"bad_message"}`.
- Binary frames: raw audio, see "Audio".
- The relay sends a WebSocket ping every `heartbeatIntervalMs` (30 s by default) and drops a socket that leaves `heartbeatMaxMissed` (2) pings in a row without a pong. Answer pings with pongs (most WebSocket clients do this on their own); the drop looks like a network close, so reconnect with backoff.
- A device frame (text or binary) over 65536 bytes (`DEVICE_FRAME_BYTES_MAX`) closes the socket with 1009. No valid text frame comes near it.
- Relay text frames never exceed the `maxFrameBytes` the device declared in `hello`. If a view does not fit, the relay shrinks it and says so (`thread_page.truncated`, `projects.truncated`, a `request` truncation line) or, when even the shrunk view cannot fit, sends `error {code:"internal"}` naming `max_frame_bytes`; it never sends an oversize frame.
- Device-bound text (`lines`, `title`, `label`, `message`, ...) is printable ASCII only (0x20-0x7E), with `\n` allowed only where stated. The device font needs nothing else.
- JSON numbers are integers unless stated. `?` after a field name means optional: omit it, do not send `null`.

## Ordering

1. Device opens the socket and sends `hello` as its first frame, within `helloTimeoutMs` (10 s by default) or it gets `error {code:"hello_timeout"}` and close 4408 (a stalled link, not a bad token: keep the token and reconnect with backoff). A first frame that is not a `hello` (including garbage or a binary frame) gets `error {code:"bad_message", message:"first frame must be a valid hello"}` and close 4402. A `hello` that fails validation gets `error {code:"bad_message"}` naming the field, then close 4402. A `hello` with the wrong `v` gets `error {code:"protocol_version"}`, then close 4400. A `hello` whose token is missing from the relay, wrong, or revoked gets `error {code:"auth"}` and close 4401; 4401 means only that.
2. Relay answers `welcome`, then `home`. Nothing else is sent before `welcome`. `home` is immediate when the relay already watches T3 for another connection; otherwise it waits for the relay's first T3 poll, which a hung T3 can stretch. The wait is capped at `mcpRequestTimeoutMs` (30 s by default): past it the relay sends a `home` with no rows, `t3:"unreachable"`, and the warning `T3 slow: no answer within mcpRequestTimeoutMs=30000, home follows when it answers`, then the real `home` once T3 answers. Show a "connecting" screen between `welcome` and the first `home`.
3. After that either side may send at any time. The relay pushes `home`, `thread_page`, and `request` updates unprompted. `thread_page` is pushed for the thread last opened with `open_thread` or `page`, at the page the device is on (clamped if the reply got shorter), whenever that thread's status or latest activity changes.
4. Every device message with an `id` gets exactly one `ack` with the same `id`. If the message fails validation but still has a usable `id` (a string of 1 to 16 characters), the ack is `ack {ok:false, error}` and `error` names the field. Only a malformed frame with no usable `id` gets a bare `error {code:"bad_message"}`. The view the request produces (`thread_page`, `projects`, `transcript_final`, ...) follows as its own message. Do not depend on the order between an `ack` and its view message.
5. On reconnect the device sends `hello` again and gets `welcome` then `home`. Nothing is replayed, the relay sends full state. The open thread does not survive a reconnect either: a device that was showing a thread sends `open_thread` for it again after `welcome` to get its `thread_page` and pending `request` pushes back.

## Message ids

Every device message except `hello` carries `id`: a string of 1 to 16 characters. Ids are unique per device, across reconnects and reboots. For `reply`, `respond`, and `launch` the relay uses `id` as an idempotency key: a repeated `id` gets the original `ack` again and the action is not run twice, even when the repeat arrives on a new connection while the first is still running. The relay remembers an id for `idempotencyTtlMs` (24 h by default) and forgets everything when it restarts. `open_thread`, `page`, `list_projects`, and `refresh` only read, so a repeat runs again and sends a fresh view. Do not reuse an id for a different request. A counter that restarts at boot will collide; use random characters (8+ hex digits is plenty).

The relay remembers the result, not just the request: a `reply`, `respond`, or `launch` that got `ack {ok:false}` (T3 unreachable, request no longer pending, ...) gets that same failed ack again for 24 h if its `id` is repeated. To try again after a failure, send the request with a new `id`. Repeat an `id` only to recover an `ack` you never received (for example after a reconnect).

## Versioning

`PROTOCOL_VERSION = 1`. `hello.v` must equal the relay's version. On mismatch the relay sends `error {code:"protocol_version"}` and then closes the socket with code 4400. The relay checks `v` before anything else in `hello`, so a future `hello` shape never produces a confusing field error.

The `message` says which side to update, and the device shows it verbatim:

- `hello.v` lower than the relay's: `update firmware: device protocol v=1, relay v=2`
- `hello.v` higher than the relay's: `update relay: device protocol v=2, relay v=1`

The message always starts with `update firmware` or `update relay`, so firmware may also match on that prefix to pick a screen.

### Never changes

These stay as they are in every protocol version, so any device can reach this error against any relay:

- `hello.type` is the string `"hello"` and `hello.v` is a JSON integer. Their names and types never change. The relay reads them before looking at any other `hello` field.
- The mismatch reply is `{"type":"error","code":"protocol_version","message":<string>}`, then close 4400.
- Every frame the relay sends before `welcome` is at most 256 bytes (`PRE_WELCOME_FRAME_BYTES`), because the relay does not know the device's `maxFrameBytes` yet. The relay enforces this in code. A device's `maxFrameBytes` is never below 256, so these frames always fit.
- Error `message` text is cut to 120 characters and mapped to printable ASCII, so it fits that limit.

## Pairing

Before its first connection the device trades a one-time code (shown by `t3-cardputer-relay pair` on the relay host) for a token over plain HTTPS on the same host:

```json
POST /v1/pair
{"code":"7KQ2M9XA","name":"cardputer"}
```

- `200 {"token":"<device-token>"}`: store the token and send it in every `hello`.
- `401 {"error":"pairing failed"}`: the code is unknown, expired, already used, or the body is malformed. The relay does not say which.
- `429 {"error":"auth locked out: ..."}`: too many failures from this address; the message names the budget and when to retry.
- `413`: the body is over 1024 bytes (`PAIR_BODY_BYTES_MAX`).

`code` is the 8 characters as shown (case does not matter). `name` is 1-64 characters, the label `devices` lists.

## Close codes

| Code | Meaning | Device should |
| --- | --- | --- |
| 4400 | protocol version mismatch (preceded by `error protocol_version`) | stop reconnecting, show the error message ("update firmware" or "update relay") |
| 4401 | auth: the relay rejected the token (unknown, wrong, or revoked), preceded by `error auth`. Also sent mid-session, after `welcome`, when the device is revoked on the relay (`error auth` "device revoked, re-pair this device", then close 4401). Only a token problem closes with 4401 | stop reconnecting, show "re-pair", clear the stored token |
| 4402 | bad_hello: the first frame was not a `hello`, or `hello` failed validation (preceded by `error bad_message` naming the problem) | stop reconnecting, show the error message; firmware bug or incompatible build, re-pairing will not help |
| 4408 | hello_timeout: no `hello` within `helloTimeoutMs` (preceded by `error hello_timeout` naming the budget), usually a stalled hotspot | keep the token, reconnect with backoff |
| 4000 | replaced: a newer connection from the same device took over | stop reconnecting, show "replaced by another connection" |

Any other close (network drop, relay restart) is reconnected with backoff.

## Errors

`error { code, message }`. `message` is printable ASCII and meant to be shown on screen. `code` is one of:

| Code | When |
| --- | --- |
| `protocol_version` | `hello.v` is not 1. Followed by close 4400. |
| `auth` | token rejected, or (any time after `welcome`) the device was revoked. Followed by close 4401. |
| `hello_timeout` | no `hello` within `helloTimeoutMs`. Followed by close 4408. |
| `bad_message` | a text frame failed validation and has no usable `id` (see Ordering rule 4), or a first frame that is not a valid `hello` (then followed by close 4402). `message` names the field path. Otherwise the socket stays open. |
| `audio_not_started` | binary frame with no open audio window (before `audio_start`, or after `audio_end`, `audio_cancel`, or a budget error). The frame is dropped and the socket stays open. |
| `bad_audio` | an empty or odd-length binary frame (dropped, the window stays open), or an audio budget was hit (the window is closed and the buffer thrown away, see "Audio"). `message` names the budget. The socket stays open. |
| `internal` | relay failure not caused by the device. The socket stays open. |

Failures of a specific request (invalid fields, thread not found, T3 down, reply too long for T3) come back as `ack {ok:false, error}`, not as `error`, whenever the request had a usable `id`.

## Device to relay

### hello

First frame on every connection. Declares the screen and the receive budget. Has no `id`.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"hello"` | yes | |
| `v` | int | yes | must be 1 |
| `token` | string | yes | 1-256 chars, issued at pairing |
| `fw` | string | yes | 1-32 chars, firmware version |
| `cols` | int | yes | 1-255, characters per screen row |
| `bodyRows` | int | yes | 1-64, rows available for body text |
| `maxFrameBytes` | int | yes | 256-1048576, largest text frame the device can receive |
| `maxHomeRows` | int | yes | 1-255, most home rows the device can show |

```json device
{"type":"hello","v":1,"token":"<device-token>","fw":"0.1.0","cols":40,"bodyRows":11,"maxFrameBytes":4096,"maxHomeRows":8}
```

### open_thread

Open a thread. Answered by `ack`, then `thread_page` with `page` 1.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"open_thread"` | yes | |
| `id` | string | yes | 1-16 chars |
| `threadId` | string | yes | 1-128 chars, taken from a `home` row |

```json device
{"type":"open_thread","id":"a1b2c3d4","threadId":"thr_01"}
```

### page

Ask for another page of an open thread. Answered by `ack`, then `thread_page`.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"page"` | yes | |
| `id` | string | yes | 1-16 chars |
| `threadId` | string | yes | 1-128 chars |
| `page` | int | yes | 1-based, >= 1. Past the last page the relay acks `ok:false`. |

```json device
{"type":"page","id":"a1b2c3d5","threadId":"thr_01","page":2}
```

### reply

Send a message into a thread. `queue` waits for the running turn to finish, `steer` delivers the message into the running turn (T3 `steer`), it does not interrupt.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"reply"` | yes | |
| `id` | string | yes | 1-16 chars |
| `threadId` | string | yes | 1-128 chars |
| `text` | string | yes | 1-4000 chars |
| `mode` | `"queue"` or `"steer"` | yes | |

```json device
{"type":"reply","id":"a1b2c3d6","threadId":"thr_01","text":"yes, go ahead","mode":"queue"}
```

### respond

Answer a `request`. `requestId` and `value` come from the `request` message and the chosen option. `text` is only for `deny_with_reason` (the reason) and free-text question answers.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"respond"` | yes | |
| `id` | string | yes | 1-16 chars |
| `threadId` | string | yes | 1-128 chars |
| `requestId` | string | yes | 1-128 chars, the opaque handle from `request.requestId` |
| `value` | string | yes | 1-128 chars, from `request.options[].value` |
| `text?` | string | no | 1-1000 chars |

```json device
{"type":"respond","id":"a1b2c3d7","threadId":"thr_01","requestId":"req_9","value":"allow_once"}
```

```json device
{"type":"respond","id":"a1b2c3d8","threadId":"thr_01","requestId":"req_9","value":"deny_with_reason","text":"use the staging db instead"}
```

### launch

Start a new thread in a project. Omitted `model`, `workspace`, `runtimeMode` use the project's `defaults` from `projects`.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"launch"` | yes | |
| `id` | string | yes | 1-16 chars |
| `projectId` | string | yes | 1-128 chars, from `projects` |
| `text` | string | yes | 1-4000 chars, the first prompt |
| `model?` | string | no | 1-128 chars, a model id from `projects.models[].id` or `projects.defaults.model` |
| `workspace?` | `"root"` or `"worktree"` | no | |
| `runtimeMode?` | string | no | `"approval-required"`, `"auto-accept-edits"`, `"auto"`, or `"full-access"` |

```json device
{"type":"launch","id":"a1b2c3d9","projectId":"proj_1","text":"fix the flaky test in auth","workspace":"worktree","runtimeMode":"approval-required"}
```

### list_projects

Ask for the project list. Answered by `ack`, then `projects`.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"list_projects"` | yes | |
| `id` | string | yes | 1-16 chars |

```json device
{"type":"list_projects","id":"a1b2c3da"}
```

### refresh

The `R` key. Answered by `ack`, then `home` (sent even when it did not change), then, if a thread is open (the last `open_thread` or `page`), its `thread_page` at the page the device is on and its pending `request`, if any. Built from the relay's latest view of T3, which is at most `pollIntervalMs` (2 s by default) old.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"refresh"` | yes | |
| `id` | string | yes | 1-16 chars |

```json device
{"type":"refresh","id":"a1b2c3de"}
```

### audio_start

Open an audio window. Binary frames are accepted from now until `audio_end` or `audio_cancel`.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"audio_start"` | yes | |
| `id` | string | yes | 1-16 chars |
| `sampleRate` | int | yes | must be 16000 |

```json device
{"type":"audio_start","id":"a1b2c3db","sampleRate":16000}
```

### audio_end

Close the audio window and transcribe what was sent. Answered by `ack`, then `transcript_final`.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"audio_end"` | yes | |
| `id` | string | yes | 1-16 chars |

```json device
{"type":"audio_end","id":"a1b2c3dc"}
```

### audio_cancel

Close the audio window and throw the audio away. No transcript follows.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"audio_cancel"` | yes | |
| `id` | string | yes | 1-16 chars |

```json device
{"type":"audio_cancel","id":"a1b2c3dd"}
```

### Audio

Binary frames carry raw PCM: signed 16-bit little-endian, mono, 16000 Hz, no header. A frame must be non-empty, an even number of bytes, and at most 65536 bytes (`DEVICE_FRAME_BYTES_MAX`, 2.05 s of audio; a larger frame closes the socket with 1009). Chunk size within that is the device's choice; the simulator sends 100 ms (3200 byte) chunks in real time.

Binary frames are only accepted between `audio_start` and `audio_end` or `audio_cancel`. The relay handles frames in the order they arrive and opens the window as soon as it reads `audio_start`, so the device may stream audio right after `audio_start` without waiting for its `ack`. If that `ack` comes back `ok:false` (a window was already open), send `audio_cancel` and drop the recording; audio sent in the meantime went to the window that was already open. Any other binary frame gets `error {code:"audio_not_started"}` and is dropped. An empty or odd-length frame gets `error {code:"bad_audio"}` and is dropped; the window stays open.

`audio_start` while a window is already open gets `ack {ok:false}`. `audio_end` with no frames gets `ack {ok:false, error:"no audio received"}`. `audio_cancel` always gets `ack {ok:true}`.

Two budgets close the window and drop the buffer. Each sends `error {code:"bad_audio"}` naming the budget, and the next `audio_end` is answered with `ack {ok:false}` carrying the same message:

- `audio_max_seconds` (120 by default): `audio budget: audio_max_seconds=120, recording reached 120s`.
- `audio_idle_timeout_ms` (5000 by default, pending plan 2): `audio budget: audio_idle_timeout_ms=5000, no audio frame for 5000ms, recording dropped`. The timer starts at `audio_start` and restarts on every frame. No transcript follows.

After `audio_end` the relay sends `ack {ok:true}`, then `transcript_final` when whisper.cpp is done (seconds for a 10 s clip). If transcription fails, an `error {code:"internal"}` follows the ack instead. A `home` warning reads `voice down: ...` while the local whisper-server is in a crash loop; it names `whisperRestartsPerWindow` and `whisperRestartWindowMs`.

## Relay to device

### welcome

First frame from the relay, after a valid `hello`.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"welcome"` | yes | |
| `v` | int | yes | relay protocol version, 1 |
| `relay` | string | yes | relay software version |

```json relay
{"type":"welcome","v":1,"relay":"0.1.0"}
```

### ack

Result of one device message.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"ack"` | yes | |
| `id` | string | yes | the device message's `id` |
| `ok` | bool | yes | |
| `error?` | string | no | printable ASCII, present when `ok` is false |

```json relay
{"type":"ack","id":"a1b2c3d6","ok":true}
```

```json relay
{"type":"ack","id":"a1b2c3d6","ok":false,"error":"thread not found"}
```

### home

The home screen: threads that need attention first. Sent after `welcome` and again whenever anything in it changes, including an `age` text (so the device never needs a clock to keep ages current).

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"home"` | yes | |
| `rows` | HomeRow[] | yes | at most `hello.maxHomeRows`, already in display order |
| `counts` | object | yes | `{needs, running, done}`, ints >= 0, counts over all threads, not just `rows` (see buckets below) |
| `approvals` | object | yes | `{available: bool, reason?: string}`; when `available` is false the device must not offer approvals and shows `reason` |
| `warnings` | string[] | yes | short printable ASCII notices for the status bar, may be empty |
| `t3` | `"ok"` or `"unreachable"` | yes | whether the relay can reach T3 right now |

HomeRow: `{threadId, kind, project, title, age}`

| Field | Type | Constraint |
| --- | --- | --- |
| `threadId` | string | 1-128 chars |
| `kind` | string | `"approval"`, `"question"`, `"failed"`, `"running"`, or `"done"` |
| `project` | string | printable ASCII, already shortened to fit |
| `title` | string | printable ASCII, already shortened to fit |
| `age` | string | 1-4 printable ASCII chars, time since the last activity, already drawn (see below) |

Buckets and `counts`: `needs` counts rows of kind `approval`, `question`, and `failed` (T3 statuses `failed`, `interrupted`, `cancelled`, plus any status the relay does not know, which also adds a warning). `running` counts kind `running` (T3 statuses `preparing`, `queued`, `starting`, `running` with nothing pending). `done` counts kind `done` (status `completed`, last activity within 24 hours; older completed threads are not on home at all). `rows` lists `needs` first: approvals, then questions, then failures, each oldest first so the longest wait is on top. Then `running`, then `done`, both newest first.

Kind markers, all ASCII: `approval` is `!`, `question` is `?`, `failed` is `x`, `running` is `*`, `done` is `-`. The device draws no section headers inside `rows`; if it wants headers like the mockup's `NEEDS YOU (2)` / `RUNNING (3)` / `DONE (5)`, it takes the numbers from `counts` and must leave room for them when it declares `maxHomeRows` (`bodyRows - 3` leaves room for all three).

Age format: the relay draws it, so device and relay can never disagree about when the text changes (the relay re-sends home exactly then). With `s` the whole seconds since the last activity: `s < 60` draws `<s>s` (`0s` to `59s`); `s < 3600` draws `<floor(s/60)>m` (`1m` to `59m`); `s < 86400` draws `<floor(s/3600)>h` (`1h` to `23h`); otherwise `<floor(s/86400)>d`, capped at `999d`. It is never wider than 4 columns.

Row layout, shared by firmware and relay: the device draws one row per line as `<marker> <project> <title> <age>`. `marker` is 1 column, `age` is right-aligned in 4 columns, and there are 3 single-space separators, so 8 columns are fixed. The relay clips `project` to at most `floor(cols / 3)` columns and `title` to `cols - 8 - len(project)` columns, both at least 1. Clipped text ends with `~`, so a row never needs the device to cut it.

```json relay
{"type":"home","rows":[{"threadId":"thr_01","kind":"approval","project":"api","title":"run migration","age":"42s"},{"threadId":"thr_02","kind":"running","project":"web","title":"fix flaky test","age":"5m"}],"counts":{"needs":1,"running":1,"done":6},"approvals":{"available":true},"warnings":[],"t3":"ok"}
```

### thread_page

One page of a thread, already wrapped to `cols` and cut to at most `bodyRows` lines.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"thread_page"` | yes | |
| `threadId` | string | yes | |
| `header` | object | yes | `{project, title, model, status}`, all printable ASCII strings; `status` is T3's thread status as text |
| `page` | int | yes | 1-based |
| `pages` | int | yes | total pages, >= 1 |
| `lines` | string[] | yes | each at most `cols` chars, printable ASCII |
| `truncated?` | object | no | `{budget: string, limit: int, actual: int}`; present when the reply was cut: `budget` names the limit hit, `limit` is its value, `actual` is what was needed |

```json relay
{"type":"thread_page","threadId":"thr_01","header":{"project":"api","title":"run migration","model":"claude-opus-5","status":"running"},"page":1,"pages":3,"lines":["I ran the migration on a copy of the","database first. It adds two columns and","backfills them in batches of 500."]}
```

```json relay
{"type":"thread_page","threadId":"thr_02","header":{"project":"web","title":"fix flaky test","model":"claude-opus-5","status":"done"},"page":32,"pages":32,"lines":["...end of what fits..."],"truncated":{"budget":"max_reply_pages","limit":32,"actual":57}}
```

### request

A thread is waiting on the user. The device shows `lines` and the `options`, then answers with `respond`.

The relay sends `request` after the `thread_page` of an `open_thread` when that thread is waiting, and again whenever a new request shows up on the open thread. The `requestId` is a handle the relay makes up, not T3's own id (T3 ids run past 300 characters). It stays the same while the request is pending, so a re-sent `request` carries the same value. A `respond` whose handle is no longer pending gets `ack {ok:false}` with the error `request no longer pending, refresh`. A T3 question can hold several questions under one `requestId`: the relay sends them one at a time with the same `requestId`, each `respond` answers the question on screen, and T3 gets all the answers after the last one.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"request"` | yes | |
| `threadId` | string | yes | |
| `requestId` | string | yes | opaque handle, 1-128 chars, chosen by the relay with no shape guarantees; echo it in `respond.requestId` |
| `kind` | `"approval"` or `"question"` | yes | |
| `lines` | string[] | yes | wrapped to `cols`, printable ASCII |
| `options` | Option[] | yes | |

Option: `{key, label, value}`. `key` is one character, the key the user presses; `label` is 1-64 printable ASCII chars; `value` is 1-128 chars, echoed in `respond.value`.

Fit rule: the device draws `lines`, then one row per option. The relay keeps `lines.length + options.length <= bodyRows` (at least one line) and the whole frame within `maxFrameBytes`, so every request fits one screen. When the text is longer, the relay cuts it and ends `lines` with a notice that names the budget that cut it, wrapped to `cols`: `command truncated: 113 more lines, bodyRows=11` for an approval, `question truncated: ...` for a question, or `..., maxFrameBytes=4096` when bytes, not rows, were the limit. Options are never cut, and a question's notes (`(showing 9 of 12 options, T to type another)`, `(pick one)`) stay after the notice. If even the options alone do not fit `maxFrameBytes`, the relay sends `error {code:"internal"}` naming `max_frame_bytes` once for that request instead of the request. A device should still accept a `request` taller than `bodyRows` (a question with more options than rows can produce one) and scroll it, with every option reachable, rather than reject the frame.

- Approval requests use keys `Y` (value `allow_once`), `A` (`allow_always`), `N` (`deny`), `T` (`deny_with_reason`). On `T` the device asks for a reason and sends it as `respond.text`.
- Question requests use keys `1` to `9` for the choices. Whenever free text is allowed (a question with no choices, or more choices than fit in keys `1` to `9`), `options` carries an explicit entry `{key:"T", label:"Type answer", value:"text"}`. On `T` the device collects text and sends `respond` with `value` `"text"` and the answer in `respond.text`. A device should also treat a question whose `options` list is empty as free text, so it never shows a screen with nothing to press.

```json relay
{"type":"request","threadId":"thr_01","requestId":"req_9","kind":"approval","lines":["Run shell command?","","  pnpm db:migrate"],"options":[{"key":"Y","label":"Allow once","value":"allow_once"},{"key":"A","label":"Always allow","value":"allow_always"},{"key":"N","label":"Deny","value":"deny"},{"key":"T","label":"Deny, say why","value":"deny_with_reason"}]}
```

```json relay
{"type":"request","threadId":"thr_02","requestId":"req_10","kind":"approval","lines":["cat <<'EOF' > seed.sql","INSERT INTO users VALUES (0, 'a');","INSERT INTO users VALUES (1, 'b');","INSERT INTO users VALUES (2, 'c');","INSERT INTO users VALUES (3, 'd');","command truncated: 115 more lines,","bodyRows=11"],"options":[{"key":"Y","label":"Allow once","value":"allow_once"},{"key":"A","label":"Always allow","value":"allow_always"},{"key":"N","label":"Deny","value":"deny"},{"key":"T","label":"Deny, say why","value":"deny_with_reason"}]}
```

```json relay
{"type":"request","threadId":"thr_03","requestId":"req_12","kind":"question","lines":["Which database should I use?"],"options":[{"key":"1","label":"staging","value":"staging"},{"key":"2","label":"local","value":"local"}]}
```

```json relay
{"type":"request","threadId":"thr_04","requestId":"req_13","kind":"question","lines":["Why did the test fail?"],"options":[{"key":"T","label":"Type answer","value":"text"}]}
```

### projects

Projects the device can launch into, with the defaults a `launch` gets when it omits a field, and the models a `launch` may name. Sorted most recently active first (latest thread activity in the project, else the project's own update time), already in display order.

The list fits the same budgets as home: at most `hello.maxHomeRows` items (and the relay's own `maxHomeRows` limit, whichever is lower), and a frame within `maxFrameBytes`. When projects are left out, `truncated` says how many and which budget did it; the device shows it under the list, for example `+32 more projects: maxHomeRows=8, needed 40`. Left-out projects are the least recently active ones.

`models` are the models T3 can run now, in catalog order: only provider instances with no constraints (not disabled, installed, signed in), each id once even when two instances offer it. `label` is T3's own label as printable ASCII, 1-24 chars, clipped with a trailing `~`; `id` is what `launch.model` takes. The relay remembers which provider instance offers each id and launches on it; the device never sees instances. The list shares the frame budget with the projects: it is kept whole while at least one project fits beside it, and cut from the end only when it would otherwise push every project out. `models` is absent when T3 offers none. A device with no `models` offers only the project's default model. When the relay cannot read T3's catalog it sends `projects` without `models` and adds `model list unavailable: <why>` to the `warnings` of the next `home`; launching is not blocked.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"projects"` | yes | |
| `items` | object[] | yes | `{projectId, name, defaults: {model, workspace, runtimeMode}}`; `workspace` is `"root"` or `"worktree"`, `runtimeMode` is one of the four launch values |
| `models?` | object[] | no | `{id, label}`; `id` is 1-128 chars, `label` 1-24 printable ASCII chars |
| `truncated?` | object | no | `{budget: string, limit: int, actual: int, hidden: int}`; present when projects were left out: `budget` is `maxHomeRows` or `maxFrameBytes`, `limit` its value, `actual` what all projects needed (a count for `maxHomeRows`, bytes for `maxFrameBytes`), `hidden` how many projects are not in `items` |

```json relay
{"type":"projects","items":[{"projectId":"proj_1","name":"api","defaults":{"model":"claude-opus-5","workspace":"worktree","runtimeMode":"approval-required"}}]}
```

```json relay
{"type":"projects","items":[{"projectId":"proj_1","name":"api","defaults":{"model":"claude-opus-5","workspace":"worktree","runtimeMode":"approval-required"}}],"models":[{"id":"claude-opus-5-5","label":"Claude Opus 5.5"},{"id":"claude-sonnet-5-5","label":"Claude Sonnet 5.5"},{"id":"claude-haiku-5-5","label":"Claude Haiku 5.5"}]}
```

```json relay
{"type":"projects","items":[{"projectId":"proj_7","name":"web","defaults":{"model":"claude-opus-5","workspace":"worktree","runtimeMode":"approval-required"}},{"projectId":"proj_1","name":"api","defaults":{"model":"claude-opus-5","workspace":"root","runtimeMode":"auto"}}],"truncated":{"budget":"maxHomeRows","limit":2,"actual":40,"hidden":38}}
```

### transcript_partial

Optional running transcript while audio is still open. Zero or more may arrive; each replaces the previous one.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"transcript_partial"` | yes | |
| `text` | string | yes | printable ASCII |

```json relay
{"type":"transcript_partial","text":"fix the flaky"}
```

### transcript_final

Final transcript after `audio_end`. The device puts it in the input line for the user to edit and send.

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"transcript_final"` | yes | |
| `text` | string | yes | printable ASCII |

```json relay
{"type":"transcript_final","text":"fix the flaky test in auth"}
```

### error

See "Errors".

| Field | Type | Req | Constraint |
| --- | --- | --- | --- |
| `type` | `"error"` | yes | |
| `code` | string | yes | `protocol_version`, `auth`, `hello_timeout`, `bad_message`, `bad_audio`, `audio_not_started`, or `internal` |
| `message` | string | yes | printable ASCII |

```json relay
{"type":"error","code":"protocol_version","message":"update relay: device protocol v=2, relay v=1"}
```
