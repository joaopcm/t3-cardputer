import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultsStore } from "../src/defaults-store.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "relay-defaults-")), "state", "defaults.json");
}

const d1 = { model: "claude-opus-5", workspace: "worktree" as const, runtimeMode: "approval-required" };
const d2 = { model: "gpt-5", workspace: "root" as const, runtimeMode: "auto" };

describe("DefaultsStore", () => {
  it("returns undefined for an unknown project and a missing file", () => {
    expect(new DefaultsStore(tmpPath()).get("p1")).toBeUndefined();
  });

  it("DefaultsStore remembers per project and survives reload", () => {
    const path = tmpPath();
    const store = new DefaultsStore(path);
    store.remember("p1", d1);
    store.remember("p2", d2);

    expect(store.get("p1")).toEqual(d1);
    const reloaded = new DefaultsStore(path);
    expect(reloaded.get("p1")).toEqual(d1);
    expect(reloaded.get("p2")).toEqual(d2);
  });

  it("overwrites a project's defaults and leaves no tmp files", () => {
    const path = tmpPath();
    const store = new DefaultsStore(path);
    store.remember("p1", d1);
    store.remember("p1", d2);

    expect(new DefaultsStore(path).get("p1")).toEqual(d2);
    expect(readdirSync(dirname(path))).toEqual(["defaults.json"]);
  });

  it("names the file when it is not valid", () => {
    const path = tmpPath();
    new DefaultsStore(path).remember("p1", d1);
    writeFileSync(path, "{nope");

    expect(() => new DefaultsStore(path).get("p1")).toThrow(new RegExp(`invalid defaults file ${path}`));
  });

  it("names the file when the shape is wrong", () => {
    const path = tmpPath();
    new DefaultsStore(path).remember("p1", d1);
    writeFileSync(path, JSON.stringify({ p1: { model: 3 } }));

    expect(() => new DefaultsStore(path).get("p1")).toThrow(new RegExp(`invalid defaults file ${path}`));
  });
});
