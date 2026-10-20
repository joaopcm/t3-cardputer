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
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ...seen, ...verdict }, null, 2));
    renameSync(tmp, this.statePath);
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

export type VersionLoopDeps = {
  watch: Pick<VersionWatch, "check" | "record">;
  intervalMs: number;
  retryMaxMs: number;
  blocked: () => string | undefined;
  canary: () => Promise<CanaryResult>;
  markApprovalsUp(): void;
  markApprovalsDown(reason: string): void;
  onCanaryFailed?(failure: CanaryFailure, versions: Versions): void;
};

export function startVersionLoop(deps: VersionLoopDeps): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastBlocked: string | undefined;
  let trackedLabel: string | undefined;
  let appliedKey: string | undefined;
  let confirmedKey: string | undefined;
  let backoffMs: number | undefined;
  let retryAt = 0;

  const key = (verdict: Verdict) => JSON.stringify(verdict);

  const apply = (verdict: Verdict) => {
    if (key(verdict) === appliedKey) return;
    appliedKey = key(verdict);
    if (verdict.verdict === "pass") deps.markApprovalsUp();
    else deps.markApprovalsDown(`canary ${verdict.stage}: ${verdict.reason}`);
  };

  const retryLater = (versions: Versions, failure: CanaryFailure) => {
    backoffMs = Math.min(backoffMs === undefined ? deps.intervalMs : backoffMs * 2, deps.retryMaxMs);
    retryAt = Date.now() + backoffMs;
    console.error(`canary on T3 ${versions.to} reached no verdict (${failure.stage}, transient): ${failure.reason}, retrying in ${Math.round(backoffMs / 1000)} s`);
  };

  const recordVerdict = (check: VersionCheck, verdict: Verdict) => {
    deps.watch.record(check.current, verdict);
    backoffMs = undefined;
    retryAt = 0;
    apply(verdict);
  };

  const evaluate = async (check: VersionCheck, versions: Versions) => {
    const prior = check.saved;
    let result = await deps.canary();
    if (result.ok) {
      console.log(`canary passed in ${result.ms} ms on T3 ${versions.to}`);
      recordVerdict(check, { verdict: "pass" });
      return;
    }
    if (result.kind === "transient") return retryLater(versions, result);
    console.error(`canary failed at ${result.stage} on T3 ${versions.to}: ${result.reason}`);
    let confirmed = prior?.verdict === "broken" && prior.stage === result.stage;
    if (!confirmed) {
      const first = result;
      recordVerdict(check, verdictOf(first)!);
      const again = await deps.canary();
      if (again.ok) {
        console.log(`canary passed in ${again.ms} ms on T3 ${versions.to} after one ${first.stage} failure, treating the failure as a flake`);
        recordVerdict(check, { verdict: "pass" });
        return;
      }
      if (again.kind === "transient") return retryLater(versions, again);
      console.error(`canary failed again at ${again.stage} on T3 ${versions.to}: ${again.reason}`);
      confirmed = again.stage === first.stage;
      result = again;
    }
    const verdict = verdictOf(result)!;
    recordVerdict(check, verdict);
    confirmedKey = key(verdict);
    if (!confirmed) return;
    try {
      deps.onCanaryFailed?.(result, versions);
    } catch (error) {
      console.error("onCanaryFailed threw, approvals stay marked down", error);
    }
  };

  const tick = async () => {
    const reason = deps.blocked();
    if (reason !== undefined) {
      if (reason !== lastBlocked) console.error(`canary skipped until fixed: ${reason}`);
      lastBlocked = reason;
      return;
    }
    lastBlocked = undefined;
    let check: VersionCheck;
    try {
      check = await deps.watch.check();
    } catch (error) {
      console.error(`T3 version check failed: ${(error as Error).message}`, error);
      return;
    }
    const versions: Versions = check.from === undefined ? { to: check.to } : { from: check.from, to: check.to };
    if (trackedLabel !== check.to) {
      trackedLabel = check.to;
      confirmedKey = undefined;
      backoffMs = undefined;
      retryAt = 0;
    }
    if (check.saved !== undefined) apply(check.saved);
    const needsCanary = check.saved === undefined || (check.saved.verdict === "broken" && key(check.saved) !== confirmedKey);
    if (!needsCanary || Date.now() < retryAt) return;
    try {
      await evaluate(check, versions);
    } catch (error) {
      console.error(`canary on T3 ${versions.to} failed to run: ${(error as Error).message}`, error);
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
