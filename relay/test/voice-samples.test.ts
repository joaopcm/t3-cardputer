import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig, samplesDirOf } from "../src/config.js";
import type { Stt } from "../src/stt/types.js";
import { Device, cleanupAfterEach, onCleanup, startRelay } from "./helpers/relay-fixture.js";

cleanupAfterEach();

const pcm = (seconds: number) => Buffer.alloc(seconds * 32_000);

const loud = () => {
  const frame = Buffer.alloc(3200);
  frame.writeInt16LE(16384, 0);
  frame.writeInt16LE(-8000, 2);
  return frame;
};

const stt: Stt = { transcribe: async () => "secret words" };

async function setup(sttConfig: Partial<(typeof DEFAULT_CONFIG)["stt"]>, deviceStt: Stt = stt) {
  const samplesDir = join(mkdtempSync(join(tmpdir(), "relay-samples-")), "voice-samples");
  const relay = await startRelay({}, deviceStt, { stt: { ...DEFAULT_CONFIG.stt, samplesDir, ...sttConfig } });
  const { code } = relay.auth.createPairingCode();
  const { token, deviceId } = relay.auth.redeem(code, "cardputer", "198.51.100.1");
  const device = await Device.open(relay.server.port);
  onCleanup(() => device.close());
  device.hello(token);
  await device.next("welcome");
  await device.next("home");
  return { ...relay, device, samplesDir, deviceId };
}

async function record(device: Device, id: string, frames: Buffer[] = [loud()]) {
  device.send({ type: "audio_start", id: `s-${id}`, sampleRate: 16000 });
  for (const frame of frames) device.ws.send(frame, { binary: true });
  device.send({ type: "audio_end", id: `e-${id}` });
  await device.next("transcript_final");
}

const files = (dir: string) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

describe("stt config", () => {
  it("keeps samples off by default with a cap of 50", () => {
    expect(DEFAULT_CONFIG.stt.keepSamples).toBe(false);
    expect(DEFAULT_CONFIG.stt.maxSamples).toBe(50);
  });

  it("samplesDir defaults to <stateDir>/voice-samples and can be overridden", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-config-"));
    const path = join(dir, "relay.json");
    writeFileSync(path, JSON.stringify({ stateDir: "/var/relay-state", stt: { keepSamples: true } }));
    const config = loadConfig(path);
    expect(config.stt.keepSamples).toBe(true);
    expect(samplesDirOf(config)).toBe("/var/relay-state/voice-samples");
    writeFileSync(path, JSON.stringify({ stt: { samplesDir: "/srv/wavs" } }));
    expect(samplesDirOf(loadConfig(path))).toBe("/srv/wavs");
  });

  it("rejects a non-boolean keepSamples and a zero cap naming the key", () => {
    const path = join(mkdtempSync(join(tmpdir(), "relay-config-")), "relay.json");
    writeFileSync(path, JSON.stringify({ stt: { keepSamples: "yes" } }));
    expect(() => loadConfig(path)).toThrow(/stt\.keepSamples/);
    writeFileSync(path, JSON.stringify({ stt: { maxSamples: 0 } }));
    expect(() => loadConfig(path)).toThrow(/stt\.maxSamples/);
  });
});

describe("kept voice samples", () => {
  afterEach(() => vi.restoreAllMocks());

  it("saves nothing when keepSamples is off", async () => {
    const { device, samplesDir } = await setup({ keepSamples: false });
    await record(device, "1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(files(samplesDir)).toEqual([]);
  });

  it("saves wav and json sidecar with private modes when on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { device, samplesDir, deviceId } = await setup({ keepSamples: true });
    const frames = [loud(), loud()];
    await record(device, "1", frames);
    await vi.waitFor(() => expect(files(samplesDir)).toHaveLength(2));
    const [json, wav] = files(samplesDir).sort((a, b) => a.localeCompare(b)) as [string, string];
    const stem = wav.replace(/\.wav$/, "");
    expect(json).toBe(`${stem}.json`);
    expect(stem).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z-${deviceId.slice(0, 8)}$`));

    expect(statSync(samplesDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(samplesDir, wav)).mode & 0o777).toBe(0o600);
    expect(statSync(join(samplesDir, json)).mode & 0o777).toBe(0o600);

    const saved = readFileSync(join(samplesDir, wav));
    expect(saved.length).toBe(44 + 6400);
    expect(saved.toString("ascii", 0, 4)).toBe("RIFF");

    const sidecar = JSON.parse(readFileSync(join(samplesDir, json), "utf8"));
    expect(sidecar).toMatchObject({ durationSec: 0.2, transcript: "secret words", model: DEFAULT_CONFIG.whisper.model });
    expect(sidecar.transcribeMs).toBeGreaterThanOrEqual(0);
    expect(sidecar.peakDbfs).toBeCloseTo(-6.02, 1);

    const lines = log.mock.calls.map((call) => String(call[0]));
    const line = lines.find((l) => l.includes(join(samplesDir, wav)));
    expect(line).toContain("0.2");
    expect(lines.join("\n")).not.toContain("secret words");
    expect(files(samplesDir).some((f) => f.includes(".tmp"))).toBe(false);
  });

  it("writes null peakDbfs for pure silence", async () => {
    const { device, samplesDir } = await setup({ keepSamples: true });
    await record(device, "1", [pcm(1)]);
    await vi.waitFor(() => expect(files(samplesDir)).toHaveLength(2));
    const json = files(samplesDir).find((f) => f.endsWith(".json"))!;
    expect(JSON.parse(readFileSync(join(samplesDir, json), "utf8")).peakDbfs).toBeNull();
  });

  it("does not save a cancelled recording", async () => {
    const { device, samplesDir } = await setup({ keepSamples: true });
    device.send({ type: "audio_start", id: "s1", sampleRate: 16000 });
    await device.next("ack", (a) => a.id === "s1");
    device.ws.send(loud(), { binary: true });
    device.send({ type: "audio_cancel", id: "c1" });
    await device.next("ack", (a) => a.id === "c1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(files(samplesDir)).toEqual([]);
  });

  it("refuses past maxSamples naming the limit and keeps the old ones", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { device, samplesDir } = await setup({ keepSamples: true, maxSamples: 2 });
    await record(device, "1");
    await vi.waitFor(() => expect(files(samplesDir)).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await record(device, "2");
    await vi.waitFor(() => expect(files(samplesDir)).toHaveLength(4));
    const before = files(samplesDir);
    await record(device, "3");
    await vi.waitFor(() => expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("stt.maxSamples=2"));
    const message = error.mock.calls.map((c) => String(c[0])).find((m) => m.includes("stt.maxSamples"))!;
    expect(message).toContain(samplesDir);
    expect(message).not.toContain("secret words");
    expect(files(samplesDir)).toEqual(before);
  });

  it("a save failure is logged and does not stop the transcript", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const parent = join(mkdtempSync(join(tmpdir(), "relay-samples-")), "blocker");
    writeFileSync(parent, "");
    const { device } = await setup({ keepSamples: true, samplesDir: join(parent, "voice-samples") });
    await record(device, "1");
    await vi.waitFor(() => expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("voice sample not saved"));
  });
});
