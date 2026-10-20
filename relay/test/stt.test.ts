import { chmodSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_LIMITS, type Limits } from "../src/config.js";
import { AudioBuffer, BudgetError } from "../src/stt/audio-buffer.js";
import type { Stt } from "../src/stt/types.js";
import { createWhisperStt } from "../src/stt/whisper.js";
import { Device, cleanupAfterEach, onCleanup, startRelay } from "./helpers/relay-fixture.js";

cleanupAfterEach();

const pcm = (seconds: number) => Buffer.alloc(seconds * 32_000);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AudioBuffer", () => {
  it("toWav has a valid 44-byte header for 16k mono s16le", () => {
    const buffer = new AudioBuffer(16000, 10);
    buffer.push(Buffer.from([1, 0, 2, 0]));
    buffer.push(Buffer.from([3, 0]));
    const wav = buffer.toWav();
    expect(wav.length).toBe(44 + 6);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + 6);
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(6);
    expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0]);
  });

  it("durationSec counts samples at the sample rate", () => {
    const buffer = new AudioBuffer(16000, 10);
    buffer.push(pcm(2));
    buffer.push(Buffer.alloc(16_000));
    expect(buffer.durationSec).toBe(2.5);
  });

  it("push past maxSeconds throws naming audio_max_seconds", () => {
    const buffer = new AudioBuffer(16000, 2);
    buffer.push(pcm(2));
    expect(() => buffer.push(Buffer.alloc(2))).toThrow(BudgetError);
    expect(() => buffer.push(Buffer.alloc(2))).toThrow("audio budget: audio_max_seconds=2, recording reached 2s");
    expect(buffer.durationSec).toBe(2);
  });

  it("rejects an empty or odd-length chunk without keeping it", () => {
    const buffer = new AudioBuffer(16000, 2);
    expect(() => buffer.push(Buffer.alloc(0))).toThrow(RangeError);
    expect(() => buffer.push(Buffer.alloc(3))).toThrow(/even/);
    expect(buffer.durationSec).toBe(0);
  });
});

class RecordingStt implements Stt {
  readonly calls: Buffer[] = [];
  constructor(private readonly reply: () => Promise<string> = async () => "fix the flaky test") {}
  async transcribe(wav: Buffer): Promise<string> {
    this.calls.push(wav);
    return this.reply();
  }
}

async function voiceSetup(limits: Partial<Limits> = {}, stt: Stt = new RecordingStt()) {
  const relay = await startRelay(limits, stt);
  const { code } = relay.auth.createPairingCode();
  const { token } = relay.auth.redeem(code, "cardputer", "198.51.100.1");
  const device = await Device.open(relay.server.port);
  onCleanup(() => device.close());
  device.hello(token);
  await device.next("welcome");
  await device.next("home");
  return { ...relay, device, stt };
}

async function flush(device: Device): Promise<void> {
  device.send({ type: "list_projects", id: "flush" });
  await device.next("ack", (a) => a.id === "flush");
}

const START = { type: "audio_start", id: "s1", sampleRate: 16000 };

