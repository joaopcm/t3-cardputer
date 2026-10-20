import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminRequest } from "../src/admin.js";
import { startRelay } from "../src/serve.js";
import { Device } from "./helpers/relay-fixture.js";
import { relayEnvironment } from "./helpers/relay-env.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("startRelay", () => {
  it("serves devices, pairs through the admin socket, and cleans up on close", async () => {
    const env = await relayEnvironment();
    const relay = await startRelay(env);
    cleanups.push(() => relay.close());
    expect(relay.port).toBe(env.port);
    expect(statSync(env.socketPath).mode & 0o777).toBe(0o600);

    const paired = await adminRequest(env.socketPath, { op: "pair" }, 2000);
    if (!("code" in paired)) throw new Error(JSON.stringify(paired));
    const response = await fetch(`http://127.0.0.1:${env.port}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: paired.code, name: "adv" }),
    });
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };

    const device = await Device.open(env.port);
    cleanups.push(() => device.close());
    device.hello(token);
    const home = await device.next("home");
    expect(home.approvals.available).toBe(false);
    expect(home.approvals.reason).toContain("pair-t3");

    const listed = await adminRequest(env.socketPath, { op: "devices" }, 2000);
    expect(listed).toMatchObject({ ok: true, devices: [expect.objectContaining({ name: "adv" })] });

    const pid = Number(readFileSync(env.pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    await relay.close();
    expect(existsSync(env.socketPath)).toBe(false);
    expect(existsSync(env.pidFile)).toBe(false);
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("kills a whisper-server orphaned by a killed relay before spawning its own", async () => {
    const env = await relayEnvironment();
    const orphan = spawn(join(env.root, "whisper", "build", "bin", "whisper-server"), [], { stdio: "ignore" });
    cleanups.push(() => void orphan.kill("SIGKILL"));
    mkdirSync(env.stateDir, { recursive: true });
    writeFileSync(env.pidFile, `${orphan.pid}\n`);
    const relay = await startRelay(env);
    cleanups.push(() => relay.close());
    await vi.waitFor(() => expect(orphan.signalCode).toBe("SIGKILL"));
    const own = Number(readFileSync(env.pidFile, "utf8"));
    expect(own).not.toBe(orphan.pid);
    expect(alive(own)).toBe(true);
  });

  it("refuses a second relay on the same state dir without touching the first one's whisper-server", async () => {
    const env = await relayEnvironment();
    const relay = await startRelay(env);
    cleanups.push(() => relay.close());
    const pid = Number(readFileSync(env.pidFile, "utf8"));
    await expect(startRelay({ ...env, configPath: env.configPath })).rejects.toThrow(/already running/);
    expect(alive(pid)).toBe(true);
    expect(Number(readFileSync(env.pidFile, "utf8"))).toBe(pid);
  });

  it("names the config problem and starts nothing when the config is invalid", async () => {
    const env = await relayEnvironment();
    writeFileSync(env.configPath, JSON.stringify({ port: 0 }));
    await expect(startRelay(env)).rejects.toThrow(/invalid config.*port/);
    expect(existsSync(env.socketPath)).toBe(false);
  });

  it("releases the admin socket and whisper-server when the listen port is taken", async () => {
    const env = await relayEnvironment();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(env.port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    await expect(startRelay(env)).rejects.toThrow(/EADDRINUSE/);
    expect(existsSync(env.socketPath)).toBe(false);
    expect(existsSync(env.pidFile)).toBe(false);
  });
});
