# Troubleshooting

Every failure names itself. Find the start of the text you see in the first column. `…` stands for the part that changes, like a network name or a number.

Commands run on the T3 machine, where the relay lives. When a fix says "check the logs":

- Linux: `journalctl --user -u t3-cardputer-relay -n 50`
- macOS: `tail -n 50 ~/Library/Logs/t3-cardputer/relay.log`

## On the ADV

### Connection

| On screen | What it means | Fix |
| --- | --- | --- |
| `relay unreachable:` | The ADV can't reach the relay. The rest of the line says why. Often the T3 machine is asleep or off: a laptop that sleeps takes the relay with it. | Wake the machine, the ADV retries by itself. If it stays, check that `curl -s http://127.0.0.1:8787/healthz` prints `ok` and that `tailscale funnel status` lists port 8443. |
| `connecting, last:` | The ADV is trying again. After `last:` is the failure from the try before. | Same as `relay unreachable`. |
| `tls_heap=` | The ADV had no free memory block big enough for the TLS handshake. `largest block` is what it had. | It retries by itself. If it keeps showing, restart the ADV and open an issue with the whole line. |
| `wifi down` | The ADV lost WiFi. | It rejoins a saved network by itself. Fn+S picks another one. |
| `wifi: no saved network, Fn+S adds one` | No WiFi saved on the ADV. | Fn+S and pick a network, or send one from the install page. |
| `wifi: no saved network in range` | None of the saved networks is around. | Fn+S and add the one you're on. |
| `wifi:` … `wrong password` | The network turned the password down. | Fn+S, pick the network and type the password again. |
| `wifi:` … `network not found` | The network isn't in range, or it's 5 GHz only. The ADV only does 2.4 GHz. | Use a 2.4 GHz network or a phone hotspot. |
| `wifi:` … `no ip within kWifiJoinWaitMs=` | The ADV joined but never got an address. Networks with a login page (hotels, guest WiFi) do this. | Use a network without a login page, or a phone hotspot. |
| `replaced by another connection` | Something else connected with this ADV's token, usually `t3-cardputer-relay sim`. The ADV stops trying. | Stop the other one, then restart the ADV. |
| `update firmware` | The relay speaks a newer protocol than the firmware. The ADV stops trying. | `t3-cardputer-relay install-link`, open the link and install with clean install off. Your settings stay. |
| `update relay` | The firmware is newer than the relay. The ADV stops trying. | `t3-cardputer-relay update`, then restart the ADV. |
| `wifi: scan failed:` | The WiFi chip couldn't scan. | R scans again. If it repeats, restart the ADV. |
| `wifi:` … `join did not start:` | The WiFi chip turned the join down before trying. | Restart the ADV. If it repeats, open an issue with the whole line. |
| `wifi join failed` | Joining from setup failed with no reason. | Fn+S and try again. |
| `wifi not forgotten` | D couldn't remove the saved network. | Restart the ADV and try again. |
| `closed ` | The relay closed the link with that code and no message. After `relay unreachable:` it's a network drop and the ADV retries. On its own, the ADV stopped. | For a 44xx code, see [close codes](protocol.md#close-codes), fix that, then restart the ADV. |
| `relay error` | The relay sent an error with no message. | Check the logs. |
| `relay failed:` | The relay hit an error of its own, not caused by the ADV. | Check the logs. If it repeats, open an issue with the line. |

### Relay URL and pairing