describe("voice session", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("transcribes audio between audio_start and audio_end, ack first then transcript_final", async () => {
    const { device, stt } = await voiceSetup();
    device.send(START);
    expect(await device.next("ack", (a) => a.id === "s1")).toEqual({ type: "ack", id: "s1", ok: true });
    device.ws.send(pcm(1).subarray(0, 3200), { binary: true });
    device.ws.send(pcm(1).subarray(0, 3200), { binary: true });
    device.send({ type: "audio_end", id: "e1" });
    const transcript = await device.next("transcript_final");
    expect(transcript.text).toBe("fix the flaky test");
    expect(await device.next("ack", (a) => a.id === "e1")).toEqual({ type: "ack", id: "e1", ok: true });
    const order = device.received.map((m) => m.type);
    expect(order.indexOf("ack", order.indexOf("ack") + 1)).toBeLessThan(order.indexOf("transcript_final"));
    const calls = (stt as RecordingStt).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.length).toBe(44 + 6400);
  });

  it("audio_cancel drops the buffer, no transcript, and the window is closed", async () => {
    const { device, stt } = await voiceSetup();
    device.send(START);
    await device.next("ack");
    device.ws.send(pcm(1).subarray(0, 3200), { binary: true });
    device.send({ type: "audio_cancel", id: "c1" });
    expect(await device.next("ack", (a) => a.id === "c1")).toMatchObject({ ok: true });
    device.ws.send(pcm(1).subarray(0, 3200), { binary: true });
    expect((await device.next("error")).code).toBe("audio_not_started");
    device.send({ type: "audio_end", id: "e1" });
    expect(await device.next("ack", (a) => a.id === "e1")).toMatchObject({ ok: false, error: expect.stringContaining("audio_start") });
    expect((stt as RecordingStt).calls).toHaveLength(0);
  });

  it('audio frames outside audio_start are rejected with error code "audio_not_started"', async () => {
    const { device, stt } = await voiceSetup();
    device.ws.send(pcm(1).subarray(0, 3200), { binary: true });
    const error = await device.next("error");
    expect(error.code).toBe("audio_not_started");
    expect(error.message).toContain("audio_start");
    expect((stt as RecordingStt).calls).toHaveLength(0);
  });

  it("an odd-length or empty frame inside the window is bad_audio and the window stays open", async () => {
    const { device, stt } = await voiceSetup();
    device.send(START);
    await device.next("ack");
    device.ws.send(Buffer.alloc(3), { binary: true });
    expect((await device.next("error")).code).toBe("bad_audio");
    device.ws.send(Buffer.alloc(0), { binary: true });
    expect((await device.next("error")).code).toBe("bad_audio");
    device.ws.send(Buffer.alloc(3200), { binary: true });
    device.send({ type: "audio_end", id: "e1" });
    await device.next("transcript_final");
    expect((stt as RecordingStt).calls[0]!.length).toBe(44 + 3200);
  });

  it("a second audio_start while the window is open is refused", async () => {
    const { device } = await voiceSetup();
    device.send(START);
    await device.next("ack");
    device.send({ ...START, id: "s2" });
    expect(await device.next("ack", (a) => a.id === "s2")).toMatchObject({ ok: false, error: expect.stringContaining("audio_end") });
  });

  it("recording past audioMaxSeconds closes the window with an error naming the budget, and audio_end repeats it", async () => {
    const { device, stt } = await voiceSetup({ audioMaxSeconds: 1 });
    device.send(START);
    await device.next("ack");
    device.ws.send(pcm(1), { binary: true });
    device.ws.send(Buffer.alloc(2), { binary: true });
    const error = await device.next("error");
    expect(error.code).toBe("bad_audio");
    expect(error.message).toBe("audio budget: audio_max_seconds=1, recording reached 1s");
    device.send({ type: "audio_end", id: "e1" });
    const ack = await device.next("ack", (a) => a.id === "e1");
    expect(ack).toEqual({ type: "ack", id: "e1", ok: false, error: "audio budget: audio_max_seconds=1, recording reached 1s" });
    expect((stt as RecordingStt).calls).toHaveLength(0);
    device.send({ type: "audio_end", id: "e2" });
    expect(await device.next("ack", (a) => a.id === "e2")).toMatchObject({ ok: false, error: expect.stringContaining("audio_start") });
  });

  it("idle timeout drops buffer and emits no transcript", async () => {
    const stt = new RecordingStt();
    const { device } = await voiceSetup({ audioIdleTimeoutMs: 5000 }, stt);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    device.send(START);
    await device.next("ack");
    device.ws.send(pcm(1).subarray(0, 3200), { binary: true });
    await flush(device);
    await vi.advanceTimersByTimeAsync(4999);
    expect(device.received.some((m) => m.type === "error")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await device.next("error");
    expect(error.code).toBe("bad_audio");
    expect(error.message).toBe("audio budget: audio_idle_timeout_ms=5000, no audio frame for 5000ms, recording dropped");
    device.send({ type: "audio_end", id: "e1" });
    const ack = await device.next("ack", (a) => a.id === "e1");
    expect(ack).toMatchObject({ ok: false, error: error.message });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device.received.some((m) => m.type === "transcript_final")).toBe(false);
    expect(stt.calls).toHaveLength(0);
  });

  it("every audio frame restarts the idle timer", async () => {
    const stt = new RecordingStt();
    const { device } = await voiceSetup({ audioIdleTimeoutMs: 5000 }, stt);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    device.send(START);
    await device.next("ack");
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      device.ws.send(Buffer.alloc(3200), { binary: true });
      await flush(device);
    }
    expect(device.received.some((m) => m.type === "error")).toBe(false);
    device.send({ type: "audio_end", id: "e1" });
    await device.next("transcript_final");
  });

  it("a failing Stt answers an error naming the failure, after the ack", async () => {
    const stt = new RecordingStt(async () => {
      throw new Error("whisper-server unreachable");
    });
    const { device } = await voiceSetup({}, stt);
    device.send(START);
    await device.next("ack");
    device.ws.send(Buffer.alloc(3200), { binary: true });
    device.send({ type: "audio_end", id: "e1" });
    expect(await device.next("ack", (a) => a.id === "e1")).toMatchObject({ ok: true });
    const error = await device.next("error");
    expect(error.code).toBe("internal");
    expect(error.message).toContain("whisper-server unreachable");
  });

  it("audio_end with no audio acks an error and never calls the Stt", async () => {
    const stt = new RecordingStt();
    const { device } = await voiceSetup({}, stt);
    device.send(START);
    await device.next("ack");
    device.send({ type: "audio_end", id: "e1" });
    expect(await device.next("ack", (a) => a.id === "e1")).toMatchObject({ ok: false, error: "no audio received" });
    expect(stt.calls).toHaveLength(0);
  });

  it("closing the socket mid-recording drops the buffer and its timer", async () => {
    const stt = new RecordingStt();
    const { device } = await voiceSetup({ audioIdleTimeoutMs: 20 }, stt);
    device.send(START);
    await device.next("ack");
    device.close();
    await device.closed;
    await pause(60);
    expect(stt.calls).toHaveLength(0);
  });

  it("transcript text is cleaned to printable one-line ascii", async () => {
    const stt = new RecordingStt(async () => "  “ship it”\n now  ");
    const { device } = await voiceSetup({}, stt);
    device.send(START);
    await device.next("ack");
    device.ws.send(Buffer.alloc(3200), { binary: true });
    device.send({ type: "audio_end", id: "e1" });
    expect((await device.next("transcript_final")).text).toBe('"ship it" now');
  });

  it("a stt warning shows on home and clears when it recovers", async () => {
    let warning: string | undefined;
    const listeners: (() => void)[] = [];
    const stt: Stt = {
      transcribe: async () => "",
      warning: () => warning,
      onWarningChange: (listener) => void listeners.push(listener),
    };
    const { device } = await voiceSetup({}, stt);
    warning = "voice down: test limit=3";
    for (const l of listeners) l();
    const home = await device.next("home", (h) => h.warnings.includes("voice down: test limit=3"));
    expect(home.warnings).toContain("voice down: test limit=3");
    warning = undefined;
    for (const l of listeners) l();
    await device.next("home", (h) => h.warnings.length === 0);
  });
});

