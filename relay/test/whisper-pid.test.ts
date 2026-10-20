import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearWhisperPid, reapOrphanWhisper, recordWhisperPid } from "../src/stt/whisper-pid.js";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function dir() {
  return mkdtempSync(join(tmpdir(), "relay-whisper-pid-"));
}

function spawnNamed(root: string, name: string): ChildProcess {
  const bin = join(root, name);
  writeFileSync(bin, "#!/bin/sh\nwhile :; do sleep 1; done\n");
  chmodSync(bin, 0o755);
  const child = spawn(bin, [], { stdio: "ignore" });
  children.push(child);
  return child;
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve())));

describe("whisper pid file", () => {
  it("records and clears the pid", () => {
    const file = join(dir(), "whisper.pid");
    recordWhisperPid(file, 4242);
    expect(readFileSync(file, "utf8").trim()).toBe("4242");
    clearWhisperPid(file);
    expect(existsSync(file)).toBe(false);
    clearWhisperPid(file);
  });

  it("kills a running whisper-server left by a killed relay and removes the file", async () => {
    const root = dir();
    const orphan = spawnNamed(root, "whisper-server");
    const file = join(root, "whisper.pid");
    recordWhisperPid(file, orphan.pid!);
    expect(await reapOrphanWhisper(file)).toBe(orphan.pid);
    await exited(orphan);
    expect(orphan.signalCode).toBe("SIGKILL");
    expect(existsSync(file)).toBe(false);
  });

  it("leaves a live process that is not a whisper-server alone", async () => {
    const root = dir();
    const other = spawnNamed(root, "not-whisper");
    const file = join(root, "whisper.pid");
    recordWhisperPid(file, other.pid!);
    expect(await reapOrphanWhisper(file)).toBeUndefined();
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it("ignores a pid that is no longer running", async () => {
    const root = dir();
    const gone = spawnNamed(root, "whisper-server");
    gone.kill("SIGKILL");
    await exited(gone);
    const file = join(root, "whisper.pid");
    recordWhisperPid(file, gone.pid!);
    expect(await reapOrphanWhisper(file)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("ignores a missing or garbage pid file", async () => {
    const root = dir();
    expect(await reapOrphanWhisper(join(root, "none.pid"))).toBeUndefined();
    const file = join(root, "whisper.pid");
    writeFileSync(file, "not a pid");
    expect(await reapOrphanWhisper(file)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });
});