| On screen | What it means | Fix |
| --- | --- | --- |
| `relay: not set, open the install link from setup.sh or type the relay url` | A fresh ADV with no relay URL. | Open the install link from setup. To type the URL instead, get it on the relay's machine: `tailscale funnel status` shows it, and so does `publicUrl` in `~/.config/t3-cardputer/relay.json`. |
| `relay url must be https:// or wss://` | The typed URL starts with another scheme. | Start it with `https://`, or leave the scheme out. |
| `relay url:` | The typed URL isn't a valid host and port. The rest of the line says what's wrong. | Type `https://<machine>.<tailnet>.ts.net:8443` with nothing after the port. |
| `relay changed: token cleared, pair again` | You set a different relay URL. The old token belongs to the old relay, so the ADV dropped it. | On the new relay, `t3-cardputer-relay install-link` and open the link. Or `t3-cardputer-relay pair` and type the code. |
| `pair: code expired or used, run t3-cardputer-relay install-link and open the new link` | The code from the install link ran out. Codes last 10 minutes and work once. | Do what it says. |
| `pairing failed (` | The relay turned a typed code down (`401`): wrong, expired or already used. | `t3-cardputer-relay pair` prints a new one. Type it within 10 minutes, case doesn't matter. |
| `auth locked out:` | 20 wrong codes from your network within 10 minutes. | Wait out the `retry in` time, then pair with a fresh code. |
| `pairing refused:` | The ADV already has a token and is using it. | Nothing. Pair only after `re-pair needed`. |
| `pairing already running` | A pairing request is still out. | Wait for it to finish. |
| `provisioned pair code not used:` | The install page sent a code, but the ADV is already paired, or you're typing one. | Nothing. |
| `pair:` | Followed by an `ESP_ERR_` name: the pairing request never reached the relay. Nothing tries it again. | Check that `curl -s http://127.0.0.1:8787/healthz` prints `ok` on the relay's machine and that `tailscale funnel status` lists port 8443. Then pair again. |
| ends in `, run t3-cardputer-relay install-link or pair` | The code from the install link didn't go through: a network error, or the relay answered `429` or `5xx`. The ADV doesn't try again and the code is spent. | Fix what the start of the line says. Then run `t3-cardputer-relay install-link` and open the new link, or run `t3-cardputer-relay pair` and type the code. |
| `token not saved` | Pairing worked but the ADV couldn't store the token. | Restart the ADV and pair again. If it repeats, install with clean install on. |
| `re-pair needed` | The relay turned the ADV's token down. It was revoked, or the relay's `secrets.json` was reset. | `t3-cardputer-relay pair`, then type the code on the pairing screen. |
| `device revoked, re-pair this device` | Someone ran `t3-cardputer-relay revoke` for this ADV. | Same as `re-pair needed`. |

### Home

| On screen | What it means | Fix |
| --- | --- | --- |
| `T3 unreachable` | The relay can't reach T3 Code. | Start T3 Code. Home comes back on the next poll. |
| `T3 slow: no answer within mcpRequestTimeoutMs=` | T3 took longer than the budget to answer. | Usually T3 is still starting. If it stays, restart T3 and check the logs. |
| `T3 poll failed:` | The relay's poll of T3 failed. The rest of the line says why. | Check the logs. |
| `T3 tokens expire in` | The relay's two T3 tokens last 30 days and don't refresh. Home warns 5 days ahead. | `t3-cardputer-relay renew` |
| `T3 tokens expired:` | They ran out. | `t3-cardputer-relay renew` |
| `T3 token rejected: run t3-cardputer-relay renew` | T3 turned a token down, revoked or expired. | `t3-cardputer-relay renew` |
| `approvals down` | The relay can't answer approvals. Usually a T3 update changed what the relay talks to. `, checking again` means the canary is checking. | `t3-cardputer-relay update`. If the newest release still shows it, open an issue with the whole line. |
| `approvals unreachable:` | The relay can't open T3's approvals socket. | Usually T3 is restarting. If it stays, check the logs. |
| `model list unavailable:` | New task couldn't load T3's models. | `t3-cardputer-relay models` shows what the relay sees. Check T3's provider settings. |
| `kWarningsMax=` | More warnings than Home has room for. | Fix the ones shown, the rest show up after. |
| `unknown thread status` | T3 sent a thread status this relay doesn't know. | `t3-cardputer-relay update`. If it stays, open an issue. |
| `unparseable updatedAt on` | T3 sent a thread time this relay can't read. | Same as above. |

### Threads, approvals and voice

