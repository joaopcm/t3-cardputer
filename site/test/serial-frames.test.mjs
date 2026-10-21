import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeProvision, encodeInfoRequest, parseDeviceLine, lineSplitter } from "../public/lib/serial-frames.js";

const utf8 = new TextEncoder();
const text = (bytes) => new TextDecoder().decode(bytes);

function frameJson(bytes) {
  const s = text(bytes);
  assert.equal(s.slice(0, 8), "\x02T3PROV ");
  assert.equal(s.at(-1), "\n");
  return JSON.parse(s.slice(8, -1));
}

function includesBytes(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

test("encodes wifi, relay and code as one T3PROV line", () => {
  const msg = { wifi: { ssid: "home", password: "hunter22" }, relay: "https://relay.example.com:8443", code: "ABCD1234" };
  const bytes = encodeProvision(msg);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(frameJson(bytes), msg);
  assert.equal(bytes.filter((b) => b === 0x0a).length, 1);
});

test("leaves out keys that aren't set", () => {
  assert.deepEqual(frameJson(encodeProvision({ relay: "https://r.example.com", code: "ABCD1234" })), {
    relay: "https://r.example.com",
    code: "ABCD1234",
  });
  assert.deepEqual(frameJson(encodeProvision({ wifi: undefined, relay: "https://r.example.com" })), { relay: "https://r.example.com" });
});

test("keeps a 64-char password exact", () => {
  const password = "0123456789abcdef".repeat(4);
  assert.equal(frameJson(encodeProvision({ wifi: { ssid: "home", password } })).wifi.password, password);
});

test("keeps an ssid with spaces and non-ascii utf-8 byte-exact", () => {
  const ssid = "Café do João 日本";
  const bytes = encodeProvision({ wifi: { ssid, password: "hunter22" } });
  assert.ok(includesBytes(bytes, utf8.encode(ssid)));
  assert.equal(frameJson(bytes).wifi.ssid, ssid);
});

test("an open network sends an empty password", () => {
  assert.deepEqual(frameJson(encodeProvision({ wifi: { ssid: "cafe", password: "" } })).wifi, { ssid: "cafe", password: "" });
});

test("never truncates a frame over the device line budget, the device refuses it by name", () => {
  const relay = "https://" + "a".repeat(1100) + ".example.com";
  const bytes = encodeProvision({ relay });
  assert.equal(frameJson(bytes).relay, relay);
  assert.ok(bytes.length > 1100);
  assert.deepEqual(parseDeviceLine("\x02T3PROV err provision_line_max=1024, line needed 1131\n"), {
    kind: "prov-err",
    reason: "provision_line_max=1024, line needed 1131",
  });
});

test("encodes the T3INFO request", () => {
  assert.equal(text(encodeInfoRequest()), "\x02T3INFO\n");
});

test("parses ok, err and info replies", () => {
  assert.deepEqual(parseDeviceLine("\x02T3PROV ok\n"), { kind: "prov-ok" });
  assert.deepEqual(parseDeviceLine("\x02T3PROV ok\r\n"), { kind: "prov-ok" });
  assert.deepEqual(parseDeviceLine("\x02T3PROV ok"), { kind: "prov-ok" });
  assert.deepEqual(parseDeviceLine("\x02T3PROV err provision: unknown key 'x'\n"), {
    kind: "prov-err",
    reason: "provision: unknown key 'x'",
  });
  assert.deepEqual(parseDeviceLine("\x02T3PROV err wifi: password must be 8-63 chars, 64 hex digits or empty\n"), {
    kind: "prov-err",
    reason: "wifi: password must be 8-63 chars, 64 hex digits or empty",
  });
  const info = { fw: "0.3.0", protocol: 1, relaySet: true, paired: true, wifiSaved: 2 };
  assert.deepEqual(parseDeviceLine(`\x02T3INFO ${JSON.stringify(info)}\n`), { kind: "info", info });
});

test("device logs and broken frames are other", () => {
  for (const line of ["I (1234) wifi: connected", "T3PROV ok", "\x02T3INFO {not json}", "\x02T3INFO", "\x02T3PROVok", "", "\x02SHOT"]) {
    assert.deepEqual(parseDeviceLine(line), { kind: "other" }, JSON.stringify(line));
  }
});

test("splits a byte stream into lines, even across a multi-byte char", () => {
  const split = lineSplitter();
  const bytes = utf8.encode("I (1) boot\n\x02T3INFO {\"fw\":\"é\"}\n\x02T3PR");
  const cut = bytes.indexOf(0xc3) + 1;
  assert.deepEqual(split(bytes.subarray(0, cut)), ["I (1) boot"]);
  assert.deepEqual(split(bytes.subarray(cut)), ['\x02T3INFO {"fw":"é"}']);
  assert.deepEqual(split(utf8.encode("OV ok\n")), ["\x02T3PROV ok"]);
});
