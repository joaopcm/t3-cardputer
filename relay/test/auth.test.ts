import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceAuth, LockedOutError, PairingError } from "../src/auth/devices.js";
import { Lockout, lockoutSourceKey } from "../src/auth/lockout.js";
import { DEFAULT_LIMITS } from "../src/config.js";
import { SecretsStore } from "../src/secrets.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "relay-auth-")), "secrets.json");
}

const ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DeviceAuth pairing", () => {
  it("creates 8 char codes from the unambiguous alphabet with the configured expiry", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), DEFAULT_LIMITS);
    const { code, expiresAt } = auth.createPairingCode();
    expect(code).toMatch(ALPHABET);
    expect(expiresAt.getTime()).toBe(Date.now() + DEFAULT_LIMITS.pairingCodeTtlMs);
  });

  it("pairing code redeems once", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), DEFAULT_LIMITS);
    const { code } = auth.createPairingCode();
    const paired = auth.redeem(code, "cardputer", "203.0.113.7");
    expect(paired.deviceId).toBeTruthy();
    expect(Buffer.from(paired.token, "base64url")).toHaveLength(32);
    expect(() => auth.redeem(code, "again", "203.0.113.7")).toThrow(PairingError);
    expect(auth.list()).toHaveLength(1);
  });

  it("redeem accepts lowercase and surrounding whitespace", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), DEFAULT_LIMITS);
    const { code } = auth.createPairingCode();
    expect(auth.redeem(` ${code.toLowerCase()} `, "cardputer", "s").token).toBeTruthy();
  });

  it("expired code is rejected", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), DEFAULT_LIMITS);
    const { code } = auth.createPairingCode();
    vi.advanceTimersByTime(DEFAULT_LIMITS.pairingCodeTtlMs + 1);
    expect(() => auth.redeem(code, "cardputer", "s")).toThrow(PairingError);
    expect(auth.list()).toHaveLength(0);
  });

  it("unknown and expired codes give the same error", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), DEFAULT_LIMITS);
    const { code } = auth.createPairingCode();
    vi.advanceTimersByTime(DEFAULT_LIMITS.pairingCodeTtlMs + 1);
    const messages = [code, "ZZZZZZZZ"].map((c) => {
      try {
        auth.redeem(c, "cardputer", "s");
      } catch (error) {
        expect(error).toBeInstanceOf(PairingError);
        return (error as Error).message;
      }
      return "no error";
    });
    expect(messages[0]).toBe(messages[1]);
  });

  it("codes are held in memory only", () => {
    const path = tmpPath();
    const auth = new DeviceAuth(new SecretsStore(path), DEFAULT_LIMITS);
    const { code } = auth.createPairingCode();
    expect(() => readFileSync(path, "utf8")).toThrow();
    auth.redeem(code, "cardputer", "s");
    expect(readFileSync(path, "utf8")).not.toContain(code);
  });

  it("rejects an empty device name without consuming the code", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), DEFAULT_LIMITS);
    const { code } = auth.createPairingCode();
    expect(() => auth.redeem(code, "  ", "s")).toThrow(/name/);
    expect(auth.redeem(code, "cardputer", "s").token).toBeTruthy();
  });
});

