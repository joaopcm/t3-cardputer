import { test } from "node:test";
import assert from "node:assert/strict";
import { browserSupport } from "../public/lib/browser-support.js";

const refused = {
  ok: false,
  message: "Installing needs Chrome or Edge on a computer (Web Serial). Safari, Firefox and phones can't talk to USB devices.",
};
const serial = { requestPort() {} };

test("desktop chrome and edge are supported", () => {
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
  assert.deepEqual(browserSupport({ userAgent: chrome, serial, userAgentData: { mobile: false } }), { ok: true });
  assert.deepEqual(browserSupport({ userAgent: edge, serial, userAgentData: { mobile: false } }), { ok: true });
});

test("safari and firefox are refused by name", () => {
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
  assert.deepEqual(browserSupport({ userAgent: safari }), refused);
  assert.deepEqual(browserSupport({ userAgent: firefox }), refused);
});

test("phones are refused even when they expose navigator.serial", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  assert.deepEqual(browserSupport({ userAgent: iphone }), refused);
  assert.deepEqual(browserSupport({ userAgent: android, serial, userAgentData: { mobile: true } }), refused);
  assert.deepEqual(browserSupport({ userAgent: android, serial }), refused);
});
