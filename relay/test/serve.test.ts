import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminRequest } from "../src/admin.js";
import { SecretsStore } from "../src/secrets.js";
import { startRelay, tokenExpiryWarnings } from "../src/serve.js";
import { Device, FakeApprovals, FakeT3, summary } from "./helpers/relay-fixture.js";
import type { CanaryFailure, CanaryResult } from "../src/canary.js";
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

async function pairedDevice(env: { socketPath: string; port: number }): Promise<{ device: Device; token: string }> {
  const paired = await adminRequest(env.socketPath, { op: "pair" }, 2000);
  if (!("code" in paired)) throw new Error(JSON.stringify(paired));
  const response = await fetch(`http://127.0.0.1:${env.port}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: paired.code, name: "adv" }),
  });
  const { token } = (await response.json()) as { token: string };
  const device = await Device.open(env.port);
  cleanups.push(() => device.close());
  return { device, token };
}

const DAY_MS = 86_400_000;

describe("tokenExpiryWarnings", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  it("names each T3 token inside the warning window, the days left, and the re-pair command", () => {
    expect(tokenExpiryWarnings({ t3McpToken: { token: "m", expiresAt: at(5 * DAY_MS + 3_600_000) }, t3InternalToken: { token: "i", expiresAt: at(DAY_MS) } }, now, 7 * DAY_MS)).toEqual([
      "T3 MCP token expires in 5 days: run `t3-cardputer-relay pair-t3` on homelab",
      "T3 internal token expires in 1 day: run `t3-cardputer-relay pair-t3` on homelab",
    ]);
  });

  it("says under a day on the last day, and nothing outside the window, once expired, or for a missing token", () => {
    expect(tokenExpiryWarnings({ t3McpToken: { token: "m", expiresAt: at(3_600_000) } }, now, 7 * DAY_MS)).toEqual([
      "T3 MCP token expires in under a day: run `t3-cardputer-relay pair-t3` on homelab",
    ]);
    expect(tokenExpiryWarnings({ t3McpToken: { token: "m", expiresAt: at(8 * DAY_MS) }, t3InternalToken: { token: "i", expiresAt: at(-1) } }, now, 7 * DAY_MS)).toEqual([]);
    expect(tokenExpiryWarnings({}, now, 7 * DAY_MS)).toEqual([]);
  });
});

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

  it("revoke through the admin socket drops the connected device with 4401 and refuses its old token", async () => {
    const env = await relayEnvironment();
    const relay = await startRelay(env);
    cleanups.push(() => relay.close());
    const paired = await adminRequest(env.socketPath, { op: "pair" }, 2000);
    if (!("code" in paired)) throw new Error(JSON.stringify(paired));
    const response = await fetch(`http://127.0.0.1:${env.port}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: paired.code, name: "adv" }),
    });
    const { token } = (await response.json()) as { token: string };
    const device = await Device.open(env.port);
    cleanups.push(() => device.close());
    device.hello(token);
    await device.next("home");
    const listed = await adminRequest(env.socketPath, { op: "devices" }, 2000);
    if (!("devices" in listed)) throw new Error(JSON.stringify(listed));

    const revoked = await adminRequest(env.socketPath, { op: "revoke", id: listed.devices[0]!.id }, 2000);
    expect(revoked).toEqual({ ok: true, revoked: true, disconnected: true });
    expect((await device.next("error")).code).toBe("auth");
    expect((await device.closed).code).toBe(4401);

    const again = await Device.open(env.port);
    cleanups.push(() => again.close());
    again.hello(token);
    expect((await again.next("error")).code).toBe("auth");
    expect((await again.closed).code).toBe(4401);
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

  it("skips the version-change canary with a logged reason while T3 tokens are missing, and stops cleanly", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await relayEnvironment();
    const relay = await startRelay(env);
    cleanups.push(() => relay.close());
    await vi.waitFor(() => expect(error.mock.calls.some(([line]) => String(line).includes("canary skipped") && String(line).includes("T3 MCP token"))).toBe(true));
    await relay.close();
    expect(existsSync(join(env.stateDir, "t3-version.json"))).toBe(false);
  });

  it("restart with a saved broken verdict shows approvals down on devices at once, before any rerun finishes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const environment = createHttpServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/t3/environment") return void res.writeHead(200).end(JSON.stringify({ serverVersion: "0.1.0", orchestrationProtocolVersion: 2, capabilities: {} }));
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => environment.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { environment.closeAllConnections(); environment.close(() => resolve()); }));
    const env = await relayEnvironment();
    const config = JSON.parse(readFileSync(env.configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(env.configPath, JSON.stringify({ ...config, t3BaseUrl: `http://127.0.0.1:${(environment.address() as { port: number }).port}` }));
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    new SecretsStore(env.secretsPath).write({ devices: [], t3McpToken: { token: "m", expiresAt }, t3InternalToken: { token: "i", expiresAt } });
    mkdirSync(env.stateDir, { recursive: true });
    writeFileSync(join(env.stateDir, "t3-version.json"), JSON.stringify({ serverVersion: "0.1.0", orchestrationProtocolVersion: 2, verdict: "broken", stage: "respond", reason: "decision not accepted" }));

    const relay = await startRelay(env);
    cleanups.push(() => relay.close());
    const paired = await adminRequest(env.socketPath, { op: "pair" }, 2000);
    if (!("code" in paired)) throw new Error(JSON.stringify(paired));
    const response = await fetch(`http://127.0.0.1:${env.port}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: paired.code, name: "adv" }),
    });
    const { token } = (await response.json()) as { token: string };
    const device = await Device.open(env.port);
    cleanups.push(() => device.close());
    device.hello(token);
    const home = await device.next("home", (h) => !h.approvals.available);
    expect(home.approvals.reason).toContain("canary respond: decision not accepted");
  });

  it("an adapter break during a poll runs a confirming canary, and the device says checking, then fix in progress once a repair starts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const environment = createHttpServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/t3/environment") return void res.writeHead(200).end(JSON.stringify({ serverVersion: "0.1.0", orchestrationProtocolVersion: 2, capabilities: {} }));
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => environment.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { environment.closeAllConnections(); environment.close(() => resolve()); }));
    const env = await relayEnvironment();
    const config = JSON.parse(readFileSync(env.configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(env.configPath, JSON.stringify({ ...config, t3BaseUrl: `http://127.0.0.1:${(environment.address() as { port: number }).port}` }));
    const expiresAt = new Date(Date.now() + 20 * 86_400_000).toISOString();
    new SecretsStore(env.secretsPath).write({ devices: [], t3McpToken: { token: "m", expiresAt }, t3InternalToken: { token: "i", expiresAt } });
    mkdirSync(env.stateDir, { recursive: true });
    writeFileSync(join(env.stateDir, "t3-version.json"), JSON.stringify({ serverVersion: "0.1.0", orchestrationProtocolVersion: 2, verdict: "pass" }));

    const t3 = Object.assign(new FakeT3(), { waitForRun: async () => ({ status: "completed", timedOut: false }), settleThread: async () => {} });
    t3.threads = [summary("t1")];
    const approvals = new FakeApprovals();
    const gates: ((result: CanaryResult) => void)[] = [];
    const canary = () => new Promise<CanaryResult>((resolve) => gates.push(resolve));
    const failures: CanaryFailure[] = [];
    const relay = await startRelay(env, {
      connect: () => ({ t3, approvals, close: async () => {} }),
      canary,
      onCanaryFailed: (failure) => void failures.push(failure),
    });
    cleanups.push(() => relay.close());
    const paired = await adminRequest(env.socketPath, { op: "pair" }, 2000);
    if (!("code" in paired)) throw new Error(JSON.stringify(paired));
    const response = await fetch(`http://127.0.0.1:${env.port}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: paired.code, name: "adv" }),
    });
    const { token } = (await response.json()) as { token: string };
    const device = await Device.open(env.port);
    cleanups.push(() => device.close());
    device.hello(token);
    await device.next("home", (h) => h.approvals.available);
    expect(gates).toHaveLength(0);

    approvals.broken = "subscribeThread: expected snapshot";
    await device.next("home", (h) => h.approvals.reason === "approvals down: subscribeThread: expected snapshot, checking again");
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const broken: CanaryResult = { ok: false, stage: "approval_seen", kind: "broken", reason: "subscribeThread: expected snapshot" };
    gates[0]!(broken);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(failures).toHaveLength(0);
    gates[1]!(broken);
    await device.next("home", (h) => h.approvals.reason === "approvals down: subscribeThread: expected snapshot, fix in progress");
    expect(failures).toEqual([broken]);
    expect(gates).toHaveLength(2);
  });

  it("shows a T3 token close to expiry on Home with the days left", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await relayEnvironment();
    new SecretsStore(env.secretsPath).write({ devices: [], t3McpToken: { token: "m", expiresAt: new Date(Date.now() + 3 * DAY_MS + 60_000).toISOString() } });
    const relay = await startRelay(env);
    cleanups.push(() => relay.close());
    const { device, token } = await pairedDevice(env);
    device.hello(token);
    const home = await device.next("home");
    expect(home.warnings).toContain("T3 MCP token expires in 3 days: run `t3-cardputer-relay pair-t3` on homelab");
  });
});
