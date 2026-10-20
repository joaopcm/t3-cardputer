import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFrame, encodePreWelcomeError, FrameBudgetError } from "../src/protocol/frame.js";
import {
  CLOSE_AUTH,
  CLOSE_BAD_HELLO,
  CLOSE_HELLO_TIMEOUT,
  CLOSE_PROTOCOL_VERSION,
  deviceMessageSchema,
  parseDeviceMessage,
  PRE_WELCOME_FRAME_BYTES,
  ProtocolError,
  REJECTION_TEXT_MAX,
  rejectionFor,
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

  it('hello with v=2 is rejected with code "protocol_version" and tells the user to update the relay', () => {
    const err = parseError(JSON.stringify({ ...hello, v: 2 }));
    expect(err.code).toBe("protocol_version");
    expect(err.message).toBe("update relay: device protocol v=2, relay v=1");
  });

  it('hello with v=0 is rejected with code "protocol_version" and tells the user to update the firmware', () => {
    const err = parseError(JSON.stringify({ ...hello, v: 0 }));
    expect(err.code).toBe("protocol_version");
    expect(err.message).toBe("update firmware: device protocol v=0, relay v=1");
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

describe("rejectionFor", () => {
  const reject = (raw: string, established = true) => rejectionFor(raw, parseError(raw), established);

  it("acks a malformed request that has a usable id", () => {
    const r = reject(JSON.stringify({ type: "reply", id: "r1", threadId: "t1", text: "hi" }));
    expect(r).toEqual({ kind: "ack", id: "r1", error: expect.stringContaining("mode") });
  });

  it("sends a bare bad_message error when the id is missing, empty, or too long", () => {
    for (const id of [undefined, "", "x".repeat(17), 7]) {
      const raw = JSON.stringify({ type: "reply", id, threadId: "t1", text: "hi" });
      expect(reject(raw)).toMatchObject({ kind: "error", code: "bad_message" });
      expect((reject(raw) as { close?: number }).close).toBeUndefined();
    }
    expect(reject("{nope")).toMatchObject({ kind: "error", code: "bad_message" });
  });

  it("closes an invalid hello with 4402 bad_hello, not 4401", () => {
    const r = reject(JSON.stringify({ ...hello, maxFrameBytes: 10 }), false);
    expect(r).toMatchObject({ kind: "error", code: "bad_message", close: CLOSE_BAD_HELLO });
    expect(CLOSE_BAD_HELLO).toBe(4402);
  });

  it("closes a first frame that is not a hello with 4402 bad_hello, keeping 4401 for rejected tokens only", () => {
    const r = reject(JSON.stringify({ type: "reply", id: "r1" }), false);
    expect(r).toMatchObject({ kind: "error", code: "bad_message", message: "first frame must be a valid hello", close: CLOSE_BAD_HELLO });
    expect(reject("{nope", false)).toMatchObject({ kind: "error", code: "bad_message", close: CLOSE_BAD_HELLO });
    expect(CLOSE_AUTH).toBe(4401);
    expect(CLOSE_HELLO_TIMEOUT).toBe(4408);
  });

  it("closes a version mismatch with 4400", () => {
    const r = reject(JSON.stringify({ ...hello, v: 2 }), false);
    expect(r).toMatchObject({ kind: "error", code: "protocol_version", close: CLOSE_PROTOCOL_VERSION });
  });

  it("keeps every pre-welcome rejection under PRE_WELCOME_FRAME_BYTES, even for hostile input", () => {
    const hostile = [
      JSON.stringify({ ...hello, v: Number.MAX_VALUE }),
      JSON.stringify({ ...hello, v: -Number.MAX_VALUE }),
      JSON.stringify({ ...hello, ["\u00e9".repeat(5000)]: 1 }),
      JSON.stringify({ ...hello, token: 5 }),
      JSON.stringify({ type: "x".repeat(5000) }),
      "{nope",
    ];
    let worst = 0;
    for (const raw of hostile) {
      const r = reject(raw, false);
      expect(r.kind).toBe("error");
      if (r.kind !== "error") continue;
      expect(r.message).toMatch(/^[\x20-\x7e]*$/);
      expect(r.message.length).toBeLessThanOrEqual(REJECTION_TEXT_MAX);
      const frame = encodePreWelcomeError(r.code, r.message);
      worst = Math.max(worst, Buffer.byteLength(frame));
    }
    expect(worst).toBeLessThanOrEqual(PRE_WELCOME_FRAME_BYTES);
  });

  it("measures envelope overhead of error and ack at the worst message length", () => {
    const text = "x".repeat(REJECTION_TEXT_MAX);
    const error = Buffer.byteLength(JSON.stringify({ type: "error", code: "protocol_version", message: text }));
    const ack = Buffer.byteLength(JSON.stringify({ type: "ack", id: "x".repeat(16), ok: false, error: text }));
    expect(Math.max(error, ack)).toBeLessThanOrEqual(PRE_WELCOME_FRAME_BYTES);
  });

  it("refuses to encode a pre-welcome error over the cap", () => {
    expect(() => encodePreWelcomeError("internal", "x".repeat(300))).toThrow(FrameBudgetError);
  });
});
