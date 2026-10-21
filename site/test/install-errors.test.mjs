import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { flashErrorMessage, partDownloadMessage, portOpenMessage } from "../public/lib/install-errors.js";

const notFound = "ADV not found. Wait for it to restart, then try again.";
const busy = /port is busy\. Close other apps and tabs that use it/;
const domError = (name) => Object.assign(new Error("Failed to open serial port."), { name });

test("a port that's gone is not found, not busy", () => {
  assert.equal(portOpenMessage(domError("NotFoundError"), undefined), notFound);
  assert.equal(portOpenMessage(domError("NetworkError"), false), notFound);
  assert.equal(portOpenMessage(domError("InvalidStateError"), false), notFound);
});

test("a port that's still there but won't open is busy", () => {
  assert.match(portOpenMessage(domError("NetworkError"), true), busy);
  assert.match(portOpenMessage(domError("NetworkError"), undefined), busy);
  assert.match(portOpenMessage(domError("InvalidStateError"), true), busy);
  assert.match(portOpenMessage(new Error("something else"), true), busy);
});

test("the busy message tells Linux users a permission problem looks the same, with the docs link", () => {
  assert.match(
    portOpenMessage(domError("NetworkError"), true),
    / On Linux, a permission problem looks the same: see https:\/\/github\.com\/joaopcm\/t3-cardputer\/blob\/main\/docs\/troubleshooting\.md#the-port-is-busy-on-linux$/,
  );
});

test("an md5 mismatch after writing names the part and the next step", () => {
  assert.equal(
    flashErrorMessage(new Error("MD5 of file does not match data in flash!"), "t3-cardputer.bin"),
    "t3-cardputer.bin didn't verify after writing. Unplug the ADV, plug it back in and install again. If it repeats, tick clean install.",
  );
});

test("other write errors keep esptool's text and say to replug", () => {
  assert.equal(
    flashErrorMessage(new Error("Timed out waiting for packet header"), "bootloader.bin"),
    "Writing bootloader.bin stopped: Timed out waiting for packet header. Unplug the ADV, plug it back in, then click Connect ADV and install again.",
  );
});

test("the vendored md5 hashes like the reference vectors", () => {
  const window = {};
  runInNewContext(readFileSync(new URL("../public/vendor/spark-md5/spark-md5.min.js", import.meta.url), "utf8"), { window });
  const { SparkMD5 } = window;
  const md5 = (text) => SparkMD5.ArrayBuffer.hash(new TextEncoder().encode(text).buffer);
  assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
});

test("a part gone after a new release says to open the install link again, not to click Connect", () => {
  const message = partDownloadMessage("t3-cardputer.bin", 404);
  assert.equal(message, "Couldn't download t3-cardputer.bin (HTTP 404). The site has a newer firmware than this page loaded. Nothing was written. Open the install link again.");
  assert.doesNotMatch(message, /Connect ADV/);
});

test("any other failed part download says to try again", () => {
  assert.equal(partDownloadMessage("t3-cardputer.bin", 503), "Couldn't download t3-cardputer.bin (HTTP 503). Nothing was written. Click Connect ADV and install to try again.");
});
