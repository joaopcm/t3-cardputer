import { AdapterBrokenError, type ApprovalsAdapter, type PendingApproval } from "./approvals/index.js";
import { DEFAULT_LIMITS } from "./config.js";
import type { T3Mcp } from "./t3/mcp.js";

// receipt: docs/receipts/2026-10-20-approvals-spike.md (f), Haiku at low effort is the cheapest usable model and ran every approval canary in the spike
const CANARY_MODEL_OPTIONS = [{ id: "effort", value: "low" }];
// receipt: docs/receipts/2026-10-20-approvals-spike.md (a), Claude auto-allows read-only commands like `true`, so only a write makes an approval fire
const CANARY_MESSAGE = "Run the shell command `touch t3-cardputer-canary.txt` and nothing else.";
const CANARY_TITLE = "t3-cardputer canary";

export type CanaryStage = "launch" | "approval_seen" | "respond" | "completed";
export type CanaryFailure = { ok: false; stage: CanaryStage; kind: "broken" | "transient"; reason: string };
export type CanaryResult = { ok: true; ms: number } | CanaryFailure;
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
  const fail = (stage: CanaryStage, kind: CanaryFailure["kind"], reason: string): CanaryFailure => ({ ok: false, stage, kind, reason });
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
    let approval: PendingApproval | undefined;
    let adapterAnswered = false;
    let lastError: unknown;
    while (approval === undefined) {
      try {
        approval = (await deps.approvals.listPending([threadId]))[0];
        adapterAnswered = true;
      } catch (error) {
        if (error instanceof AdapterBrokenError) throw error;
        lastError = error;
      }
      if (approval !== undefined) break;
      if (Date.now() >= deadline) {
        const waited = `canaryTimeoutMs=${opts.timeoutMs}, waited ${Date.now() - startedAt} ms`;
        return adapterAnswered
          ? fail(stage, "broken", `no approval appeared for thread ${threadId}: ${waited}`)
          : fail(stage, "transient", `the approvals adapter never answered for thread ${threadId}: ${waited}, last error: ${reasonOf(lastError)}`);
      }
      await sleep(pollIntervalMs);
    }

    stage = "respond";
    await deps.approvals.respond(threadId, approval.requestId, { kind: "allow_once" });

    stage = "completed";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail(stage, "broken", `approval answered but the run was not awaited: canaryTimeoutMs=${opts.timeoutMs} used up`);
    const run = await deps.t3.waitForRun(threadId, remaining);
    if (run.timedOut) return fail(stage, "broken", `run timed out after the approval: canaryTimeoutMs=${opts.timeoutMs}, status=${run.status}`);
    if (run.status !== "completed") return fail(stage, "broken", `run ended with status ${run.status} after the approval`);
    return { ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    return fail(stage, error instanceof AdapterBrokenError ? "broken" : "transient", reasonOf(error));
  } finally {
    if (threadId !== undefined) {
      await deps.t3.settleThread(threadId).catch((error: unknown) => {
        console.error(`canary could not settle scratch thread ${threadId}: ${reasonOf(error)}`, error);
      });
    }
  }
}
