import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Limits } from "../config.js";
import type { DeviceRecord, SecretsStore } from "../secrets.js";
import { Lockout, type LockoutDecision, type LockoutReason } from "./lockout.js";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const TOKEN_BYTES = 32;
// each persist rewrites and fsyncs the whole secrets file, and a connected device verifies on every reconnect
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;

export class PairingError extends Error {
  constructor() {
    super("pairing code invalid or expired");
    this.name = "PairingError";
  }
}

export class LockedOutError extends Error {
  constructor(
    readonly reason: LockoutReason,
    readonly retryAfterMs: number,
    lockout: Lockout,
  ) {
    const retry = `retry in ${Math.ceil(retryAfterMs / 1000)}s`;
    super(
      reason === "source_cap"
        ? `auth lockout tracking full: authMaxTrackedSources=${lockout.maxTrackedSources}, ${retry}`
        : `auth locked out: authFailuresPerWindow=${lockout.limitPerWindow} within authWindowMs=${lockout.windowMs}, ${retry}`,
    );
    this.name = "LockedOutError";
  }
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export class DeviceAuth {
  readonly lockout: Lockout;
  private readonly codes = new Map<string, number>();

  constructor(
    private readonly store: SecretsStore,
    private readonly limits: Pick<Limits, "pairingCodeTtlMs" | "authFailuresPerWindow" | "authWindowMs" | "authMaxTrackedSources">,
  ) {
    this.lockout = new Lockout(limits.authFailuresPerWindow, limits.authWindowMs, limits.authMaxTrackedSources);
  }

  createPairingCode(): { code: string; expiresAt: Date } {
    const now = Date.now();
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
    let code = generateCode();
    while (this.codes.has(code)) code = generateCode();
    const expiresAt = now + this.limits.pairingCodeTtlMs;
    this.codes.set(code, expiresAt);
    return { code, expiresAt: new Date(expiresAt) };
  }

  redeem(code: string, name: string, source: string): { deviceId: string; token: string } {
    this.assertAllowed(source);
    const deviceName = name.trim();
    if (!deviceName) throw new Error("device name must not be empty");
    const key = code.trim().toUpperCase();
    const expiresAt = this.codes.get(key);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      this.codes.delete(key);
      this.lockout.recordFailure(source);
      throw new PairingError();
    }
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const deviceId = randomUUID();
    const secrets = this.store.read();
    secrets.devices.push({
      id: deviceId,
      name: deviceName,
      tokenSha256: sha256(token).toString("hex"),
      createdAt: new Date().toISOString(),
    });
    this.store.write(secrets);
    this.codes.delete(key);
    return { deviceId, token };
  }

  verify(token: string, source: string): DeviceRecord | null {
    const digest = sha256(token);
    const secrets = this.store.read();
    let match: DeviceRecord | undefined;
    for (const device of secrets.devices) {
      const stored = Buffer.from(device.tokenSha256, "hex");
      if (stored.length === digest.length && timingSafeEqual(stored, digest)) match = device;
    }
    if (!match) {
      this.assertAllowed(source);
      this.lockout.recordFailure(source);
      return null;
    }
    const now = Date.now();
    if (match.lastSeenAt === undefined || now - Date.parse(match.lastSeenAt) >= LAST_SEEN_PERSIST_INTERVAL_MS) {
      match.lastSeenAt = new Date(now).toISOString();
      this.store.write(secrets);
    }
    return match;
  }

  list(): DeviceRecord[] {
    return this.store.read().devices;
  }

  revoke(deviceId: string): boolean {
    const secrets = this.store.read();
    const remaining = secrets.devices.filter((device) => device.id !== deviceId);
    if (remaining.length === secrets.devices.length) return false;
    this.store.write({ ...secrets, devices: remaining });
    return true;
  }

  private assertAllowed(source: string): void {
    const decision: LockoutDecision = this.lockout.check(source);
    if (!decision.allowed) throw new LockedOutError(decision.reason!, decision.retryAfterMs!, this.lockout);
  }
}