describe("DeviceAuth tokens", () => {
  function paired() {
    const path = tmpPath();
    const auth = new DeviceAuth(new SecretsStore(path), DEFAULT_LIMITS);
    const { code } = auth.createPairingCode();
    return { path, auth, ...auth.redeem(code, "cardputer", "s") };
  }

  it("secrets file never contains the plaintext token", () => {
    const { path, token } = paired();
    expect(readFileSync(path, "utf8")).not.toContain(token);
  });

  it("stores only the sha256 hex of the token", async () => {
    const { auth, token } = paired();
    const { createHash } = await import("node:crypto");
    expect(auth.list()[0]!.tokenSha256).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("verify returns the device for a good token", () => {
    const { auth, token, deviceId } = paired();
    expect(auth.verify(token, "s")?.id).toBe(deviceId);
  });

  it("verify rejects wrong, empty and truncated tokens", () => {
    const { auth, token } = paired();
    expect(auth.verify("nope", "s")).toBeNull();
    expect(auth.verify("", "s")).toBeNull();
    expect(auth.verify(token.slice(0, -1), "s")).toBeNull();
  });

  it("revoked token fails verify", () => {
    const { auth, token, deviceId } = paired();
    expect(auth.revoke(deviceId)).toBe(true);
    expect(auth.verify(token, "s")).toBeNull();
    expect(auth.list()).toHaveLength(0);
    expect(auth.revoke(deviceId)).toBe(false);
  });

  it("revocation by another process is seen on the next verify", () => {
    const { path, token } = paired();
    new SecretsStore(path).write({ devices: [] });
    const other = new DeviceAuth(new SecretsStore(path), DEFAULT_LIMITS);
    expect(other.verify(token, "s")).toBeNull();
  });

  it("verify updates lastSeenAt at most once per minute", () => {
    const { path, auth, token } = paired();
    const store = new SecretsStore(path);
    expect(auth.verify(token, "s")?.lastSeenAt).toBe("2026-10-20T12:00:00.000Z");
    const writes = vi.spyOn(store, "write");
    const counting = new DeviceAuth(store, DEFAULT_LIMITS);
    vi.advanceTimersByTime(30_000);
    counting.verify(token, "s");
    expect(writes).not.toHaveBeenCalled();
    expect(store.read().devices[0]!.lastSeenAt).toBe("2026-10-20T12:00:00.000Z");
    vi.advanceTimersByTime(30_000);
    counting.verify(token, "s");
    expect(writes).toHaveBeenCalledTimes(1);
    expect(store.read().devices[0]!.lastSeenAt).toBe("2026-10-20T12:01:00.000Z");
  });

  it("keeps the secrets file private and keeps other secrets", () => {
    const path = tmpPath();
    const store = new SecretsStore(path);
    store.write({ githubToken: "gh", devices: [] });
    chmodSync(path, 0o600);
    const auth = new DeviceAuth(store, DEFAULT_LIMITS);
    auth.redeem(auth.createPairingCode().code, "cardputer", "s");
    expect(store.read().githubToken).toBe("gh");
  });
});

describe("DeviceAuth lockout", () => {
  const limits = { ...DEFAULT_LIMITS, authFailuresPerWindow: 3, authWindowMs: 60_000 };

  it("wrong codes count as failures and then lock the source out", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), limits);
    const { code } = auth.createPairingCode();
    for (let i = 0; i < 3; i++) expect(() => auth.redeem("ZZZZZZZZ", "c", "evil")).toThrow(PairingError);
    expect(() => auth.redeem(code, "c", "evil")).toThrow(LockedOutError);
    expect(auth.redeem(code, "c", "friend").token).toBeTruthy();
  });

  it("bad tokens count as failures and then lock the source out for bad tokens only", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), limits);
    const { token } = auth.redeem(auth.createPairingCode().code, "c", "friend");
    for (let i = 0; i < 3; i++) expect(auth.verify("bad", "evil")).toBeNull();
    expect(() => auth.verify("bad", "evil")).toThrow(LockedOutError);
    expect(auth.verify(token, "evil")).not.toBeNull();
    expect(auth.verify(token, "friend")).not.toBeNull();
  });

  it("a valid token is never refused, even with the source locked out and the tracker full", () => {
    const full = { ...limits, authMaxTrackedSources: 1 };
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), full);
    const { token } = auth.redeem(auth.createPairingCode().code, "c", "friend");
    for (let i = 0; i < 3; i++) auth.verify("bad", "shared");
    expect(() => auth.verify("bad", "shared")).toThrow(LockedOutError);
    expect(auth.verify(token, "shared")).not.toBeNull();
    expect(auth.verify(token, "brand-new-source")).not.toBeNull();
  });

  it("redeem still fails closed when the tracker is full", () => {
    const full = { ...limits, authMaxTrackedSources: 1 };
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), full);
    auth.verify("bad", "a");
    const { code } = auth.createPairingCode();
    try {
      auth.redeem(code, "c", "new-source");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LockedOutError);
      expect((error as LockedOutError).reason).toBe("source_cap");
    }
  });

  it("successful verifies never count", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), limits);
    const { token } = auth.redeem(auth.createPairingCode().code, "c", "s");
    for (let i = 0; i < 50; i++) expect(auth.verify(token, "s")).not.toBeNull();
  });

  it("LockedOutError names the budget, the limit and the retry delay", () => {
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), limits);
    for (let i = 0; i < 3; i++) auth.verify("bad", "evil");
    try {
      auth.verify("bad", "evil");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LockedOutError);
      expect((error as LockedOutError).retryAfterMs).toBe(60_000);
      expect((error as Error).message).toContain("authFailuresPerWindow=3");
    }
  });
});

