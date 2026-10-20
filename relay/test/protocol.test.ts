import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameBudgetError } from "../src/protocol/frame.js";
import {
  deviceMessageSchema,
  parseDeviceMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  relayMessageSchema,
  type RelayMessage,
} from "../src/protocol/messages.js";

const doc = readFileSync(new URL("../../docs/protocol.md", import.meta.url), "utf8");

function examples(side: "device" | "relay"): string[] {
  const fence = new RegExp("```json " + side + "\\n([\\s\\S]*?)```", "g");
  return [...doc.matchAll(fence)].map((m) => (m[1] ?? "").trim());
}

const hello = {
  type: "hello",
  v: 1,
  token: "tok",
  fw: "0.1.0",
  cols: 40,
  bodyRows: 11,
  maxFrameBytes: 4096,
  maxHomeRows: 8,
};

function parseError(raw: string): ProtocolError {
  try {
    parseDeviceMessage(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return e as ProtocolError;
  }
  throw new Error("expected parseDeviceMessage to throw");
}

describe("docs/protocol.md", () => {
  it("parses every device message example in docs/protocol.md", () => {
    const raws = examples("device");
    expect(raws.length).toBeGreaterThan(0);
    for (const raw of raws) {
      expect(() => parseDeviceMessage(raw), raw).not.toThrow();
    }
  });

  it("validates every relay message example in docs/protocol.md", () => {
    const raws = examples("relay");
    expect(raws.length).toBeGreaterThan(0);
    for (const raw of raws) {
      expect(relayMessageSchema.safeParse(JSON.parse(raw)).success, raw).toBe(true);
    }
  });

  it("has an example for every message type", () => {
    const seen = (side: "device" | "relay") =>
      new Set(examples(side).map((raw) => (JSON.parse(raw) as { type: string }).type));
    const typesOf = (options: readonly { shape: { type: { value: string } } }[]) =>
      options.map((o) => o.shape.type.value);
    const device = seen("device");
    const relay = seen("relay");
    for (const t of typesOf(deviceMessageSchema.options)) expect(device.has(t), t).toBe(true);
    for (const t of typesOf(relayMessageSchema.options)) expect(relay.has(t), t).toBe(true);
  });
});

describe("parseDeviceMessage", () => {
  it("accepts hello", () => {
    expect(parseDeviceMessage(JSON.stringify(hello))).toEqual(hello);
  });

  it("rejects reply without mode", () => {
    const err = parseError(
      JSON.stringify({ type: "reply", id: "r1", threadId: "t1", text: "hi" }),
    );
    expect(err.code).toBe("bad_message");
    expect(err.path).toBe("mode");
    expect(err.message).toContain("mode");
  });

  it('hello with v=2 is rejected with code "protocol_version"', () => {
    const err = parseError(JSON.stringify({ ...hello, v: 2 }));
    expect(err.code).toBe("protocol_version");
    expect(err.message).toContain(`v=2`);
    expect(err.message).toContain(`v=${PROTOCOL_VERSION}`);
  });

  it("rejects ids longer than 16 chars and empty ids", () => {
    const base = { type: "list_projects" };
    expect(parseError(JSON.stringify({ ...base, id: "x".repeat(17) })).path).toBe("id");
    expect(parseError(JSON.stringify({ ...base, id: "" })).path).toBe("id");
    expect(() => parseDeviceMessage(JSON.stringify({ ...base, id: "x".repeat(16) }))).not.toThrow();
  });

  it("accepts respond with optional text and rejects oversize text", () => {
    const respond = { type: "respond", id: "p1", threadId: "t", requestId: "q", value: "deny_with_reason" };
    expect(() => parseDeviceMessage(JSON.stringify(respond))).not.toThrow();
    expect(() => parseDeviceMessage(JSON.stringify({ ...respond, text: "too risky" }))).not.toThrow();
    expect(parseError(JSON.stringify({ ...respond, text: "x".repeat(100_000) })).path).toBe("text");
  });

  it("rejects an unknown launch runtimeMode and audio sampleRate other than 16000", () => {
    const launch = { type: "launch", id: "l1", projectId: "p", text: "go" };
    expect(() => parseDeviceMessage(JSON.stringify({ ...launch, runtimeMode: "auto" }))).not.toThrow();
    expect(parseError(JSON.stringify({ ...launch, runtimeMode: "yolo" })).path).toBe("runtimeMode");
    expect(parseError(JSON.stringify({ type: "audio_start", id: "a", sampleRate: 8000 })).path).toBe("sampleRate");
  });

  it("rejects non-json, unknown types and unknown fields", () => {
    expect(parseError("{nope").code).toBe("bad_message");
    expect(parseError(JSON.stringify({ type: "dance" })).path).toBe("type");
    expect(parseError(JSON.stringify({ ...hello, extra: 1 })).message).toContain("extra");
  });
});

describe("encodeFrame", () => {
  const welcome: RelayMessage = { type: "welcome", v: 1, relay: "0.1.0" };

  it("returns the json text when it fits", () => {
    expect(encodeFrame(welcome, 4096)).toBe(JSON.stringify(welcome));
  });

  it("throws FrameBudgetError naming max_frame_bytes and the message type", () => {
    const msg: RelayMessage = { type: "transcript_final", text: "x".repeat(200) };
    const needed = Buffer.byteLength(JSON.stringify(msg));
    try {
      encodeFrame(msg, 64);
    } catch (e) {
      expect(e).toBeInstanceOf(FrameBudgetError);
      expect((e as FrameBudgetError).message).toBe(
        `frame budget: max_frame_bytes=64, transcript_final needed ${needed}`,
      );
      return;
    }
    throw new Error("expected encodeFrame to throw");
  });

  it("measures bytes, not characters", () => {
    const msg: RelayMessage = { type: "transcript_final", text: "é" };
    const needed = Buffer.byteLength(JSON.stringify(msg));
    expect(() => encodeFrame(msg, needed - 1)).toThrow(FrameBudgetError);
    expect(() => encodeFrame(msg, needed)).not.toThrow();
  });
});
