import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { runSim } from "../src/sim/device-sim.js";
import { CHUNK_BYTES, CHUNK_MS, WavError, parseWav } from "../src/sim/wav.js";

function wavFile(pcm: Buffer, { rate = 16000, channels = 1, bits = 16 } = {}): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type Frame = { binary: true; bytes: number } | { binary: false; msg: Record<string, unknown> };

const HOME = { type: "home", rows: [{ threadId: "t1", kind: "running", project: "api", title: "migrate", ageSec: 5 }], counts: { needs: 0, running: 1, done: 0 }, approvals: { available: true }, warnings: [], t3: "ok" };
const PAGE = { type: "thread_page", threadId: "t1", header: { project: "api", title: "migrate", model: "m", status: "running" }, page: 1, pages: 1, lines: ["hello"] };

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function stub(onFrame: (ws: WebSocket, frame: Frame, frames: Frame[]) => void, onHello: (ws: WebSocket) => void = (ws) => ws.send(JSON.stringify(HOME))) {
  const frames: Frame[] = [];
  const pongs: number[] = [];
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (ws) => {
    ws.on("pong", () => pongs.push(Date.now()));
    ws.on("message", (data, isBinary) => {
      const frame: Frame = isBinary ? { binary: true, bytes: (data as Buffer).length } : { binary: false, msg: JSON.parse(data.toString()) };
      frames.push(frame);
      if (!frame.binary && frame.msg.type === "hello") {
        ws.send(JSON.stringify({ type: "welcome", v: 1, relay: "stub" }));
        onHello(ws);
      } else onFrame(ws, frame, frames);
    });
  });
  const port = (server.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}`, frames, pongs, server };
}

const ack = (ws: WebSocket, msg: Record<string, unknown>, ok = true, error?: string) =>
  ws.send(JSON.stringify({ type: "ack", id: msg.id, ok, ...(error === undefined ? {} : { error }) }));

const base = { token: "t", cols: 40, bodyRows: 8, maxFrameBytes: 4096, write: () => {} } as const;

describe("wav", () => {
  it("returns the pcm of a 16 kHz mono s16le file", () => {
    const pcm = Buffer.alloc(640, 1);
    expect(parseWav(wavFile(pcm))).toEqual(pcm);
  });

  it.each([
    ["44.1 kHz", { rate: 44100 }],
    ["stereo", { channels: 2 }],
    ["8 bit", { bits: 8 }],
  ])("rejects %s naming what it got", (_, format) => {
    expect(() => parseWav(wavFile(Buffer.alloc(4), format))).toThrow(WavError);
    expect(() => parseWav(wavFile(Buffer.alloc(4), format))).toThrow(/16000 Hz mono 16-bit PCM/);
  });

  it("rejects a file that is not wav", () => {
    expect(() => parseWav(Buffer.from("not a wav file at all"))).toThrow("not a RIFF/WAVE file");
  });
});

describe("simulator wire behavior", () => {
  it("streams a wav in real time between audio_start and audio_end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-wav-"));
    const pcm = Buffer.alloc(CHUNK_BYTES * 3 + 1600, 7);
    const wav = join(dir, "voice.wav");
    writeFileSync(wav, wavFile(pcm));
    const arrivals: number[] = [];
    const { url, frames } = await stub((ws, frame) => {
      if (frame.binary) {
        arrivals.push(Date.now());
        return;
      }
      ack(ws, frame.msg);
      if (frame.msg.type === "open_thread") ws.send(JSON.stringify(PAGE));
      if (frame.msg.type === "audio_end") ws.send(JSON.stringify({ type: "transcript_final", text: "ship it" }));
    });

    const result = await runSim({ ...base, url, wav, script: ["1", "/talk", "?ship it", "x"] });

    expect(result.problems).toEqual([]);
    const types = frames.map((f) => (f.binary ? "binary" : f.msg.type));
    expect(types).toEqual(["hello", "open_thread", "audio_start", "binary", "binary", "binary", "binary", "audio_end"]);
    expect(frames.filter((f) => f.binary).reduce((sum, f) => sum + (f.binary ? f.bytes : 0), 0)).toBe(pcm.length);
    expect(arrivals.at(-1)! - arrivals[0]!).toBeGreaterThanOrEqual(CHUNK_MS * 3 - 40);
    expect(result.screens.at(-1)).toContain("hello");
  });

  it("stops streaming when the relay refuses audio_start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-wav-"));
    const wav = join(dir, "voice.wav");
    writeFileSync(wav, wavFile(Buffer.alloc(CHUNK_BYTES * 5)));
    const { url, frames } = await stub((ws, frame) => {
      if (frame.binary) return;
      const refuse = frame.msg.type === "audio_start";
      ack(ws, frame.msg, !refuse, refuse ? "voice not available" : undefined);
      if (frame.msg.type === "open_thread") ws.send(JSON.stringify(PAGE));
    });

    const result = await runSim({ ...base, url, wav, script: ["1", "/talk", "?refused: voice not available"] });

    expect(result.problems).toEqual([]);
    expect(frames.filter((f) => f.binary)).toHaveLength(0);
    expect(frames.some((f) => !f.binary && f.msg.type === "audio_end")).toBe(false);
  });

  it("answers a relay ping with a pong", async () => {
    const { url, pongs } = await stub(() => {}, (ws) => {
      ws.send(JSON.stringify(HOME));
      ws.ping();
    });
    await runSim({ ...base, url, script: ["R"] });
    expect(pongs).toHaveLength(1);
  });

  it.each([
    [4400, "update firmware: device protocol v=1, relay v=2", "protocol mismatch"],
    [4401, "bad token", "re-pair"],
    [4402, "cols: too big", "hello rejected"],
    [4000, "", "taken over by another connection"],
  ])("close %i prints the documented device action and stops", async (code, message, action) => {
    const output: string[] = [];
    const { url } = await stub(() => {}, (ws) => {
      if (message !== "") ws.send(JSON.stringify({ type: "error", code: code === 4400 ? "protocol_version" : code === 4401 ? "auth" : "bad_message", message }));
      ws.close(code);
    });
    const result = await runSim({ ...base, url, write: (text) => output.push(text), script: ["R", "R"] });
    expect(result.closeCode).toBe(code);
    expect(output.join("")).toContain(action);
    expect(output.join("")).toContain(message);
  });

  it("reports frames that break the contract", async () => {
    const wide = { ...HOME, rows: [{ ...HOME.rows[0], title: "x".repeat(60) }] };
    const { url } = await stub(() => {}, (ws) => ws.send(JSON.stringify(wide)));
    const result = await runSim({ ...base, url, script: [] });
    expect(result.problems).toEqual([expect.stringContaining("home row too long for 40 cols")]);
  });
});
