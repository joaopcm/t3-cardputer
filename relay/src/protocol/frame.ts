import { PRE_WELCOME_FRAME_BYTES, type ErrorCode, type RelayMessage } from "./messages.js";

export class FrameBudgetError extends Error {
  readonly budget = "max_frame_bytes";
  readonly limit: number;
  readonly actual: number;
  readonly messageType: RelayMessage["type"];

  constructor(messageType: RelayMessage["type"], limit: number, actual: number) {
    super(`frame budget: max_frame_bytes=${limit}, ${messageType} needed ${actual}`);
    this.name = "FrameBudgetError";
    this.messageType = messageType;
    this.limit = limit;
    this.actual = actual;
  }
}

export function encodeFrame(msg: RelayMessage, maxFrameBytes: number): string {
  const frame = JSON.stringify(msg);
  const actual = Buffer.byteLength(frame, "utf8");
  if (actual > maxFrameBytes) throw new FrameBudgetError(msg.type, maxFrameBytes, actual);
  return frame;
}

export function encodePreWelcomeError(code: ErrorCode, message: string): string {
  return encodeFrame({ type: "error", code, message }, PRE_WELCOME_FRAME_BYTES);
}
