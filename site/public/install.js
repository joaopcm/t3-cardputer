import { ESPLoader, ESPRESSIF_VID, Transport } from "/vendor/esptool-js/bundle.js";
import { browserSupport } from "/lib/browser-support.js";
import { checkPartFits, chipMatches, flashPlan, partUrl } from "/lib/flash-plan.js";
import { parseFragment } from "/lib/fragment.js";
import { flashErrorMessage, portOpenMessage, replug } from "/lib/install-errors.js";
import { encodeInfoRequest, encodeProvision, lineSplitter, parseDeviceLine } from "/lib/serial-frames.js";

// receipt: provisional, not measured on the ADV yet. The device polls USB serial every 20 ms (kMainPollTicks), drains a reply within 100 ms (kReplyDrainTicks) and restarts within 500 ms after ok (docs/protocol.md), and provision.py uses the same 5 s tripwire. Replace with 5x the slowest of 10 provision.py runs.
const kProvisionReplyMs = 5000;
// receipt: esptool.py's HardReset holds RTS for 100 ms
const kResetHoldMs = 100;
// why: USB-JTAG-serial ignores the baud (docs/protocol.md), and equal ROM and flash rates skip esptool-js's port reopen
const kBaud = 115200;

const issues = "https://github.com/joaopcm/t3-cardputer/issues";

class Named extends Error {}

const $ = (id) => document.getElementById(id);
const state = { link: null, manifest: null, port: null, info: null, clean: false };

start();

function start() {
  const link = parseFragment(location.hash);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  const support = browserSupport(navigator);
  if (!support.ok) return reveal($("unsupported"), support.message);
  if (link.error) return reveal($("link-error"), link.error);
  if (!link.relay) return reveal($("no-link"));

  state.link = link;
  $("relay-host").textContent = new URL(link.relay).host;
  reveal($("steps"));
  $("install").addEventListener("click", install);
  $("wifi-form").addEventListener("submit", sendProvision);
  $("open-network").addEventListener("change", (event) => {
    $("password").disabled = event.target.checked;
    if (event.target.checked) $("password").value = "";
  });
  loadManifest();
}

