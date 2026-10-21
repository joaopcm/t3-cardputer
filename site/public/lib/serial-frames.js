const STX = "\x02";
const encoder = new TextEncoder();

export function encodeProvision({ wifi, relay, code }) {
  const body = {};
  if (wifi !== undefined) body.wifi = { ssid: wifi.ssid, password: wifi.password };
  if (relay !== undefined) body.relay = relay;
  if (code !== undefined) body.code = code;
  return encoder.encode(`${STX}T3PROV ${JSON.stringify(body)}\n`);
}

export function encodeInfoRequest() {
  return encoder.encode(`${STX}T3INFO\n`);
}

export function parseDeviceLine(line) {
  const frame = line.replace(/\r?\n$/, "");
  if (frame === `${STX}T3PROV ok`) return { kind: "prov-ok" };
  if (frame.startsWith(`${STX}T3PROV err `)) return { kind: "prov-err", reason: frame.slice(`${STX}T3PROV err `.length) };
  if (frame.startsWith(`${STX}T3INFO `)) {
    try {
      return { kind: "info", info: JSON.parse(frame.slice(`${STX}T3INFO `.length)) };
    } catch {
      return { kind: "other" };
    }
  }
  return { kind: "other" };
}

export function lineSplitter() {
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder();
  return (chunk) => {
    const bytes = new Uint8Array(pending.length + chunk.length);
    bytes.set(pending);
    bytes.set(chunk, pending.length);
    const lines = [];
    let start = 0;
    for (let nl = bytes.indexOf(0x0a); nl >= 0; nl = bytes.indexOf(0x0a, start)) {
      lines.push(decoder.decode(bytes.subarray(start, nl)).replace(/\r$/, ""));
      start = nl + 1;
    }
    pending = bytes.slice(start);
    return lines;
  };
}
