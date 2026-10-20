import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CanaryFailure, CanaryResult } from "./canary.js";
import type { T3Environment } from "./t3/environment.js";

const seenSchema = z.object({ serverVersion: z.string(), orchestrationProtocolVersion: z.number().int() });
const verdictSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("pass") }),
  z.object({ verdict: z.literal("broken"), stage: z.enum(["launch", "approval_seen", "respond", "completed"]), reason: z.string() }),
]);
const stateSchema = z.intersection(seenSchema, verdictSchema);

export type Seen = z.infer<typeof seenSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type VersionCheck = { current: Seen; to: string; from?: string; changed: boolean; saved?: Verdict };
type Versions = { from?: string; to: string };

export const canaryDownReason = (failure: { stage: string; reason: string }) => `canary ${failure.stage}: ${failure.reason}`;

const label = (seen: Seen) => `${seen.serverVersion}+orch${seen.orchestrationProtocolVersion}`;

export function verdictOf(result: CanaryResult): Verdict | undefined {
  if (result.ok) return { verdict: "pass" };
  return result.kind === "broken" ? { verdict: "broken", stage: result.stage, reason: result.reason } : undefined;
}

export class VersionWatch {
  constructor(
    private readonly getEnv: () => Promise<Pick<T3Environment, "serverVersion" | "orchestrationProtocolVersion">>,
    private readonly statePath: string,
  ) {}

  async check(): Promise<VersionCheck> {
    const { serverVersion, orchestrationProtocolVersion } = await this.getEnv();
    const current: Seen = { serverVersion, orchestrationProtocolVersion };
    const state = this.load();
    if (state === undefined) return { current, to: label(current), changed: true };
    if (label(state) !== label(current)) return { current, to: label(current), from: label(state), changed: true };
    return { current, to: label(current), changed: false, saved: state.verdict === "pass" ? { verdict: "pass" } : { verdict: "broken", stage: state.stage, reason: state.reason } };
  }