async function loadManifest() {
  try {
    const response = await fetch("/fw/latest/manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Named(`Couldn't load the firmware list (/fw/latest/manifest.json, HTTP ${response.status}). Open the install link again.`);
    const manifest = await response.json();
    if (!manifest.version || !manifest.chip || !Array.isArray(manifest.parts) || !manifest.nvs) {
      throw new Named(`The firmware list is broken. Open an issue at ${issues}.`);
    }
    state.manifest = manifest;
    $("firmware").textContent = `Installs ${state.manifest.name} ${state.manifest.version}.`;
    $("install").disabled = false;
  } catch (error) {
    $("firmware").textContent = error instanceof Named ? error.message : `Couldn't load the firmware list: ${error.message}. Open the install link again.`;
    $("firmware").className = "problem";
  }
}

async function install() {
  const log = logger($("install-log"));
  log.clear();
  hide($("step-wifi"), $("step-done"));
  setBusy(true);
  try {
    state.clean = $("clean").checked;
    const plan = planOrExplain(state.clean);
    state.port = await pickPort();
    state.info = (await ask(state.port, encodeInfoRequest(), ["info"]))?.info ?? null;
    log.say(describeDevice(state.info, state.clean));

    const files = await downloadParts(plan, log);
    await flash(state.port, plan, files, log);
    log.say("Installed. The ADV is restarting.");
    showWifiForm();
  } catch (error) {
    log.fail(describeError(error));
  } finally {
    setBusy(false);
  }
}

function planOrExplain(clean) {
  try {
    return flashPlan(state.manifest, { clean });
  } catch (error) {
    throw new Named(`${error.message} Open an issue at ${issues}.`);
  }
}

async function pickPort() {
  try {
    return await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
  } catch (error) {
    if (error.name === "NotFoundError") throw new Named("No port picked. Click Connect ADV and install again and pick the ADV's USB port.");
    throw error;
  }
}

function describeDevice(info, clean) {
  if (info) {
    const found = `Found T3 ${info.fw} on the ADV.`;
    return clean ? `${found} Clean install erases its WiFi, relay and pairing.` : `${found} This install keeps your settings.`;
  }
  const silent = `No answer to T3INFO within ${kProvisionReplyMs} ms.`;
  if (clean) return `${silent} Clean install erases everything.`;
  return `${silent} That's normal on a new ADV or one running Launcher. If T3 was on it and showed a storage error, tick clean install and start again.`;
}

async function downloadParts(plan, log) {
  const files = [];
  for (const write of plan.writes) {
    const part = state.manifest.parts.find((p) => p.path === write.path);
    log.say(`Downloading ${write.path}`);
    const response = await fetch(partUrl(state.manifest, write.path));
    if (!response.ok) throw new Named(`Couldn't download ${write.path} (HTTP ${response.status}). Nothing was written. Click Connect ADV and install to try again.`);
    const data = new Uint8Array(await response.arrayBuffer());
    const sha256 = toHex(await crypto.subtle.digest("SHA-256", data));
    if (sha256 !== part.sha256) {
      throw new Named(`${write.path} failed its sha256 check: expected ${part.sha256}, got ${sha256}. Nothing was written. Click Connect ADV and install to try again.`);
    }
    const tooBig = checkPartFits(write, data.length);
    if (tooBig) throw new Named(`${tooBig}. The firmware manifest is broken, nothing was written. Open an issue at ${issues}.`);
    files.push({ data, address: write.offset });
  }
  log.say(`Checked ${files.length} parts against their sha256.`);
  return files;
}

async function flash(port, plan, files, log) {
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: kBaud, romBaudrate: kBaud });
  log.say("Connecting to the ADV");
  try {
    await loader.main();
  } catch (error) {
    await transport.disconnect().catch(() => {});
    throw connectError(error, port);
  }

  let current = 0;
  try {
    if (!chipMatches(loader.chip.CHIP_NAME, state.manifest.chip)) {
      throw new Named(`This board is an ${loader.chip.CHIP_NAME}, the ADV is an ESP32-S3. Plug in the ADV and pick its port.`);
    }
    if (plan.eraseAll) log.say("Erasing the whole flash (clean install)");
    const progress = $("install-progress");
    progress.hidden = false;
    await loader.writeFlash({
      fileArray: files,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: plan.eraseAll,
      compress: true,
      calculateMD5Hash: md5hex,
      reportProgress(index, written, total) {
        current = index;
        if (written === 0) log.say(`Writing ${plan.writes[index].path} (${index + 1} of ${files.length})`);
        progress.value = (index + written / total) / files.length;
      },
    });
    log.say("Restarting the ADV");
    await resetIntoApp(transport);
  } catch (error) {
    await transport.disconnect().catch(() => {});
    if (error instanceof Named) throw error;
    throw new Named(flashErrorMessage(error, plan.writes[current].path));
  }
  // why: the ADV re-enumerates on USB when it resets, which can close the port under us
  await transport.disconnect().catch(() => {});
}

// why: esptool-js 0.7.0's HardReset only lowers RTS, which never resets a USB-JTAG-serial chip. DTR=0 with RTS=1 does (docs/protocol.md).
async function resetIntoApp(transport) {
  await transport.setDTR(false);
  await transport.setRTS(true);
  await new Promise((resolve) => setTimeout(resolve, kResetHoldMs));
  await transport.setRTS(false);
}

function md5hex(image) {
  return globalThis.SparkMD5.ArrayBuffer.hash(image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength));
}

function connectError(error, port) {
  if (["InvalidStateError", "NetworkError", "NotFoundError"].includes(error.name)) return new Named(portOpenMessage(error, port.connected));
  if (/Failed to connect/.test(error.message)) {
    return new Named("The ADV didn't enter download mode. Unplug it, hold G0 while you plug it back in, then click Connect ADV and install again.");
  }
  return new Named(`Connecting to the ADV failed: ${error.message}. ${replug}`);
}

