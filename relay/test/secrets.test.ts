import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretsStore, type Secrets } from "../src/secrets.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "relay-secrets-")), "secrets.json");
}

const sample: Secrets = {
  t3McpToken: { token: "mcp-token", expiresAt: "2026-11-19T00:00:00.000Z" },
  githubToken: "gh-token",
  devices: [{ id: "d1", name: "cardputer", tokenSha256: "ab".repeat(32), createdAt: "2026-10-20T00:00:00.000Z" }],
};

describe("SecretsStore", () => {
  it("returns empty secrets when file missing", () => {
    expect(new SecretsStore(tmpPath()).read()).toEqual({ devices: [] });
  });

  it("writes mode 0600", () => {
    const path = tmpPath();
    new SecretsStore(path).write(sample);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("round-trips", () => {
    const path = tmpPath();
    const store = new SecretsStore(path);
    store.write(sample);
    expect(store.read()).toEqual(sample);
  });

  it('refuses a 0644 file with message containing "chmod 600"', () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ devices: [] }));
    chmodSync(path, 0o644);
    expect(() => new SecretsStore(path).read()).toThrow(/chmod 600/);
  });

  it("refuses to overwrite a group-readable file", () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ devices: [] }));
    chmodSync(path, 0o640);
    expect(() => new SecretsStore(path).write(sample)).toThrow(/chmod 600/);
  });

  it("write is atomic", () => {
    const path = tmpPath();
    const store = new SecretsStore(path);
    store.write(sample);
    const before = readFileSync(path, "utf8");

    const poisoned: Secrets = { ...sample };
    Object.defineProperty(poisoned, "githubToken", {
      enumerable: true,
      get() {
        throw new Error("serializer exploded");
      },
    });

    expect(() => store.write(poisoned)).toThrow("serializer exploded");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(join(path, ".."))).toEqual(["secrets.json"]);
  });

  it("leaves no file when the first write fails", () => {
    const path = tmpPath();
    const poisoned = { devices: [] } as Secrets;
    Object.defineProperty(poisoned, "githubToken", {
      enumerable: true,
      get() {
        throw new Error("serializer exploded");
      },
    });
    expect(() => new SecretsStore(path).write(poisoned)).toThrow("serializer exploded");
    expect(existsSync(path)).toBe(false);
  });

  it("replaces a stale temp file left by an earlier process with the same pid", () => {
    const path = tmpPath();
    const stale = `${path}.${process.pid}.tmp`;
    writeFileSync(stale, "half-written by a dead relay", { mode: 0o600 });
    new SecretsStore(path).write(sample);
    expect(new SecretsStore(path).read()).toEqual(sample);
    expect(existsSync(stale)).toBe(false);
  });

  it("rejects malformed contents naming the file", () => {
    const path = tmpPath();
    writeFileSync(path, "{nope", { mode: 0o600 });
    expect(() => new SecretsStore(path).read()).toThrow(path);
  });
});
