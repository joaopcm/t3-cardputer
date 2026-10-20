import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_REQUEST_BYTES_MAX, AdminUnavailableError, adminRequest, startAdminServer } from "../src/admin.js";
import { DeviceAuth } from "../src/auth/devices.js";
import { DEFAULT_LIMITS } from "../src/config.js";
import { SecretsStore } from "../src/secrets.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(limits = DEFAULT_LIMITS, disconnect?: (id: string, reason: string) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), "relay-admin-"));
  const auth = new DeviceAuth(new SecretsStore(join(dir, "secrets.json")), limits);
  const socketPath = join(dir, "state", "admin.sock");
  const admin = await startAdminServer({ socketPath, auth, ...(disconnect ? { disconnect } : {}) });
  cleanups.push(() => admin.close());
  return { dir, auth, socketPath, admin };
}

describe("admin socket", () => {
  it("creates the socket 0600 inside a 0700 directory", async () => {
    const { socketPath } = await setup();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(socketPath, "..")).mode & 0o777).toBe(0o700);
  });

  it("pair returns a code the running auth accepts", async () => {
    const { auth, socketPath } = await setup();
    const reply = await adminRequest(socketPath, { op: "pair" }, 2000);
    if (!("code" in reply)) throw new Error(`unexpected reply ${JSON.stringify(reply)}`);
    expect(reply.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(Date.parse(reply.expiresAt)).toBeGreaterThan(Date.now());
    expect(auth.redeem(reply.code, "adv", "1.2.3.4").token).toBeTruthy();
  });

  it("devices lists paired devices and locked-out sources", async () => {
    const { auth, socketPath } = await setup({ ...DEFAULT_LIMITS, authFailuresPerWindow: 2 });
    const { code } = auth.createPairingCode();
    const { deviceId } = auth.redeem(code, "adv", "1.1.1.1");
    auth.verify("nope", "9.9.9.9");
    auth.verify("nope", "9.9.9.9");
    const reply = await adminRequest(socketPath, { op: "devices" }, 2000);
    if (!("devices" in reply)) throw new Error(`unexpected reply ${JSON.stringify(reply)}`);
    expect(reply.devices).toEqual([expect.objectContaining({ id: deviceId, name: "adv" })]);
    expect(reply.lockouts).toEqual([{ source: "9.9.9.9", retryAfterMs: expect.any(Number) }]);
    expect(JSON.stringify(reply)).not.toContain("tokenSha256");
  });

  it("revoke removes the device and reports unknown ids", async () => {
    const { auth, socketPath } = await setup();
    const { deviceId } = auth.redeem(auth.createPairingCode().code, "adv", "1.1.1.1");
    expect(await adminRequest(socketPath, { op: "revoke", id: deviceId }, 2000)).toEqual({ ok: true, revoked: true, disconnected: false });
    expect(auth.list()).toEqual([]);
    expect(await adminRequest(socketPath, { op: "revoke", id: deviceId }, 2000)).toEqual({ ok: true, revoked: false, disconnected: false });
  });

  it("revoke disconnects the device only after the secrets no longer hold it", async () => {
    const calls: { id: string; reason: string; stillStored: boolean }[] = [];
    let auth!: DeviceAuth;
    const made = await setup(DEFAULT_LIMITS, (id, reason) => {
      calls.push({ id, reason, stillStored: auth.list().some((d) => d.id === id) });
      return true;
    });
    auth = made.auth;
    const { deviceId } = auth.redeem(auth.createPairingCode().code, "adv", "1.1.1.1");
    expect(await adminRequest(made.socketPath, { op: "revoke", id: deviceId }, 2000)).toEqual({ ok: true, revoked: true, disconnected: true });
    expect(calls).toEqual([{ id: deviceId, reason: expect.stringContaining("revoked"), stillStored: false }]);
    expect(await adminRequest(made.socketPath, { op: "revoke", id: deviceId }, 2000)).toEqual({ ok: true, revoked: false, disconnected: false });
    expect(calls).toHaveLength(1);
  });

  it("answers an unknown op with an error naming it", async () => {
    const { socketPath } = await setup();
    const reply = await adminRequest(socketPath, { op: "reboot" } as never, 2000);
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining("reboot") });
  });

  it("refuses an oversized request naming the budget", async () => {
    const { socketPath } = await setup();
    const reply = await adminRequest(socketPath, { op: "revoke", id: "x".repeat(ADMIN_REQUEST_BYTES_MAX) }, 2000);
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining(`admin_request_bytes_max=${ADMIN_REQUEST_BYTES_MAX}`) });
  });

  it("close removes the socket file and later requests are unavailable", async () => {
    const { socketPath, admin } = await setup();
    await admin.close();
    await expect(adminRequest(socketPath, { op: "pair" }, 2000)).rejects.toBeInstanceOf(AdminUnavailableError);
  });

  it("is unavailable when no socket exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-admin-"));
    await expect(adminRequest(join(dir, "admin.sock"), { op: "pair" }, 2000)).rejects.toBeInstanceOf(AdminUnavailableError);
  });

  it("replaces a stale socket file left by a killed relay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-admin-"));
    const socketPath = join(dir, "admin.sock");
    const killed = spawn(process.execPath, ["-e", `require("net").createServer().listen(process.argv[1], () => console.log("up"))`, socketPath], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => killed.stdout.once("data", resolve));
    killed.kill("SIGKILL");
    await new Promise((resolve) => killed.once("exit", resolve));
    expect(statSync(socketPath).isSocket()).toBe(true);
    const auth = new DeviceAuth(new SecretsStore(join(dir, "secrets.json")), DEFAULT_LIMITS);
    const admin = await startAdminServer({ socketPath, auth });
    cleanups.push(() => admin.close());
    expect(await adminRequest(socketPath, { op: "pair" }, 2000)).toMatchObject({ ok: true });
  });

  it("refuses to start over a live relay", async () => {
    const { socketPath, auth } = await setup();
    await expect(startAdminServer({ socketPath, auth })).rejects.toThrow(/already running/);
  });

  it("refuses to replace a non-socket file at the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-admin-"));
    mkdirSync(dir, { recursive: true });
    const socketPath = join(dir, "admin.sock");
    writeFileSync(socketPath, "not a socket");
    const auth = new DeviceAuth(new SecretsStore(join(dir, "secrets.json")), DEFAULT_LIMITS);
    await expect(startAdminServer({ socketPath, auth })).rejects.toThrow(/not a socket/);
  });

  it("times out naming the budget when the server never answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-admin-"));
    const socketPath = join(dir, "admin.sock");
    const held: Socket[] = [];
    const mute = createServer((socket) => held.push(socket));
    await new Promise<void>((resolve) => mute.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const socket of held) socket.destroy();
      mute.close(() => resolve());
    }));
    await expect(adminRequest(socketPath, { op: "pair" }, 100)).rejects.toThrow(/adminRequestTimeoutMs=100/);
  });
});
