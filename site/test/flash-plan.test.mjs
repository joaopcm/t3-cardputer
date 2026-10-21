import { test } from "node:test";
import assert from "node:assert/strict";
import { flashPlan, checkPartFits, chipMatches, partUrl } from "../public/lib/flash-plan.js";

const manifest = {
  name: "T3 Cardputer",
  version: "0.3.0",
  chip: "esp32s3",
  protocol: 1,
  parts: [
    { path: "bootloader.bin", offset: 0, sha256: "a".repeat(64) },
    { path: "partition-table.bin", offset: 32768, sha256: "b".repeat(64) },
    { path: "t3-cardputer.bin", offset: 65536, sha256: "c".repeat(64) },
  ],
  nvs: { offset: 36864, size: 24576 },
};

test("an update writes the three parts and keeps nvs", () => {
  const plan = flashPlan(manifest, { clean: false });
  assert.equal(plan.eraseAll, false);
  assert.deepEqual(
    plan.writes.map(({ offset, path }) => ({ offset, path })),
    [
      { offset: 0, path: "bootloader.bin" },
      { offset: 32768, path: "partition-table.bin" },
      { offset: 65536, path: "t3-cardputer.bin" },
    ],
  );
  for (const w of plan.writes) assert.ok(w.offset < 36864 || w.offset > 61439, w.path);
});

test("a clean install erases everything first", () => {
  const plan = flashPlan(manifest, { clean: true });
  assert.equal(plan.eraseAll, true);
  assert.equal(plan.writes.length, 3);
});

test("each write is bounded by the next part or nvs", () => {
  const max = Object.fromEntries(flashPlan(manifest, { clean: false }).writes.map((w) => [w.path, w.maxBytes]));
  assert.deepEqual(max, { "bootloader.bin": 32768, "partition-table.bin": 4096, "t3-cardputer.bin": Infinity });
});

test("refuses a manifest with a part inside nvs", () => {
  for (const offset of [36864, 40960, 61439]) {
    const bad = { ...manifest, parts: [...manifest.parts, { path: "evil.bin", offset, sha256: "d".repeat(64) }] };
    assert.throws(() => flashPlan(bad, { clean: false }), /evil\.bin at 0x[0-9a-f]+ is inside nvs \(0x9000-0xefff\)/);
  }
});

test("a part that would run into nvs is refused by name", () => {
  const table = flashPlan(manifest, { clean: false }).writes[1];
  assert.equal(checkPartFits(table, 3072), null);
  assert.equal(checkPartFits(table, 4096), null);
  assert.equal(checkPartFits(table, 4097), "partition-table.bin slot=4096 bytes, partition-table.bin needed 4097");
  assert.equal(checkPartFits(flashPlan(manifest, { clean: false }).writes[2], 3_000_000), null);
});

test("matches the chip esptool reports to the manifest chip", () => {
  assert.equal(chipMatches("ESP32-S3", "esp32s3"), true);
  assert.equal(chipMatches("ESP32-S3 (QFN56) (revision v0.2)", "esp32s3"), true);
  assert.equal(chipMatches("ESP32-C3", "esp32s3"), false);
  assert.equal(chipMatches("ESP32", "esp32s3"), false);
});

test("parts live under /fw/<version>/", () => {
  assert.equal(partUrl(manifest, "t3-cardputer.bin"), "/fw/0.3.0/t3-cardputer.bin");
});
