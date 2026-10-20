import { AdapterBrokenError, type ApprovalsAdapter } from "./approvals/index.js";
import { DEFAULT_LIMITS } from "./config.js";
import type { T3Mcp } from "./t3/mcp.js";

// receipt: docs/receipts/2026-10-20-approvals-spike.md (f), Haiku at low effort is the cheapest usable model and ran every approval canary in the spike
const CANARY_MODEL_OPTIONS = [{ id: "effort", value: "low" }];
// receipt: docs/receipts/2026-10-20-approvals-spike.md (a), Claude auto-allows read-only commands like `true`, so only a write makes an approval fire
const CANARY_MESSAGE = "Run the shell command `touch t3-cardputer-canary.txt` and nothing else.";
const CANARY_TITLE = "t3-cardputer canary";

export type CanaryStage = "launch" | "approval_seen" | "respond" | "completed";
export type CanaryResult = { ok: true; ms: number } | { ok: false; stage: CanaryStage; reason: string };
export type CanaryFailure = Extract<CanaryResult, { ok: false }>;
export type CanaryDeps = {
  t3: Pick<T3Mcp, "launch" | "waitForRun" | "settleThread">;
  approvals: Pick<ApprovalsAdapter, "listPending" | "respond">;
};
export type CanaryOptions = { model: string; timeoutMs: number; pollIntervalMs?: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function reasonOf(error: unknown): string {
  if (error instanceof AdapterBrokenError) return error.reason;
  return error instanceof Error ? error.message : String(error);
}

export async function runCanary(deps: CanaryDeps, opts: CanaryOptions): Promise<CanaryResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_LIMITS.pollIntervalMs;
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutMs;
  const fail = (stage: CanaryStage, reason: string): CanaryFailure => ({ ok: false, stage, reason });
  let stage: CanaryStage = "launch";
  let threadId: string | undefined;

  try {
    ({ threadId } = await deps.t3.launch({
      scratch: true,
      title: CANARY_TITLE,
      message: CANARY_MESSAGE,
      model: opts.model,
      options: CANARY_MODEL_OPTIONS,
      workspace: "root",
      runtimeMode: "approval-required",
    }));

    stage = "approval_seen";
    let approval = (await deps.approvals.listPending([threadId]))[0];
    while (approval === undefined) {
      if (Date.now() >= deadline) return fail(stage, `no approval appeared for thread ${threadId}: canaryTimeoutMs=${opts.timeoutMs}, waited ${Date.now() - startedAt} ms`);
      await sleep(pollIntervalMs);
      approval = (await deps.approvals.listPending([threadId]))[0];
    }

    stage = "respond";
    await deps.approvals.respond(threadId, approval.requestId, { kind: "allow_once" });

    stage = "completed";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail(stage, `approval answered but the run was not awaited: canaryTimeoutMs=${opts.timeoutMs} used up`);
    const run = await deps.t3.waitForRun(threadId, remaining);
    if (run.timedOut) return fail(stage, `run timed out after the approval: canaryTimeoutMs=${opts.timeoutMs}, status=${run.status}`);
    if (run.status !== "completed") return fail(stage, `run ended with status ${run.status} after the approval`);
    return { ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    return fail(stage, reasonOf(error));
  } finally {
    if (threadId !== undefined) {
      await deps.t3.settleThread(threadId).catch((error: unknown) => {
        console.error(`canary could not settle scratch thread ${threadId}: ${reasonOf(error)}`, error);
      });
    }
  }
}

export type CanaryReactions = {
  markApprovalsUp(): void;
  markApprovalsDown(reason: string): void;
  onCanaryFailed?(failure: CanaryFailure, versions: { from?: string; to: string }): void;
};

export function reactToCanary(result: CanaryResult, versions: { from?: string; to: string }, reactions: CanaryReactions): void {
  if (result.ok) {
    console.log(`canary passed in ${result.ms} ms on T3 ${versions.to}`);
    reactions.markApprovalsUp();
    return;
  }
  console.error(`canary failed at ${result.stage} on T3 ${versions.to}: ${result.reason}`);
  if (result.stage === "launch") return;
  reactions.markApprovalsDown(`canary ${result.stage}: ${result.reason}`);
  try {
    reactions.onCanaryFailed?.(result, versions);
  } catch (error) {
    console.error("onCanaryFailed threw, approvals stay marked down", error);
  }
}