| On screen | What it means | Fix |
| --- | --- | --- |
| `request waiting:` | A thread needs an answer. | Open it from Home, or Tab if you're in that thread. |
| `request no longer pending, refresh` | The request was answered or went away before your answer arrived. | R refreshes. |
| `already answered` | Someone answered it in T3 first. | Nothing. |
| `unsent reply back, Enter sends it` | The relay never confirmed your reply, so the ADV put it back on the reply line. | Enter sends it again. |
| `not confirmed, resending on reconnect` | The link dropped before the relay confirmed. | Nothing. The ADV sends it again when it's back. |
| `unacked_max` | 8 replies or answers are waiting for the relay to confirm them. | Wait for the link to come back, then send. |
| `reply_text_max=` | The reply is over 4000 characters. | Send it in two parts. |
| `launch_text_max=` | The new task prompt is over 4000 characters. | Shorten it. Send the rest as a reply once the task runs. |
| `refused:` | The relay turned down a reply, an answer or a new task. The rest of the line says why. | Depends on the reason. The ADV keeps your text where it can, so you can send it again. |
| `saved answer to` | An answer the ADV was holding for a thread that isn't waiting anymore. | Nothing. The thread moved on without it. |
| `out of memory on resend, may have gone through` | The ADV couldn't resend a reply after reconnecting. | Check the thread before sending it again. |
| `unacked_bytes_max` | Replies waiting for the relay to confirm them add up to more than 8192 bytes. The oldest unsent ones get dropped (`oldest saved`). | Wait for the link before sending more. |
| `launch result unknown, check Home` | The link dropped after the ADV asked T3 to start a task. | Look on Home before you start it again, it may be running already. |
| `denied, but the reason was not sent:` | The deny went through, the reason didn't reach T3. | Open the thread and send the reason as a reply. |
| `voice: refused:` | The relay turned the recording down. The rest of the line says why. | Depends on the reason, often the same as `relay unreachable`. |
| `transcription failed` | whisper-server answered with an error. | Check the logs. |
| `voice: not connected,` | Voice needs the relay. The rest of the line says why the link is down. | Same as `relay unreachable`. |
| `voice: nothing heard` | The recording was silent. | Hold `` ` `` the whole time you talk. |
| `voice: still transcribing the last recording` | The last recording isn't back yet. | Wait for it. |
| `voice: connection lost` | The link dropped while recording or transcribing. That recording is gone. | Record again once the link is back. |
| `voice down: whisper-server died` | whisper-server kept crashing, so the relay stopped restarting it. | Check the logs. `t3-cardputer-relay update` rebuilds voice. If you built it for a GPU, run setup again and pick CPU. |
| `whisper-server unavailable:` | whisper-server didn't start. | Same as above. |

### Typing hints

These say what to do. They're here so a search for the text finds something.

| On screen | What it means | Fix |
| --- | --- | --- |
| `type a prompt first` | Enter on an empty prompt. | Type the prompt, or hold `` ` `` and say it. |
| `type an answer first` | Enter on an empty answer. | Type the answer. |
| `type a network name first` | Enter on an empty network name. | Type the name. |
| `wifi_password_min=` | WiFi passwords are 8 to 63 characters. | Check the password. Leave it empty for an open network. |
| `pair_code_len=` | Pairing codes are 8 characters. | Type all 8. |
| `code is letters and digits only` | You typed something else in a pairing code. | Type only what `t3-cardputer-relay pair` printed. |
| `relay_url_max=` | The URL is longer than the ADV keeps. | Type only the host and port. |
| `request just arrived, press again` | A new request replaced the one on screen as you pressed. | Read it, then press again. |

### Relay frames

The ADV checks every frame from the relay against its budgets. These mean the relay sent something this firmware can't take, usually because one side is older than the other. A line that names a field and what was wrong with it, like `models: expected array`, means the same.

| On screen | What it means | Fix |
| --- | --- | --- |
| `max_frame_bytes=` | A frame is bigger than the ADV said it can take. | Update both sides: `t3-cardputer-relay update`, then a new install link with clean install off. If it stays, open an issue with the whole line. |
| `json_parse_budget=` | A frame needs more memory to parse than the ADV sets aside. | Same as above. |
| `json_nesting_max=` | A frame nests deeper than the ADV allows. | Same as above. |
| `heap: parse needed more than available` | The ADV ran out of memory parsing a frame. | Restart the ADV. If it repeats, update both sides and open an issue with the whole line. |
| `frame: not valid json` | A frame wasn't JSON. | Update both sides, then open an issue with the whole line. |
| `message: expected object` | A frame wasn't a JSON object. | Same as above. |
| `truncated: expected object` | A frame's `truncated` field had the wrong shape. | Update both sides, then open an issue with the whole line. |
| `type: unknown` | The relay sent a message type this firmware doesn't know. | Update the firmware: a new install link, clean install off. |
| `rx_ring_bytes=` | Frames came in faster than the ADV could read them, and one didn't fit. | Usually passes. If it repeats, open an issue with the whole line. |
| `rx_inbox_depth=` | Too many frames were waiting, and one was dropped. | Same as above. |
| `fragmented relay frame dropped` | The relay split a frame, which the ADV doesn't take. | Update both sides. If it stays, open an issue. |
| `heap: hello needed more than available` | No memory to say hello to the relay. The ADV retries. | Restart the ADV if it keeps showing. |
| `relay sent a frame before welcome` | The relay didn't follow the handshake. The ADV retries. | Update both sides. If it stays, open an issue. |
| `pairing returned 200 without a token` | The pairing answer had no token. | Update the relay, then pair again. |
| `token_max=` | The relay's token is longer than the ADV keeps. | Same as above. |
| `pair_reply_max=` | The pairing answer is bigger than the ADV reads. | Same as above. |

