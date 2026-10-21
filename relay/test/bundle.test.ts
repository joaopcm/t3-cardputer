import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const relayDir = join(import.meta.dirname, "..");
const bundlePath = join(relayDir, "dist-bundle", "t3-cardputer-relay.mjs");
const version = (JSON.parse(readFileSync(join(relayDir, "package.json"), "utf8")) as { version: string }).version;

let isolatedDir: string | undefined;
let isolatedBundle = "";

beforeAll(() => {
  execFileSync("pnpm", ["bundle"], { cwd: relayDir, stdio: "pipe" });
  isolatedDir = mkdtempSync(join(tmpdir(), "relay-bundle-"));
  isolatedBundle = join(isolatedDir, "t3-cardputer-relay.mjs");
  copyFileSync(bundlePath, isolatedBundle);
}, 60_000);

afterAll(() => {
  if (isolatedDir !== undefined) rmSync(isolatedDir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, [isolatedBundle, ...args], { cwd: isolatedDir, env: { ...process.env, HOME: isolatedDir }, encoding: "utf8" });
}

describe("single-file bundle", () => {
  it("is executable and starts with an env node shebang", () => {
    expect(readFileSync(bundlePath, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(bundlePath).mode & 0o777).toBe(0o755);
  });

  it("prints its version from a directory with no node_modules", () => {
    const result = run("--version");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`t3-cardputer-relay ${version}\n`);
  });

  it("lists every command in --help", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    for (const command of ["serve", "pair", "devices", "revoke", "pair-t3", "secrets", "canary", "sim"]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("runs only the cli entry, not the sim entry", () => {
    const result = run("bogus");
    expect(result.stderr).not.toContain("usage:\n  sim");
  });
});
