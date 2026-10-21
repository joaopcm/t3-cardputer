# Using it

The bottom line of every screen lists the keys that work there. This page is the longer version.

The arrows are Fn plus `;` (up), `.` (down), `,` (left) and `/` (right). Screens show them as `^v` and `<>`. Esc is Fn plus `` ` ``. Bksp is the backspace key.

The screen dims after 30 seconds without a key and turns off after 60, except while you're typing or recording. The first key on a dark screen only wakes it.

## Home

![Home: threads grouped by needs you, running and done today](images/home.png)

Threads from every T3 project, in three groups: needs you, running and done today. In the needs you group, `!` is an approval and `?` is a question. The time on the right is how long ago the thread last changed. The top right says `online`, or what's wrong (`T3 unreachable`, `approvals down`, `2 warnings`). Warnings are listed at the top of Home, above the threads.

- `^v` moves, Enter opens the thread.
- N starts a new task.
- R refreshes.
- Fn+S opens setup.

## Approvals and questions

![An approval: run pnpm db:migrate, with Y, A, N and T](images/approval.png)

Opening a thread that's waiting shows what it wants first.

- Y allows once, A always allows, N denies.
- T denies and asks why. Type the reason and press Enter, T3 gets it as the next message.
- Questions list their answers as 1 to 9. T, when shown, lets you type an answer.
- Enter goes to the thread without answering. Tab comes back to the request from the thread.

If someone answers in T3 first, the ADV says `already answered`.

## Threads

![A thread: the last reply and an empty reply line](images/thread.png)

The newest reply, in pages. `^v` pages through it.

Start typing to reply.

- Enter queues the reply. T3 sends it when the running turn finishes.
- Fn+Enter steers: the reply goes into the running turn without stopping it.
- Bksp deletes, and goes back to Home on an empty line.

A reply the relay didn't confirm comes back to the reply line (`unsent reply back, Enter sends it`), so nothing you typed gets lost.

## Voice

![Voice: recording a reply while the transcript fills in](images/voice.png)

Hold `` ` `` in a thread or on the new task prompt and talk. Let go to stop. The relay takes up to 120 seconds per recording (`audioMaxSeconds`) and transcribes it with whisper.cpp on your machine.

- Enter sends the transcript (Fn+Enter steers, like a typed reply).
- E puts it on the reply line so you can edit it first.
- Hold `` ` `` again to add more.
- Bksp throws it away.

## New task

![New task: project, model, workspace, mode and the prompt](images/new-task.png)

N on Home lists your T3 projects. Pick one with `^v` and Enter.

Type the prompt, or hold `` ` `` to say it. The project's defaults for model, workspace and mode are preselected. Tab moves through them and `<>` changes the selected one. Enter starts the task, and it shows up on Home.

## Setup

Fn+S from Home. The install page fills all of it in, so you only need setup to change something.

- WiFi: `^v` picks a network, Enter joins, R scans again, D forgets a saved one. The ADV only sees 2.4 GHz networks.
- Relay: the `relay` row in the network list. Enter on it to type a relay URL. A different URL clears the device token, because the token belongs to the old relay.
- Pair: Tab from the network list. Run `t3-cardputer-relay pair` on the relay's machine and type the 8-character code it prints.