const FAKE_SERVER = new URL("./fixtures/whisper/fake-whisper-server.mjs", import.meta.url).pathname;

function fakeWhisperDir(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-whisper-"));
  const binDir = join(root, "whisper");
  mkdirSync(join(binDir, "build", "bin"), { recursive: true });
  mkdirSync(join(root, "models"));
  const exports = Object.entries(env).map(([k, v]) => `export ${k}='${v}'`).join("\n");
  const script = join(binDir, "build", "bin", "whisper-server");
  writeFileSync(script, `#!/bin/sh\n${exports}\nexec ${process.execPath} ${FAKE_SERVER} "$@"\n`);
  chmodSync(script, 0o755);
  return { root, binDir };
}

const whisperLimits = {
  whisperRestartsPerWindow: 2,
  whisperRestartWindowMs: 60_000,
  whisperStartTimeoutMs: 5000,
  whisperRequestTimeoutMs: 5000,
} satisfies Partial<Limits>;

let nextPort = 18_900 + Math.floor(Math.random() * 500);

function makeWhisper(binDir: string, limits: Partial<Limits> = {}) {
  const whisper = createWhisperStt({
    whisper: { ...DEFAULT_CONFIG.whisper, binDir, model: "small.en", port: nextPort++, threads: 3 },
    limits: { ...DEFAULT_LIMITS, ...whisperLimits, ...limits },
  });
  onCleanup(() => whisper.close());
  return whisper;
}