### Storage and memory

| On screen | What it means | Fix |
| --- | --- | --- |
| `settings reset: nvs` | The ADV's settings storage couldn't be read and was wiped. WiFi and the token are gone. | `t3-cardputer-relay install-link` and install again. |
| `wifi and the token cannot be saved` | The settings storage won't start. | Install again with clean install on. |
| `out of memory:` | The ADV ran out of memory for that step. | Restart the ADV. If it repeats, open an issue with the whole line. |
| `nvs:` | A setting couldn't be written or read. The rest of the line says which. | Restart the ADV. If it repeats, install with clean install on. |
| `heap: relay frame buffers do not fit` | Not enough memory at boot to start the relay link. | Restart the ADV. If it repeats, open an issue. |
| `wifi: driver init failed` | The WiFi chip didn't start. | Restart the ADV. If it repeats, open an issue. |
| `spent pair code still saved` | The ADV paired but couldn't delete the used code. | Nothing right away. If pairing errors show after a restart, install with clean install on. |
| `pair task stack=` | No memory to start pairing. | Restart the ADV and pair again. |
| `usb serial: driver or task did not start, usb setup unavailable` | The install page can't send settings to this ADV. | Restart the ADV. Fn+S still works. |

## On the install page

| On the page | What it means | Fix |
| --- | --- | --- |
| `Installing needs Chrome or Edge on a computer` | Safari, Firefox and phones have no Web Serial. | Open the link in Chrome or Edge on a desktop. |
| `This link is missing the` | Part of the link got lost, often when a terminal wrapped it. | Copy the whole line, or run `t3-cardputer-relay install-link` for a new one. |
| `The ADV's port is busy.` | Another app has the port open. On Linux it's also what you see when you don't have permission to open the port. | Close serial monitors and other tabs using it. On Linux, see [the port is busy on Linux](#the-port-is-busy-on-linux). |
| `The ADV didn't enter download mode.` | The ADV didn't switch to flashing on its own. | Unplug it, hold G0 while you plug it back in, then try again. |
| `didn't verify after writing.` | A part read back different from what was written. | Unplug, plug back in and install again. If it repeats, tick clean install. |

### The port is busy on Linux

Chrome reports a permission error on the port as busy. Check who can open it:

```
ls -l /dev/ttyACM0
id -nG
```

On my machine, with a udev rule in place:

```
crw-rw---- 1 root plugdev 166, 0 Oct 21 16:34 /dev/ttyACM0
```

If `id -nG` doesn't list the port's group, add a rule for Espressif devices (USB vendor `303a`) and join `plugdev`:

```
echo 'SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", GROUP="plugdev", MODE="0660"' | sudo tee /etc/udev/rules.d/99-cardputer.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
sudo usermod -aG plugdev "$USER"
```

Log out and back in so the group applies, then unplug and replug the ADV.

## From setup.sh

Most `✗` lines end with `next:` and the command to run. These need more than that line:

| setup.sh says | What it means | Fix |
| --- | --- | --- |
| `Windows isn't supported yet` | The relay runs on macOS and Linux. | Run setup on a Mac or a Linux machine that runs T3. |
| `Running as root` | You ran it with sudo. | Run it as your normal user. |
| `This machine runs a self-repairing checkout, setup.sh leaves it alone` | `relay.json` has `repair.projectId`, so this relay updates itself from `main`. | Nothing. See [run from a git checkout](install.md#run-from-a-git-checkout). |
| `no terminal to answer on` | Setup has a question and no terminal to ask on, like over ssh without a tty. | Run it in a terminal, or add `--yes` to take the defaults. |
| `this machine isn't allowed to use Funnel` | Your tailnet policy doesn't give this machine the `funnel` attribute. | Add it, see https://tailscale.com/kb/1223/funnel |
| `already serves` | Something else uses Funnel on port 8443. | If it's yours to stop, `tailscale funnel --https=8443 off`, then run setup again. |
| `loginctl enable-linger failed` | Without linger the relay stops when you log out. | `sudo loginctl enable-linger $USER`, then run setup again. |
| `healthz_timeout_s=` | The relay didn't answer `/healthz` within 30 seconds of starting. | Check the logs, setup prints the command. |
| `does not match SHA256SUMS` | A download came back different from the release. | Run setup again. If it repeats, open an issue. |

## Not an error

A laptop that sleeps takes the relay with it. The ADV shows `relay unreachable` until the laptop wakes, then reconnects by itself. On macOS the relay also stops when you log out. If you want your agents reachable all the time, run T3 and the relay on a machine that stays on.
