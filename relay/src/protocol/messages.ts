import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const DEVICE_PATH = "/v1/device";

export const CLOSE_PROTOCOL_VERSION = 4400;
export const CLOSE_AUTH = 4401;
export const CLOSE_REPLACED = 4000;
export const CLOSE_BAD_HELLO = 4402;
export const CLOSE_HELLO_TIMEOUT = 4408;

export const ERROR_CODES = ["protocol_version", "auth", "hello_timeout", "bad_message", "bad_audio", "audio_not_started", "internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const REQUEST_ID_MAX = 16;
export const REF_MAX = 128;
export const TOKEN_MAX = 256;
export const FW_MAX = 32;
export const LABEL_MAX = 64;
// receipt: pending plan 2 (firmware measures its keyboard and heap)
export const REPLY_TEXT_MAX = 4000;
// receipt: T3 declares no length cap on t3_thread_send.message or t3_pending_request_respond.answers (tool schemas, 2026-10-20), so the cap is the device's typing budget, pending plan 2
export const RESPOND_TEXT_MAX = 1000;
// receipt: pending plan 2
export const COLS_MAX = 255;
// receipt: pending plan 2
export const BODY_ROWS_MAX = 64;
// receipt: relay/test/protocol.test.ts measures the worst pre-welcome frame over hostile input at 171 bytes
export const PRE_WELCOME_FRAME_BYTES = 256;
export const FRAME_BYTES_MIN = PRE_WELCOME_FRAME_BYTES;
// receipt: relay/test/protocol.test.ts measures error and ack envelopes at 60 bytes of overhead (180 bytes at 120 chars), under PRE_WELCOME_FRAME_BYTES
export const REJECTION_TEXT_MAX = 120;
// receipt: pending plan 2
export const FRAME_BYTES_MAX = 1_048_576;
// receipt: pending plan 2
export const HOME_ROWS_MAX = 255;
// receipt: the largest valid text frame is a launch with 4000 chars all JSON-escaped as \uXXXX (24 KB) plus 128-char refs, so 64 KiB only trips a broken or hostile client; it is also the audio chunk cap, 2.05 s of 16 kHz s16le against the 100 ms (3200 byte) chunks the simulator sends
export const DEVICE_FRAME_BYTES_MAX = 65_536;
// receipt: a device name is a short label listed by `devices`, the same budget as an option label
export const DEVICE_NAME_MAX = LABEL_MAX;
// receipt: the largest valid pair body is {"code":<8>,"name":<64 chars JSON-escaped at 6 bytes each>} at about 410 bytes
export const PAIR_BODY_BYTES_MAX = 1024;

export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export const WORKSPACES = ["root", "worktree"] as const;
export const HOME_KINDS = ["approval", "question", "failed", "running", "done"] as const;

const requestId = z.string().min(1).max(REQUEST_ID_MAX);
const ref = z.string().min(1).max(REF_MAX);
const runtimeMode = z.enum(RUNTIME_MODES);
const workspace = z.enum(WORKSPACES);
const count = z.number().int().nonnegative();
const sizedInt = (min: number, max: number) => z.number().int().min(min).max(max);

export const deviceMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    v: z.literal(PROTOCOL_VERSION),
    token: z.string().min(1).max(TOKEN_MAX),
    fw: z.string().min(1).max(FW_MAX),
    cols: sizedInt(1, COLS_MAX),
    bodyRows: sizedInt(1, BODY_ROWS_MAX),
    maxFrameBytes: sizedInt(FRAME_BYTES_MIN, FRAME_BYTES_MAX),
    maxHomeRows: sizedInt(1, HOME_ROWS_MAX),
  }),
  z.strictObject({ type: z.literal("open_thread"), id: requestId, threadId: ref }),
  z.strictObject({ type: z.literal("page"), id: requestId, threadId: ref, page: z.number().int().min(1) }),
  z.strictObject({
    type: z.literal("reply"),
    id: requestId,
    threadId: ref,
    text: z.string().min(1).max(REPLY_TEXT_MAX),
    mode: z.enum(["queue", "steer"]),
  }),
  z.strictObject({
    type: z.literal("respond"),
    id: requestId,
    threadId: ref,
    requestId: ref,
    value: ref,
    text: z.string().min(1).max(RESPOND_TEXT_MAX).optional(),
  }),
  z.strictObject({
    type: z.literal("launch"),
    id: requestId,
    projectId: ref,
    text: z.string().min(1).max(REPLY_TEXT_MAX),
    model: ref.optional(),
    workspace: workspace.optional(),
    runtimeMode: runtimeMode.optional(),
  }),
  z.strictObject({ type: z.literal("list_projects"), id: requestId }),
  z.strictObject({ type: z.literal("audio_start"), id: requestId, sampleRate: z.literal(16000) }),
  z.strictObject({ type: z.literal("audio_end"), id: requestId }),
  z.strictObject({ type: z.literal("audio_cancel"), id: requestId }),
]);