describe("Lockout", () => {
  it("lockout blocks after limit failures within window and reports retryAfterMs", () => {
    const lockout = new Lockout(3, 60_000, 100);
    expect(lockout.check("a")).toEqual({ allowed: true });
    lockout.recordFailure("a");
    lockout.recordFailure("a");
    expect(lockout.check("a").allowed).toBe(true);
    vi.advanceTimersByTime(10_000);
    lockout.recordFailure("a");
    expect(lockout.check("a")).toMatchObject({ allowed: false, retryAfterMs: 50_000 });
    expect(lockout.check("b")).toEqual({ allowed: true });
  });

  it("lockedOut lists only sources at the limit with their retry time", () => {
    const lockout = new Lockout(2, 60_000, 100);
    lockout.recordFailure("a");
    lockout.recordFailure("b");
    vi.advanceTimersByTime(10_000);
    lockout.recordFailure("a");
    expect(lockout.lockedOut()).toEqual([{ source: "a", retryAfterMs: 50_000 }]);
    vi.advanceTimersByTime(50_000);
    expect(lockout.lockedOut()).toEqual([]);
  });

  it("lockout window slides", () => {
    const lockout = new Lockout(3, 60_000, 100);
    lockout.recordFailure("a");
    vi.advanceTimersByTime(30_000);
    lockout.recordFailure("a");
    lockout.recordFailure("a");
    expect(lockout.check("a")).toMatchObject({ allowed: false, retryAfterMs: 30_000 });
    vi.advanceTimersByTime(30_000);
    expect(lockout.check("a").allowed).toBe(true);
    lockout.recordFailure("a");
    lockout.recordFailure("a");
    expect(lockout.check("a")).toMatchObject({ allowed: false, retryAfterMs: 30_000 });
  });

  it("failures while blocked do not extend the lockout", () => {
    const lockout = new Lockout(2, 60_000, 100);
    lockout.recordFailure("a");
    lockout.recordFailure("a");
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 100; i++) lockout.recordFailure("a");
    expect(lockout.check("a")).toMatchObject({ allowed: false, retryAfterMs: 30_000 });
  });

  it("evicts sources whose window expired", () => {
    const lockout = new Lockout(3, 60_000, 4);
    for (const source of ["a", "b", "c", "d"]) lockout.recordFailure(source);
    expect(lockout.trackedSources).toBe(4);
    vi.advanceTimersByTime(60_001);
    expect(lockout.check("e")).toEqual({ allowed: true });
    lockout.recordFailure("e");
    expect(lockout.trackedSources).toBe(1);
  });

  it("fails closed for new sources at the cap and says why", () => {
    const lockout = new Lockout(3, 60_000, 2);
    lockout.recordFailure("a");
    lockout.recordFailure("b");
    const result = lockout.check("c");
    expect(result).toMatchObject({ allowed: false, reason: "source_cap" });
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(lockout.check("a").allowed).toBe(true);
    lockout.recordFailure("c");
    expect(lockout.trackedSources).toBe(2);
  });

  it("recovers from the cap once windows expire", () => {
    const lockout = new Lockout(3, 60_000, 2);
    lockout.recordFailure("a");
    lockout.recordFailure("b");
    vi.advanceTimersByTime(60_001);
    expect(lockout.check("c")).toEqual({ allowed: true });
  });

  it("the cap reaches the caller as a LockedOutError naming the budget", () => {
    const limits = { ...DEFAULT_LIMITS, authFailuresPerWindow: 3, authWindowMs: 60_000 };
    const auth = new DeviceAuth(new SecretsStore(tmpPath()), { ...limits, authMaxTrackedSources: 1 });
    auth.verify("bad", "a");
    try {
      auth.verify("bad", "b");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LockedOutError);
      expect((error as LockedOutError).reason).toBe("source_cap");
      expect((error as Error).message).toContain("authMaxTrackedSources=1");
    }
  });
});

describe("Lockout at the cap", () => {
  it("does not rescan every source on each new-source check", () => {
    const lockout = new Lockout(3, 60_000, 3);
    for (const source of ["a", "b", "c"]) lockout.recordFailure(source);
    const scans = vi.spyOn(Map.prototype, "keys");
    for (let i = 0; i < 50; i++) expect(lockout.check(`new-${i}`).allowed).toBe(false);
    expect(scans.mock.calls.length).toBeLessThanOrEqual(1);
    scans.mockRestore();
  });
});

describe("lockoutSourceKey", () => {
  it("keeps IPv4 as is", () => {
    expect(lockoutSourceKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("unwraps IPv4-mapped IPv6 in dotted and hex form", () => {
    expect(lockoutSourceKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(lockoutSourceKey("::FFFF:cb00:7107")).toBe("203.0.113.7");
  });

  it("reduces a full IPv6 address to its /64", () => {
    expect(lockoutSourceKey("2001:0db8:85a3:0001:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:85a3:1::/64");
  });

  it("reduces compressed IPv6 addresses to the same /64", () => {
    const key = "2001:db8:85a3:1::/64";
    expect(lockoutSourceKey("2001:db8:85a3:1::1")).toBe(key);
    expect(lockoutSourceKey("2001:db8:85a3:1:0:0:0:ffff")).toBe(key);
    expect(lockoutSourceKey("2001:DB8:85A3:1::")).toBe(key);
  });

  it("handles compression inside the prefix and the unspecified address", () => {
    expect(lockoutSourceKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(lockoutSourceKey("::1")).toBe("0:0:0:0::/64");
    expect(lockoutSourceKey("::")).toBe("0:0:0:0::/64");
  });

  it("drops a zone id", () => {
    expect(lockoutSourceKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("different /64s get different keys", () => {
    expect(lockoutSourceKey("2001:db8:0:1::1")).not.toBe(lockoutSourceKey("2001:db8:0:2::1"));
  });

  it("passes a non-IP string through unchanged", () => {
    expect(lockoutSourceKey("unix-socket")).toBe("unix-socket");
  });
});