const until = (done: () => boolean, ms = 4000) => vi.waitFor(() => expect(done()).toBe(true), { timeout: ms, interval: 20 });

describe("createWhisperStt", () => {
  it("posts the wav to the child's /inference with the configured model, threads and english", async () => {
    const { binDir, root } = fakeWhisperDir();
    const whisper = makeWhisper(binDir);
    const text = await whisper.transcribe(new AudioBuffer(16000, 5).toWav());
    expect(text).toBe(`heard /inference model=${join(root, "models", "ggml-small.en.bin")} threads=3 lang=en riff=true json=true`);
    expect(whisper.warning()).toBeUndefined();
  });

  it("restarts the child after it dies and keeps transcribing", async () => {
    const crashFile = join(mkdtempSync(join(tmpdir(), "relay-crash-")), "crash");
    const { binDir } = fakeWhisperDir({ FAKE_WHISPER_CRASH_FILE: crashFile });
    const whisper = makeWhisper(binDir);
    const wav = new AudioBuffer(16000, 5).toWav();
    await whisper.transcribe(wav);
    writeFileSync(crashFile, "");
    await expect(whisper.transcribe(wav)).rejects.toThrow(/whisper-server/);
    await until(() => whisper.restarts === 1);
    expect(existsSync(crashFile)).toBe(true);
    unlinkSync(crashFile);
    expect(await whisper.transcribe(wav)).toContain("heard /inference");
    expect(whisper.warning()).toBeUndefined();
  });

  it("reports every child pid to onSpawn, including the restarted one", async () => {
    const crashFile = join(mkdtempSync(join(tmpdir(), "relay-crash-")), "crash");
    const { binDir } = fakeWhisperDir({ FAKE_WHISPER_CRASH_FILE: crashFile });
    const pids: number[] = [];
    const whisper = createWhisperStt({
      whisper: { ...DEFAULT_CONFIG.whisper, binDir, model: "small.en", port: nextPort++, threads: 3 },
      limits: { ...DEFAULT_LIMITS, ...whisperLimits },
      onSpawn: (pid) => pids.push(pid),
    });
    onCleanup(() => whisper.close());
    const wav = new AudioBuffer(16000, 5).toWav();
    await whisper.transcribe(wav);
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0]!, 0)).not.toThrow();
    writeFileSync(crashFile, "");
    await expect(whisper.transcribe(wav)).rejects.toThrow(/whisper-server/);
    await until(() => pids.length === 2);
    expect(pids[1]).not.toBe(pids[0]);
    unlinkSync(crashFile);
  });

  it("a crash loop stops restarting and warns naming whisperRestartsPerWindow", async () => {
    const { binDir } = fakeWhisperDir({ FAKE_WHISPER_EXIT_ON_START: "1" });
    const whisper = makeWhisper(binDir);
    const changed = vi.fn();
    whisper.onWarningChange(changed);
    await until(() => whisper.warning() !== undefined);
    expect(whisper.warning()).toContain("whisperRestartsPerWindow=2");
    expect(whisper.warning()).toMatch(/^[\x20-\x7e]{1,120}$/);
    expect(changed).toHaveBeenCalled();
    await expect(whisper.transcribe(Buffer.alloc(44))).rejects.toThrow(/whisperRestartsPerWindow=2, whisperRestartWindowMs=60000/);
    expect(whisper.restarts).toBe(2);
  });

  it("transcribe fails naming whisperRequestTimeoutMs when the server never answers", async () => {
    const { binDir } = fakeWhisperDir({ FAKE_WHISPER_HANG: "1" });
    const whisper = makeWhisper(binDir, { whisperRequestTimeoutMs: 150 });
    await expect(whisper.transcribe(Buffer.alloc(44))).rejects.toThrow(/whisperRequestTimeoutMs=150/);
  });

  it("close stops the child without restarting it", async () => {
    const { binDir } = fakeWhisperDir();
    const whisper = makeWhisper(binDir);
    await whisper.transcribe(Buffer.alloc(44));
    await whisper.close();
    expect(whisper.restarts).toBe(0);
    await expect(whisper.transcribe(Buffer.alloc(44))).rejects.toThrow(/closed/);
  });
});
