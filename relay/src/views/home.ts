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
  approvalsState: { available: boolean; reason?: string };
  warnings: string[];
  t3: "ok" | "unreachable";
};

// receipt: docs/protocol.md home bucket rule, completed threads stay on home for 24 h
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

const FAILED_STATUSES = new Set(["failed", "interrupted", "cancelled"]);
const RUNNING_STATUSES = new Set(["preparing", "queued", "starting", "running"]);

const KIND_ORDER: Record<HomeRow["kind"], number> = { approval: 0, question: 1, failed: 2, running: 3, done: 4 };

type Entry = { row: HomeRow; updatedMs: number };

export function buildHome(input: HomeInput): HomeMessage {
  const nowMs = input.now.getTime();
  const withApproval = new Set(input.approvals.map((a) => a.threadId));
  const withQuestion = new Set([...input.questions].filter(([, qs]) => qs.length > 0).map(([id]) => id));

  const entries: Entry[] = [];
  for (const thread of input.threads) {
    const parsed = Date.parse(thread.updatedAt);
    const updatedMs = Number.isFinite(parsed) ? parsed : nowMs;
    const kind = kindOf(thread, updatedMs, nowMs, withApproval, withQuestion);
    if (kind === undefined) continue;
    entries.push({
      updatedMs,
      row: {
        threadId: thread.threadId,
        kind,
        project: oneLine(thread.project),
        title: oneLine(thread.title),
        ageSec: Math.max(0, Math.floor((nowMs - updatedMs) / 1000)),
      },
    });
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
    warnings: input.warnings.map(oneLine),
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
  if (thread.status === "completed" && nowMs - updatedMs <= DONE_WINDOW_MS) return "done";
  return undefined;
}
