import { createHash } from "node:crypto";
import type { ApprovalDecision, PendingApproval } from "../approvals/index.js";
import { FrameBudgetError } from "../protocol/frame.js";
import { LABEL_MAX, REF_MAX, type RelayMessage } from "../protocol/messages.js";
import { toDeviceAscii, wrap } from "../text/device-text.js";
import type { T3Question } from "../t3/mcp.js";
import { oneLine } from "./one-line.js";

export type RequestMessage = Extract<RelayMessage, { type: "request" }>;
export type RequestScreen = { cols: number; bodyRows: number; maxFrameBytes: number };
type RequestOption = RequestMessage["options"][number];

// receipt: docs/protocol.md request, question keys are the digits 1 to 9
const QUESTION_KEYS = "123456789";

const FREE_TEXT_OPTION: RequestOption = { key: "T", label: "Type answer", value: "text" };

const APPROVAL_OPTIONS: ReadonlyArray<{ decision: ApprovalDecision["kind"]; key: string; label: string }> = [
  { decision: "allow_once", key: "Y", label: "Allow once" },
  { decision: "allow_always", key: "A", label: "Always allow" },
  { decision: "deny", key: "N", label: "Deny" },
  { decision: "deny_with_reason", key: "T", label: "Deny, say why" },
];

// receipt: 80 bits of sha256 over (threadId, T3 request id); at 1000 live requests the chance of any two colliding is about 4e-19, and a collision needs the same thread anyway since respond looks up within one thread
export function requestHandle(threadId: string, t3RequestId: string): string {
  return createHash("sha256").update(`${threadId}\n${t3RequestId}`).digest("hex").slice(0, 20);
}

export function buildRequest(approval: PendingApproval, screen: RequestScreen): RequestMessage;
export function buildRequest(question: T3Question, screen: RequestScreen, threadId: string): RequestMessage;
export function buildRequest(item: PendingApproval | T3Question, screen: RequestScreen, threadId?: string): RequestMessage {
  if ("decisions" in item) return approvalRequest(item, screen);
  if (threadId === undefined) throw new TypeError("buildRequest: a question needs the threadId it was asked on");
  return questionRequest(item, screen, threadId);
}

function approvalRequest(approval: PendingApproval, screen: RequestScreen): RequestMessage {
  const { cols } = screen;
  const detail = approval.detail.flatMap((line) => wrap(indent(toDeviceAscii(line)), cols));
  const options = APPROVAL_OPTIONS.filter((o) => approval.decisions.includes(o.decision)).map(({ decision, key, label }) => ({
    key,
    label,
    value: decision,
  }));
  const lines = [...wrap(toDeviceAscii(approval.summary).trim(), cols), ...(detail.length > 0 ? ["", ...detail] : [])];
  return fitToScreen(
    (fitted) => ({ type: "request", threadId: approval.threadId, requestId: requestHandle(approval.threadId, approval.requestId), kind: "approval", lines: fitted, options }),
    { body: lines, tail: [], options: options.length, what: "command" },
    screen,
  );
}

function questionRequest(question: T3Question, screen: RequestScreen, threadId: string): RequestMessage {
  const { cols } = screen;
  const shown = question.options.slice(0, QUESTION_KEYS.length);
  const notes: string[] = [];
  if (question.options.length > shown.length) {
    notes.push(`showing ${shown.length} of ${question.options.length} options, T to type another`);
  }
  if (question.multiSelect) notes.push("pick one");

  const options: RequestOption[] = shown.map((option, i) => {
    if (option.value.length > REF_MAX) {
      throw new RangeError(`question option value too long: max_ref_chars=${REF_MAX}, option ${i + 1} needed ${option.value.length}`);
    }
    return { key: QUESTION_KEYS[i] as string, label: clip(oneLine(option.label) || "(blank)", LABEL_MAX), value: option.value };
  });
  if (question.options.length !== shown.length || question.options.length === 0) options.push(FREE_TEXT_OPTION);

  return fitToScreen(
    (fitted) => ({ type: "request", threadId, requestId: requestHandle(threadId, question.requestId), kind: "question", lines: fitted, options }),
    { body: wrap(oneLine(question.prompt), cols), tail: notes.flatMap((note) => wrap(`(${note})`, cols)), options: options.length, what: "question" },
    screen,
  );
}

type Content = { body: string[]; tail: string[]; options: number; what: "command" | "question" };

function frameBytes(msg: RequestMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), "utf8");
}

// receipt: docs/protocol.md request fit rule, the device shows lines then one row per option, so lines + options stay within bodyRows and the frame within maxFrameBytes
function fitToScreen(build: (lines: string[]) => RequestMessage, content: Content, screen: RequestScreen): RequestMessage {
  const { body, tail, what } = content;
  const rows = Math.max(1, screen.bodyRows - content.options - tail.length);
  const whole = build([...body, ...tail]);
  if (body.length <= rows && frameBytes(whole) <= screen.maxFrameBytes) return whole;
  let budget = body.length > rows ? `bodyRows=${screen.bodyRows}` : `maxFrameBytes=${screen.maxFrameBytes}`;
  for (let keep = Math.min(body.length, rows) - 1; keep >= 0; keep--) {
    const notice = wrap(`${what} truncated: ${body.length - keep} more lines, ${budget}`, screen.cols);
    if (keep > 0 && keep + notice.length > rows) continue;
    const msg = build([...[...body.slice(0, keep), ...notice].slice(0, rows), ...tail]);
    if (frameBytes(msg) <= screen.maxFrameBytes) return msg;
    budget = `maxFrameBytes=${screen.maxFrameBytes}`;
  }
  throw new FrameBudgetError("request", screen.maxFrameBytes, frameBytes(build(tail)));
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