  record(seen: Seen, verdict: Verdict): void {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ ...seen, ...verdict }, null, 2));
      renameSync(tmp, this.statePath);
    } catch (error) {
      throw new Error(`could not save T3 version state ${this.statePath}: ${(error as Error).message}`, { cause: error });
    }
  }

  private load(): (Seen & Verdict) | undefined {
    let text: string;
    try {
      text = readFileSync(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid T3 version state ${this.statePath}: not valid JSON (${(error as Error).message}), delete it to re-run the canary`);
    }
    const result = stateSchema.safeParse(parsed);
    if (!result.success) throw new Error(`invalid T3 version state ${this.statePath}: ${result.error.message}, delete it to re-run the canary`);
    return result.data;
  }
}

export type DownPhase = "checking" | "fixing" | "none";

export type VersionLoopDeps = {
  watch: Pick<VersionWatch, "check" | "record">;
  intervalMs: number;
  retryMaxMs: number;
  blocked: () => string | undefined;
  canary: () => Promise<CanaryResult>;
  markApprovalsUp(): void;
  markApprovalsDown(reason: string, phase: DownPhase): void;
  onCanaryFailed?(failure: CanaryFailure, versions: Versions): void;
};

export function startVersionLoop(deps: VersionLoopDeps): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastBlocked: string | undefined;
  let trackedLabel: string | undefined;
  let appliedKey: string | undefined;
  let confirmed: { key: string; phase: DownPhase } | undefined;
  let lastVerdict: { label: string; verdict: Verdict } | undefined;
  let backoffMs: number | undefined;
  let retryAt = 0;

  const key = (verdict: Verdict) => JSON.stringify(verdict);
  const phaseOf = (verdict: Verdict): DownPhase => (confirmed?.key === key(verdict) ? confirmed.phase : "checking");

  const apply = (verdict: Verdict, phase: DownPhase) => {
    const applied = `${key(verdict)}|${phase}`;
    if (applied === appliedKey) return;
    appliedKey = applied;
    if (verdict.verdict === "pass") deps.markApprovalsUp();
    else deps.markApprovalsDown(canaryDownReason(verdict), phase);
  };

  const scheduleRetry = (versions: Versions, why: string) => {
    backoffMs = Math.min(backoffMs === undefined ? deps.intervalMs : backoffMs * 2, deps.retryMaxMs);
    retryAt = Date.now() + backoffMs;
    console.error(`canary on T3 ${versions.to} reached no settled verdict (${why}), retrying in ${Math.round(backoffMs / 1000)} s`);
  };

  const evaluate = async (check: VersionCheck, versions: Versions): Promise<string | undefined> => {
    let retry: string | undefined;
    const save = (verdict: Verdict, phase: DownPhase = "checking") => {
      lastVerdict = { label: check.to, verdict };
      try {
        deps.watch.record(check.current, verdict);
      } catch (error) {
        retry ??= "the verdict could not be saved";
        console.error(`${(error as Error).message}, so the canary reruns after a backoff`, error);
      }
      apply(verdict, phase);
    };
    const confirm = (failure: CanaryFailure) => {
      let phase: DownPhase = "none";
      if (deps.onCanaryFailed !== undefined) {
        try {
          deps.onCanaryFailed(failure, versions);
          phase = "fixing";
        } catch (error) {
          console.error("onCanaryFailed threw, approvals stay marked down", error);
        }
      }
      const verdict = verdictOf(failure)!;
      confirmed = { key: key(verdict), phase };
      save(verdict, phase);
    };

    const prior = check.saved ?? (lastVerdict?.label === check.to ? lastVerdict.verdict : undefined);
    const first = await deps.canary();
    if (first.ok) {
      console.log(`canary passed in ${first.ms} ms on T3 ${versions.to}`);
      save({ verdict: "pass" });
      return retry;
    }
    if (first.kind === "transient") return `${first.stage}, transient: ${first.reason}`;
    console.error(`canary failed at ${first.stage} on T3 ${versions.to}: ${first.reason}`);
    if (prior?.verdict === "broken" && prior.stage === first.stage) {
      confirm(first);
      return retry;
    }
    save(verdictOf(first)!);
    if (prior?.verdict === "broken") return retry ?? `broken at ${first.stage} after ${prior.stage}, waiting for two runs in a row at one stage`;

    const second = await deps.canary();
    if (second.ok) {
      console.log(`canary passed in ${second.ms} ms on T3 ${versions.to} after one ${first.stage} failure, treating the failure as a flake`);
      save({ verdict: "pass" });
      return retry;
    }
    if (second.kind === "transient") return `${second.stage}, transient: ${second.reason}`;
    console.error(`canary failed again at ${second.stage} on T3 ${versions.to}: ${second.reason}`);
    if (second.stage === first.stage) {
      confirm(second);
      return retry;
    }
    save(verdictOf(second)!);
    return retry ?? `broken at ${first.stage} then ${second.stage}, waiting for two runs in a row at one stage`;
  };

  const tick = async () => {
    let check: VersionCheck | undefined;
    let checkError: unknown;
    try {
      check = await deps.watch.check();
    } catch (error) {
      checkError = error;
    }
    if (check !== undefined) {
      if (trackedLabel !== check.to) {
        trackedLabel = check.to;
        confirmed = undefined;
        backoffMs = undefined;
        retryAt = 0;
      }
      if (check.saved !== undefined) apply(check.saved, phaseOf(check.saved));
    }
    const reason = deps.blocked();
    if (reason !== undefined) {
      if (reason !== lastBlocked) console.error(`canary skipped until fixed: ${reason}`);
      lastBlocked = reason;
      return;
    }
    lastBlocked = undefined;
    if (check === undefined) {
      console.error(`T3 version check failed: ${(checkError as Error).message}`, checkError);
      return;
    }
    const versions: Versions = check.from === undefined ? { to: check.to } : { from: check.from, to: check.to };
    const needsCanary = check.saved === undefined || (check.saved.verdict === "broken" && key(check.saved) !== confirmed?.key);
    if (!needsCanary || Date.now() < retryAt) return;
    try {
      const retry = await evaluate(check, versions);
      if (retry === undefined) {
        backoffMs = undefined;
        retryAt = 0;
      } else {
        scheduleRetry(versions, retry);
      }
    } catch (error) {
      console.error(`canary on T3 ${versions.to} failed to run: ${(error as Error).message}`, error);
      scheduleRetry(versions, "the canary threw");
    }
  };

  const run = () => {
    inFlight = tick().finally(() => {
      if (stopped) return;
      timer = setTimeout(run, deps.intervalMs);
      timer.unref();
    });
  };
  run();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
