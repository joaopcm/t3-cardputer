import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFragment } from "../public/lib/fragment.js";

const relay = "https://relay.example.com:8443";
const link = (r, c) => `#r=${encodeURIComponent(r)}&c=${c}`;

test("reads the relay and code from an install link", () => {
  assert.deepEqual(parseFragment(link(relay, "ABCD1234")), { relay, code: "ABCD1234" });
});

test("decodes %2F and %3A escapes in the relay url", () => {
  assert.deepEqual(parseFragment("#r=https%3A%2F%2Frelay.example.com%3A8443%2F&c=Z9Y8X7W6"), {
    relay: "https://relay.example.com:8443/",
    code: "Z9Y8X7W6",
  });
});

test("works without the leading #", () => {
  assert.deepEqual(parseFragment(link(relay, "ABCD1234").slice(1)), { relay, code: "ABCD1234" });
});

test("an empty fragment is no link, not an error", () => {
  assert.deepEqual(parseFragment(""), {});
  assert.deepEqual(parseFragment("#"), {});
});

test("rejects a relay that isn't https", () => {
  for (const r of ["http://relay.example.com:8443", "wss://relay.example.com:8443", "relay.example.com:8443"]) {
    const { error, relay: got } = parseFragment(link(r, "ABCD1234"));
    assert.equal(got, undefined);
    assert.match(error, /relay url must start with https:\/\//i, r);
    assert.match(error, /install-link/);
  }
});

test("rejects a code that isn't 8 capital letters or digits", () => {
  for (const c of ["ABCD123", "ABCD12345", "abcd1234", "ABCD-123", "ABCD%20123"]) {
    const { error, code } = parseFragment(link(relay, c));
    assert.equal(code, undefined);
    assert.match(error, /pairing code must be 8 letters or digits/i, c);
    assert.match(error, /install-link/);
  }
});

test("names a missing relay or code", () => {
  assert.match(parseFragment("#c=ABCD1234").error, /missing the relay url/i);
  assert.match(parseFragment(`#r=${encodeURIComponent(relay)}`).error, /missing the pairing code/i);
});

test("names a broken escape instead of throwing", () => {
  assert.match(parseFragment("#r=https%3A%2F%2Frelay%E0%A4%A&c=ABCD1234").error, /relay url is not valid/i);
});
