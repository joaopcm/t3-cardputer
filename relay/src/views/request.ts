import type { ApprovalDecision, PendingApproval } from "../approvals/index.js";
import { LABEL_MAX, REF_MAX, type RelayMessage } from "../protocol/messages.js";
import { toDeviceAscii, wrap } from "../text/device-text.js";
import type { T3Question } from "../t3/mcp.js";
import { oneLine } from "./one-line.js";

export type RequestMessage = Extract<RelayMessage, { type: "request" }>;
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

export function buildRequest(approval: PendingApproval, cols: number): RequestMessage;
export function buildRequest(question: T3Question, cols: number, threadId: string): RequestMessage;
export function buildRequest(item: PendingApproval | T3Question, cols: number, threadId?: string): RequestMessage {
  if ("decisions" in item) return approvalRequest(item, cols);
  if (threadId === undefined) throw new TypeError("buildRequest: a question needs the threadId it was asked on");
  return questionRequest(item, cols, threadId);
}

function approvalRequest(approval: PendingApproval, cols: number): RequestMessage {
  const detail = approval.detail.flatMap((line) => wrap(indent(toDeviceAscii(line)), cols));
  return {
    type: "request",
    threadId: approval.threadId,
    requestId: approval.requestId,
    kind: "approval",
    lines: [...wrap(toDeviceAscii(approval.summary).trim(), cols), ...(detail.length > 0 ? ["", ...detail] : [])],
    options: APPROVAL_OPTIONS.filter((o) => approval.decisions.includes(o.decision)).map(({ decision, key, label }) => ({
      key,
      label,
      value: decision,
    })),
  };
}

function questionRequest(question: T3Question, cols: number, threadId: string): RequestMessage {
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

  return {
    type: "request",
    threadId,
    requestId: question.requestId,
    kind: "question",
    lines: [...wrap(oneLine(question.prompt), cols), ...notes.flatMap((note) => wrap(`(${note})`, cols))],
    options,
  };
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