function showWifiForm() {
  const saved = !state.clean && state.info?.wifiSaved > 0;
  $("ssid").required = !saved;
  $("ssid-hint").hidden = !saved;
  $("ssid-hint").textContent = saved ? `Leave it empty to keep the ${state.info.wifiSaved} saved network${state.info.wifiSaved === 1 ? "" : "s"}.` : "";
  reveal($("step-wifi"));
  reveal($("wifi-form"));
  $("ssid").focus();
}

async function sendProvision(event) {
  event.preventDefault();
  const log = logger($("wifi-log"));
  log.clear();
  setBusy(true);
  try {
    const wifi = readWifi();
    const port = await findPort();
    const reply = await ask(port, encodeProvision({ wifi, relay: state.link.relay, code: state.link.code }), ["prov-ok", "prov-err"]);
    if (!reply) {
      throw new Named(`No reply from the ADV: kProvisionReplyMs=${kProvisionReplyMs}, the reply needed more. Wait until the ADV has finished starting, then press Send to ADV again.`);
    }
    if (reply.kind === "prov-err") throw new Named(`The ADV said: ${reply.reason}. Fix it and press Send to ADV again.`);
    $("password").value = "";
    log.say("The ADV said ok.");
    hide($("wifi-form"));
    reveal($("step-done"));
  } catch (error) {
    log.fail(describeError(error));
  } finally {
    setBusy(false);
  }
}

function readWifi() {
  const ssid = $("ssid").value;
  const open = $("open-network").checked;
  const password = open ? "" : $("password").value;
  if (ssid === "") {
    if ($("ssid").required) throw new Named("Type the network name the ADV should join.");
    return undefined;
  }
  if (!open && password === "") throw new Named("Type the WiFi password, or tick open network.");
  return { ssid, password };
}

async function findPort() {
  const granted = await navigator.serial.getPorts();
  if (granted.includes(state.port)) return state.port;
  const espressif = granted.filter((port) => port.getInfo().usbVendorId === ESPRESSIF_VID);
  if (espressif.length === 1) return espressif[0];
  return pickPort();
}

async function ask(port, frame, kinds) {
  try {
    await port.open({ baudRate: kBaud });
  } catch (error) {
    throw new Named(portOpenMessage(error, port.connected));
  }
  try {
    await port.setSignals({ requestToSend: false });
    await port.setSignals({ dataTerminalReady: false });
    const writer = port.writable.getWriter();
    await writer.write(frame);
    writer.releaseLock();
    return await readReply(port, kinds);
  } catch (error) {
    if (error instanceof Named) throw error;
    throw new Named(`Lost the ADV's port (${error.message}). Wait until the ADV has finished starting, then try again.`);
  } finally {
    await port.close().catch(() => {});
  }
}

async function readReply(port, kinds) {
  const reader = port.readable.getReader();
  const split = lineSplitter();
  const timer = setTimeout(() => reader.cancel(), kProvisionReplyMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      for (const line of split(value)) {
        const reply = parseDeviceLine(line);
        if (kinds.includes(reply.kind)) return reply;
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function describeError(error) {
  if (error instanceof Named) return error.message;
  return `${error.message}. ${replug}`;
}

function logger(list) {
  const add = (text, className) => {
    const item = document.createElement("li");
    item.textContent = text;
    if (className) item.className = className;
    list.append(item);
  };
  return {
    clear: () => list.replaceChildren(),
    say: (text) => add(text),
    fail: (text) => add(text, "problem"),
  };
}

function setBusy(busy) {
  $("install").disabled = busy || !state.manifest;
  $("send").disabled = busy;
}

function reveal(element, text) {
  if (text !== undefined) element.textContent = text;
  element.hidden = false;
}

function hide(...elements) {
  for (const element of elements) element.hidden = true;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
