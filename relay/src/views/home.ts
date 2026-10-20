import type { PendingApproval } from "../approvals/index.js";
import type { HomeRow, RelayMessage } from "../protocol/messages.js";
import type { T3Question, T3ThreadSummary } from "../t3/mcp.js";
import { oneLine } from "./one-line.js";

export type HomeMessage = Extract<RelayMessage, { type: "home" }>;

export type HomeInput = {
  threads: (T3ThreadSummary & { project: string })[];
  approvals: PendingApproval[];
  questions: Map<string, T3Question[]>;
  now: Date;
  maxRows: number;
  cols: number;
  approvalsState: { available: boolean; reason?: string };
  warnings: string[];
  t3: "ok" | "unreachable";
};

// receipt: docs/protocol.md home bucket rule, completed threads stay on home for 24 h
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

// receipt: docs/protocol.md home row layout, `<marker> <project> <title> <age>` with a 1 col marker, 4 col age, 3 single-space separators
export const HOME_ROW_OVERHEAD_COLS = 1 + 4 + 3;
// receipt: docs/protocol.md home row layout, project gets at most a third of the line
export const HOME_PROJECT_COLS_DIVISOR = 3;
const CLIP_MARK = "~";

const FAILED_STATUSES = new Set(["failed", "interrupted", "cancelled"]);
const RUNNING_STATUSES = new Set(["preparing", "queued", "starting", "running"]);

const KIND_ORDER: Record<HomeRow["kind"], number> = { approval: 0, question: 1, failed: 2, running: 3, done: 4 };

type Entry = { row: HomeRow; updatedMs: number };

export function buildHome(input: HomeInput): HomeMessage {
  const nowMs = input.now.getTime();
  const withApproval = new Set(input.approvals.map((a) => a.threadId));
  const withQuestion = new Set([...input.questions].filter(([, qs]) => qs.length > 0).map(([id]) => id));

  const projectCols = Math.max(1, Math.floor(input.cols / HOME_PROJECT_COLS_DIVISOR));
  const warnings = input.warnings.map(oneLine);
  const unknownStatuses = new Set<string>();
  const badTimes: string[] = [];

  const entries: Entry[] = [];
  for (const thread of input.threads) {
    const parsed = Date.parse(thread.updatedAt);
    const timeOk = Number.isFinite(parsed);
    const updatedMs = timeOk ? parsed : nowMs;
    if (!timeOk) badTimes.push(oneLine(thread.title));
    const kind = kindOf(thread, updatedMs, nowMs, withApproval, withQuestion);
    if (!isKnownStatus(thread.status)) {
      const status = oneLine(thread.status);
      if (!unknownStatuses.has(status)) {
        unknownStatuses.add(status);
        warnings.push(`unknown thread status "${status}" on ${oneLine(thread.title)}`);
      }
    }
    if (kind === undefined) continue;
    const project = clip(oneLine(thread.project), projectCols);
    const titleCols = Math.max(1, input.cols - HOME_ROW_OVERHEAD_COLS - project.length);
    entries.push({
      updatedMs,
      row: {
        threadId: thread.threadId,
        kind,
        project,
        title: clip(oneLine(thread.title), titleCols),
        ageSec: Math.max(0, Math.floor((nowMs - updatedMs) / 1000)),
      },
    });
  }
  if (badTimes.length > 0) {
    warnings.push(`unparseable updatedAt on ${badTimes.length} thread(s), first: ${badTimes[0]}`);
  }

  entries.sort((a, b) => {
    const byKind = KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind];
    if (byKind !== 0) return byKind;
    return bucketOf(a.row.kind) === "needs" ? a.updatedMs - b.updatedMs : b.updatedMs - a.updatedMs;
  });

  const counts = { needs: 0, running: 0, done: 0 };
  for (const { row } of entries) {
    counts[bucketOf(row.kind)]++;
  }

  const approvals = { available: input.approvalsState.available };
  return {
    type: "home",
    rows: entries.slice(0, input.maxRows).map((e) => e.row),
    counts,
    approvals: input.approvalsState.reason === undefined ? approvals : { ...approvals, reason: oneLine(input.approvalsState.reason) },
    warnings,
    t3: input.t3,
  };
}

function bucketOf(kind: HomeRow["kind"]): "needs" | "running" | "done" {
  return kind === "running" || kind === "done" ? kind : "needs";
}

function kindOf(
  thread: T3ThreadSummary,
  updatedMs: number,
  nowMs: number,
  withApproval: Set<string>,
  withQuestion: Set<string>,
): HomeRow["kind"] | undefined {
  if (withApproval.has(thread.threadId)) return "approval";
  if (withQuestion.has(thread.threadId)) return "question";
  if (FAILED_STATUSES.has(thread.status)) return "failed";
  if (RUNNING_STATUSES.has(thread.status)) return "running";
  if (thread.status === "completed") return nowMs - updatedMs <= DONE_WINDOW_MS ? "done" : undefined;
  return "failed";
}

function clip(text: string, cols: number): string {
  if (text.length <= cols) return text;
  return cols <= 1 ? CLIP_MARK : `${text.slice(0, cols - 1)}${CLIP_MARK}`;
}

function isKnownStatus(status: string): boolean {
  return FAILED_STATUSES.has(status) || RUNNING_STATUSES.has(status) || status === "completed";
}