const homeRow = z.strictObject({
  threadId: ref,
  kind: z.enum(HOME_KINDS),
  project: z.string(),
  title: z.string(),
  ageSec: count,
});

const requestOption = z.strictObject({
  key: z.string().length(1),
  label: z.string().min(1).max(LABEL_MAX),
  value: ref,
});

export const relayMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("welcome"), v: z.literal(PROTOCOL_VERSION), relay: z.string() }),
  z.strictObject({ type: z.literal("ack"), id: requestId, ok: z.boolean(), error: z.string().optional() }),
  z.strictObject({
    type: z.literal("home"),
    rows: z.array(homeRow),
    counts: z.strictObject({ needs: count, running: count, done: count }),
    approvals: z.strictObject({ available: z.boolean(), reason: z.string().optional() }),
    warnings: z.array(z.string()),
    t3: z.enum(["ok", "unreachable"]),
  }),
  z.strictObject({
    type: z.literal("thread_page"),
    threadId: ref,
    header: z.strictObject({ project: z.string(), title: z.string(), model: z.string(), status: z.string() }),
    page: z.number().int().min(1),
    pages: z.number().int().min(1),
    lines: z.array(z.string()),
    truncated: z.strictObject({ budget: z.string(), limit: count, actual: count }).optional(),
  }),
  z.strictObject({
    type: z.literal("request"),
    threadId: ref,
    requestId: ref,
    kind: z.enum(["approval", "question"]),
    lines: z.array(z.string()),
    options: z.array(requestOption),
  }),
  z.strictObject({
    type: z.literal("projects"),
    items: z.array(
      z.strictObject({
        projectId: ref,
        name: z.string(),
        defaults: z.strictObject({ model: z.string(), workspace, runtimeMode }),
      }),
    ),
    truncated: z.strictObject({ budget: z.string(), limit: count, actual: count, hidden: count }).optional(),
  }),
  z.strictObject({ type: z.literal("transcript_partial"), text: z.string() }),
  z.strictObject({ type: z.literal("transcript_final"), text: z.string() }),
  z.strictObject({ type: z.literal("error"), code: z.enum(ERROR_CODES), message: z.string() }),
]);

export type DeviceMessage = z.infer<typeof deviceMessageSchema>;
export type RelayMessage = z.infer<typeof relayMessageSchema>;
export type HomeRow = z.infer<typeof homeRow>;

export class ProtocolError extends Error {
  readonly code: "protocol_version" | "bad_message";
  readonly path: string;

  constructor(code: "protocol_version" | "bad_message", message: string, path = "") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.path = path;
  }
}

export function parseDeviceMessage(raw: string): DeviceMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProtocolError("bad_message", "frame is not valid json");
  }

  if (isRecord(json) && json.type === "hello" && typeof json.v === "number" && json.v !== PROTOCOL_VERSION) {
    const side = json.v < PROTOCOL_VERSION ? "update firmware" : "update relay";
    throw new ProtocolError(
      "protocol_version",
      clipText(`${side}: device protocol v=${json.v}, relay v=${PROTOCOL_VERSION}`),
      "v",
    );
  }

  const result = deviceMessageSchema.safeParse(json);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = (issue?.path ?? []).join(".");
  const unrecognized = issue?.code === "unrecognized_keys" ? ` ${issue.keys.join(",")}` : "";
  throw new ProtocolError(
    "bad_message",
    clipText(`${path || "message"}: ${issue?.message ?? "invalid"}${unrecognized}`),
    path,
  );
}

export const FIRST_FRAME_NOT_HELLO = "first frame must be a valid hello";

export type Rejection =
  | { kind: "ack"; id: string; error: string }
  | { kind: "error"; code: ErrorCode; message: string; close?: number };

export function rejectionFor(raw: string, err: ProtocolError, established: boolean): Rejection {
  if (err.code === "protocol_version") {
    return { kind: "error", code: "protocol_version", message: err.message, close: CLOSE_PROTOCOL_VERSION };
  }

  const json = tryParse(raw);
  const type = isRecord(json) ? json.type : undefined;

  if (!established) {
    if (type === "hello") {
      return { kind: "error", code: "bad_message", message: err.message, close: CLOSE_BAD_HELLO };
    }
    return { kind: "error", code: "bad_message", message: FIRST_FRAME_NOT_HELLO, close: CLOSE_BAD_HELLO };
  }

  const id = isRecord(json) ? json.id : undefined;
  if (typeof id === "string" && id.length >= 1 && id.length <= REQUEST_ID_MAX) {
    return { kind: "ack", id, error: err.message };
  }
  return { kind: "error", code: "bad_message", message: err.message };
}

export function clipText(text: string): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, "?");
  if (ascii.length <= REJECTION_TEXT_MAX) return ascii;
  return `${ascii.slice(0, REJECTION_TEXT_MAX - 3)}...`;
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
