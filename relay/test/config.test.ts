import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_PATH_ENV, DEFAULT_CONFIG, DEFAULT_CONFIG_PATH, DEFAULT_SECRETS_PATH, SECRETS_PATH_ENV, loadConfig, relayPathsFrom } from "../src/config.js";

function tmpFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "relay-config-")), "relay.json");
  writeFileSync(path, contents);
  return path;
}

describe("default paths", () => {
  it("pins config, secrets and state locations", () => {
    expect(DEFAULT_CONFIG_PATH).toBe(join(homedir(), ".config", "t3-cardputer", "relay.json"));
    expect(DEFAULT_SECRETS_PATH).toBe(join(homedir(), ".config", "t3-cardputer", "secrets.json"));
    expect(DEFAULT_CONFIG.stateDir).toBe(join(homedir(), ".local", "state", "t3-cardputer"));
  });
});

describe("relayPathsFrom", () => {
  it("uses the default paths unless the environment points elsewhere", () => {
    expect(relayPathsFrom({})).toEqual({ configPath: DEFAULT_CONFIG_PATH, secretsPath: DEFAULT_SECRETS_PATH });
    expect(relayPathsFrom({ [CONFIG_PATH_ENV]: "/tmp/staging/relay.json", [SECRETS_PATH_ENV]: "/tmp/s.json" })).toEqual({
      configPath: "/tmp/staging/relay.json",
      secretsPath: "/tmp/s.json",
    });
  });

  it("ignores empty values", () => {
    expect(relayPathsFrom({ [CONFIG_PATH_ENV]: "", [SECRETS_PATH_ENV]: "" })).toEqual({ configPath: DEFAULT_CONFIG_PATH, secretsPath: DEFAULT_SECRETS_PATH });
  });
});

describe("loadConfig", () => {
  it("returns defaults when file missing", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "relay-config-")), "nope.json");
    const config = loadConfig(missing);
    expect(config.port).toBeGreaterThan(0);
    expect(config.t3BaseUrl).toBe("http://127.0.0.1:3773");
    expect(config.limits.pollIntervalMs).toBeGreaterThan(0);
    expect(config.repair.maxAttemptsPerVersion).toBeGreaterThan(0);
  });

  it("requires the CI job named test before a repair PR can merge", () => {
    expect(loadConfig(join(tmpdir(), "missing-relay.json")).repair.requiredChecks).toEqual(["test"]);
  });

  it("rejects an empty repair.requiredChecks naming it", () => {
    expect(() => loadConfig(tmpFile(JSON.stringify({ repair: { requiredChecks: [] } })))).toThrow(/repair\.requiredChecks/);
  });

  it('rejects port 0 naming "port"', () => {
    const path = tmpFile(JSON.stringify({ port: 0 }));
    expect(() => loadConfig(path)).toThrow(/port.*0/);
  });

  it("merges nested values over defaults", () => {
    const path = tmpFile(JSON.stringify({ limits: { maxHomeRows: 7 }, whisper: { model: "tiny.en" } }));
    const config = loadConfig(path);
    expect(config.limits.maxHomeRows).toBe(7);
    expect(config.limits.maxReplyPages).toBe(loadConfig(join(tmpdir(), "missing-relay.json")).limits.maxReplyPages);
    expect(config.whisper.model).toBe("tiny.en");
    expect(config.whisper.binDir.length).toBeGreaterThan(0);
  });

  it("names the nested key and bad value", () => {
    const path = tmpFile(JSON.stringify({ limits: { audioMaxSeconds: -5 } }));
    expect(() => loadConfig(path)).toThrow(/limits\.audioMaxSeconds.*-5/);
  });

  it("rejects unknown keys naming them", () => {
    const path = tmpFile(JSON.stringify({ prot: 1 }));
    expect(() => loadConfig(path)).toThrow(/prot/);
  });

  it("names the file when JSON is malformed", () => {
    const path = tmpFile("{nope");
    expect(() => loadConfig(path)).toThrow(path);
  });
});
