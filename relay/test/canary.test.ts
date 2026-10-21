import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { AdapterBrokenError, ApprovalRejectedError, createApprovalsAdapter, type PendingApproval } from "../src/approvals/index.js";
import { runCanary, type CanaryDeps, type CanaryFailure, type CanaryResult } from "../src/canary.js";
import { T3AuthError, T3UnavailableError } from "../src/t3/mcp.js";
import { VersionWatch, startVersionLoop, verdictOf, type Verdict } from "../src/version-watch.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const approval: PendingApproval = { threadId: "mcp:c", requestId: "req-1", summary: "touch", detail: [], decisions: ["allow_once", "deny"] };

function fakes(overrides: { listPending?: CanaryDeps["approvals"]["listPending"]; waitForRun?: CanaryDeps["t3"]["waitForRun"]; respond?: CanaryDeps["approvals"]["respond"]; launch?: CanaryDeps["t3"]["launch"]; settleThread?: CanaryDeps["t3"]["settleThread"] } = {}) {
  let polls = 0;
  const t3 = {
    launch: vi.fn(overrides.launch ?? (async () => ({ threadId: "mcp:c" }))),
    waitForRun: vi.fn(overrides.waitForRun ?? (async () => ({ status: "completed", timedOut: false }))),
    settleThread: vi.fn(overrides.settleThread ?? (async () => {})),
  };
  const approvals = {
    listPending: vi.fn(overrides.listPending ?? (async () => (++polls < 3 ? [] : [approval]))),
    respond: vi.fn(overrides.respond ?? (async () => {})),
  };
  return { deps: { t3, approvals } satisfies CanaryDeps, t3, approvals };
}

const OPTS = { model: "claude-haiku-5-5", timeoutMs: 2000, pollIntervalMs: 1 };

describe("runCanary", () => {
  it("launches on the configured provider instance when one is set, and leaves it to T3's default otherwise", async () => {
    const pinned = fakes();
    expect(await runCanary(pinned.deps, { ...OPTS, providerInstanceId: "claudeAgent2" })).toMatchObject({ ok: true });
    expect(pinned.t3.launch.mock.calls[0]![0].providerInstanceId).toBe("claudeAgent2");
    const unpinned = fakes();
    expect(await runCanary(unpinned.deps, OPTS)).toMatchObject({ ok: true });
    expect(unpinned.t3.launch.mock.calls[0]![0]).not.toHaveProperty("providerInstanceId");
  });

  it("canary passes end-to-end with fakes", async () => {
    const { deps, t3, approvals } = fakes();
    const result = await runCanary(deps, OPTS);
    expect(result).toEqual({ ok: true, ms: expect.any(Number) });
    expect(t3.launch).toHaveBeenCalledOnce();
    const launched = t3.launch.mock.calls[0]![0];
    expect(launched).toMatchObject({
      scratch: true,
      workspace: "root",
      runtimeMode: "approval-required",
      model: "claude-haiku-5-5",
      options: [{ id: "effort", value: "low" }],
    });
    expect(launched.message).toContain("touch t3-cardputer-canary.txt");
    expect(approvals.listPending).toHaveBeenCalledWith(["mcp:c"]);
    expect(approvals.respond).toHaveBeenCalledWith("mcp:c", "req-1", { kind: "allow_once" });
    expect(t3.waitForRun).toHaveBeenCalledWith("mcp:c", expect.any(Number));
    expect(t3.settleThread).toHaveBeenCalledExactlyOnceWith("mcp:c");
  });

  it('canary reports stage "approval_seen" when no approval appears before timeout', async () => {
    const { deps, approvals, t3 } = fakes({ listPending: async () => [] });
    const result = await runCanary(deps, { ...OPTS, timeoutMs: 40 });
    expect(result).toMatchObject({ ok: false, stage: "approval_seen", kind: "broken" });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("canaryTimeoutMs=40");
    expect(approvals.respond).not.toHaveBeenCalled();
    expect(t3.settleThread).toHaveBeenCalledOnce();
  });

  it("canary always settles the scratch thread, even on failure", async () => {
    const failures: [string, Parameters<typeof fakes>[0], string, string][] = [
      ["approval_seen", { listPending: async () => { throw new AdapterBrokenError("ws shape moved"); } }, "broken", "ws shape moved"],
      ["respond", { respond: async () => { throw new Error("rejected"); } }, "transient", "rejected"],
      ["completed", { waitForRun: async () => ({ status: "failed", timedOut: false }) }, "broken", "failed"],
      ["completed", { waitForRun: async () => ({ status: "running", timedOut: true }) }, "broken", "timed out"],
    ];
    for (const [stage, overrides, kind, text] of failures) {
      const { deps, t3 } = fakes(overrides);
      const result = await runCanary(deps, OPTS);
      expect(result).toMatchObject({ ok: false, stage, kind });
      expect((result as { reason: string }).reason).toContain(text);
      expect(t3.settleThread).toHaveBeenCalledExactlyOnceWith("mcp:c");
    }
  });

  it("a launch failure is transient, reports stage launch and has nothing to settle", async () => {
    const { deps, t3 } = fakes({ launch: async () => { throw new T3UnavailableError("T3 unreachable"); } });
    expect(await runCanary(deps, OPTS)).toEqual({ ok: false, stage: "launch", kind: "transient", reason: "T3 unreachable" });
    expect(t3.settleThread).not.toHaveBeenCalled();
    const auth = fakes({ launch: async () => { throw new T3AuthError("mcp", "no T3 MCP token stored"); } });
    expect(await runCanary(auth.deps, OPTS)).toMatchObject({ ok: false, stage: "launch", kind: "transient" });
  });

  it("AdapterBrokenError at an adapter stage is broken and carries the adapter's reason verbatim", async () => {
    const broken = new AdapterBrokenError("subscribeThread: expected snapshot");
    const listing = fakes({ listPending: async () => { throw broken; } });
    expect(await runCanary(listing.deps, { ...OPTS, timeoutMs: 60_000 })).toEqual({ ok: false, stage: "approval_seen", kind: "broken", reason: "subscribeThread: expected snapshot" });
    expect(listing.approvals.listPending).toHaveBeenCalledOnce();
    const responding = fakes({ respond: async () => { throw broken; } });
    expect(await runCanary(responding.deps, OPTS)).toEqual({ ok: false, stage: "respond", kind: "broken", reason: "subscribeThread: expected snapshot" });
    expect(listing.t3.settleThread).toHaveBeenCalledOnce();
    expect(responding.t3.settleThread).toHaveBeenCalledOnce();
  });

  it("keeps polling through transient listPending errors and still passes", async () => {
    let calls = 0;
    const { deps, approvals } = fakes({
      listPending: async () => {
        if (++calls <= 3) throw new Error("connect ECONNREFUSED");
        return [approval];
      },
    });
    expect(await runCanary(deps, OPTS)).toMatchObject({ ok: true });
    expect(approvals.listPending).toHaveBeenCalledTimes(4);
  });

  it("an adapter that only ever errors transiently until the deadline is transient, not broken", async () => {
    const { deps, t3 } = fakes({ listPending: async () => { throw new ApprovalRejectedError("socket reset"); } });
    const result = await runCanary(deps, { ...OPTS, timeoutMs: 40 });
    expect(result).toMatchObject({ ok: false, stage: "approval_seen", kind: "transient" });
    expect((result as CanaryFailure).reason).toContain("socket reset");
    expect((result as CanaryFailure).reason).toContain("canaryTimeoutMs=40");
    expect(t3.settleThread).toHaveBeenCalledOnce();
  });

  it("an adapter that answered but never showed the approval is broken", async () => {
    let calls = 0;
    const { deps } = fakes({
      listPending: async () => {
        if (++calls === 2) throw new Error("blip");
        return [];
      },
    });
    expect(await runCanary(deps, { ...OPTS, timeoutMs: 40 })).toMatchObject({ ok: false, stage: "approval_seen", kind: "broken" });
  });

  it("a rejected or unreachable respond is transient", async () => {
    for (const error of [new ApprovalRejectedError("request is resolved"), new T3AuthError("internal", "token rejected"), new Error("rpc timeout")]) {
      const { deps } = fakes({ respond: async () => { throw error; } });
      expect(await runCanary(deps, OPTS)).toMatchObject({ ok: false, stage: "respond", kind: "transient" });
    }
  });

  it("an MCP error while waiting for the run is transient, a run that did not complete after the approval is broken", async () => {
    const mcp = fakes({ waitForRun: async () => { throw new T3UnavailableError("T3 answered HTTP 404, reconnecting"); } });
    expect(await runCanary(mcp.deps, OPTS)).toMatchObject({ ok: false, stage: "completed", kind: "transient" });
    for (const status of ["failed", "interrupted", "cancelled", "running"]) {
      const { deps } = fakes({ waitForRun: async () => ({ status, timedOut: false }) });
      expect(await runCanary(deps, OPTS)).toMatchObject({ ok: false, stage: "completed", kind: "broken" });
    }
  });

  it("an approvals socket that never answers makes the canary transient, never broken", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => wss.once("listening", resolve));
    const approvals = createApprovalsAdapter(`http://127.0.0.1:${(wss.address() as AddressInfo).port}`, () => "internal-token", { approvalsRpcTimeoutMs: 20 });
    try {
      const { t3 } = fakes();
      const result = await runCanary({ t3, approvals }, { ...OPTS, timeoutMs: 150 });
      expect(result).toMatchObject({ ok: false, stage: "approval_seen", kind: "transient" });
      expect((result as CanaryFailure).reason).toContain("approvalsRpcTimeoutMs=20");
      const responding = fakes({ respond: (threadId, requestId, decision) => approvals.respond(threadId, requestId, decision) });
      expect(await runCanary(responding.deps, OPTS)).toMatchObject({ ok: false, stage: "respond", kind: "transient" });
    } finally {
      await approvals.close();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    }
  });

  it("a settle failure does not change the result and is logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fakes({ settleThread: async () => { throw new Error("organize denied"); } });
    expect(await runCanary(deps, OPTS)).toMatchObject({ ok: true });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("mcp:c"), expect.anything());
  });

  it("the wait for the run gets only the time left of the budget", async () => {
    const { deps, t3 } = fakes();
    await runCanary(deps, { ...OPTS, timeoutMs: 5000 });
    expect(t3.waitForRun.mock.calls[0]![1]).toBeLessThanOrEqual(5000);
    expect(t3.waitForRun.mock.calls[0]![1]).toBeGreaterThan(0);
  });
});

function tmpState(): string {
  return join(mkdtempSync(join(tmpdir(), "relay-version-")), "state", "t3-version.json");
}
const env = (serverVersion: string, orchestrationProtocolVersion = 2) => ({ serverVersion, orchestrationProtocolVersion });
const PASS: Verdict = { verdict: "pass" };
const BROKEN: Verdict = { verdict: "broken", stage: "respond", reason: "decision not accepted" };

describe("VersionWatch", () => {
  it("first check reports changed with no from and no saved verdict, and writes nothing", async () => {
    const path = tmpState();
    const check = await new VersionWatch(async () => env("0.1.0"), path).check();
    expect(check).toMatchObject({ changed: true, to: "0.1.0+orch2", current: env("0.1.0") });
    expect(check.from).toBeUndefined();
    expect(check.saved).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("VersionWatch reports changed on serverVersion bump and persists the verdict only when recorded", async () => {
    const path = tmpState();
    let current = env("0.1.0");
    const watch = new VersionWatch(async () => current, path);
    watch.record((await watch.check()).current, PASS);
    expect(await watch.check()).toMatchObject({ changed: false, to: "0.1.0+orch2", saved: PASS });
    current = env("0.1.1");
    const bumped = await watch.check();
    expect(bumped).toMatchObject({ changed: true, from: "0.1.0+orch2", to: "0.1.1+orch2" });
    expect(bumped.saved).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...env("0.1.0"), verdict: "pass" });
    watch.record(bumped.current, BROKEN);
    expect(await new VersionWatch(async () => current, path).check()).toMatchObject({ changed: false, saved: BROKEN });
    expect(readdirSync(join(path, ".."))).toEqual(["t3-version.json"]);
  });

  it("an orchestration protocol bump alone is a change", async () => {
    const path = tmpState();
    const watch = new VersionWatch(async () => env("0.1.0", 2), path);
    watch.record((await watch.check()).current, PASS);
    expect(await new VersionWatch(async () => env("0.1.0", 3), path).check()).toMatchObject({ changed: true, from: "0.1.0+orch2", to: "0.1.0+orch3" });
  });

  it("a failed environment read throws and leaves the saved verdict alone", async () => {
    const path = tmpState();
    const watch = new VersionWatch(async () => env("0.1.0"), path);
    watch.record((await watch.check()).current, BROKEN);
    await expect(new VersionWatch(async () => { throw new Error("T3 unreachable"); }, path).check()).rejects.toThrow("T3 unreachable");
    expect(await watch.check()).toMatchObject({ saved: BROKEN });
  });

  it("names the file when the state is corrupt", async () => {
    const path = tmpState();
    const watch = new VersionWatch(async () => env("0.1.0"), path);
    watch.record((await watch.check()).current, PASS);
    writeFileSync(path, "{nope");
    await expect(watch.check()).rejects.toThrow(path);
  });

  it("record names the state file when it cannot write it", () => {
    const blocker = join(mkdtempSync(join(tmpdir(), "relay-version-")), "file");
    writeFileSync(blocker, "x");
    const path = join(blocker, "state", "t3-version.json");
    expect(() => new VersionWatch(async () => env("0.1.0"), path).record(env("0.1.0"), PASS)).toThrow(path);
  });

  it("verdictOf records a pass or a broken failure and nothing for a transient one", () => {
    expect(verdictOf({ ok: true, ms: 5 })).toEqual(PASS);
    expect(verdictOf({ ok: false, stage: "respond", kind: "broken", reason: "decision not accepted" })).toEqual(BROKEN);
    expect(verdictOf({ ok: false, stage: "launch", kind: "transient", reason: "x" })).toBeUndefined();
  });
});

const failure = (stage: CanaryFailure["stage"], kind: CanaryFailure["kind"] = "broken", reason = "adapter said no"): CanaryResult => ({ ok: false, stage, kind, reason });

function loopRig(options: { path?: string; results: (() => Promise<CanaryResult>)[]; blocked?: () => string | undefined; retryMaxMs?: number; getEnv?: () => Promise<{ serverVersion: string; orchestrationProtocolVersion: number }> }) {
  const path = options.path ?? tmpState();
  const watch = new VersionWatch(options.getEnv ?? (async () => env("0.1.0")), path);
  const queue = [...options.results];
  const canary = vi.fn(() => (queue.shift() ?? (() => Promise.reject(new Error("unexpected extra canary run"))))());
  const up = vi.fn();
  const down = vi.fn();
  const failed = vi.fn();
  const loop = startVersionLoop({
    watch,
    intervalMs: 1000,
    retryMaxMs: options.retryMaxMs ?? 4000,
    blocked: options.blocked ?? (() => undefined),
    canary,
    markApprovalsUp: up,
    markApprovalsDown: down,
    onCanaryFailed: failed,
  });
  return { path, watch, canary, up, down, failed, loop };
}
const ok = (): Promise<CanaryResult> => Promise.resolve({ ok: true, ms: 5000 });
const fails = (...args: Parameters<typeof failure>) => () => Promise.resolve(failure(...args));

describe("startVersionLoop", () => {
  it("recheck after a pass runs a confirming canary at once, and a pass marks approvals up again", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rig = loopRig({ results: [ok, ok] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(1);
    expect(rig.up).toHaveBeenCalledTimes(1);
    expect(rig.loop.recheck()).toBe("checking");
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    expect(rig.up).toHaveBeenCalledTimes(2);
    expect(rig.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    await rig.loop.stop();
  });

  it("recheck that fails twice at one stage confirms and starts a repair, then says fixing without rerunning", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = loopRig({ results: [ok, fails("approval_seen"), fails("approval_seen")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.loop.recheck()).toBe("checking");
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(3);
    expect(rig.down).toHaveBeenNthCalledWith(1, "canary approval_seen: adapter said no", "checking");
    expect(rig.down).toHaveBeenLastCalledWith("canary approval_seen: adapter said no", "fixing");
    expect(rig.failed).toHaveBeenCalledOnce();
    expect(rig.loop.recheck()).toBe("fixing");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.canary).toHaveBeenCalledTimes(3);
    await rig.loop.stop();
  });

  it("recheck while the canary is blocked runs nothing and says no check is coming", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = loopRig({ results: [], blocked: () => "no T3 MCP token" });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.loop.recheck()).toBe("none");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.canary).not.toHaveBeenCalled();
    await rig.loop.stop();
  });

  it("a recheck asked while a tick is running runs right after it, not an interval later", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release!: () => void;
    const slow = () => new Promise<CanaryResult>((resolve) => (release = () => resolve({ ok: true, ms: 1 })));
    const rig = loopRig({ results: [slow, ok] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(1);
    expect(rig.loop.recheck()).toBe("checking");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    await rig.loop.stop();
  });
  it("runs the canary at startup for an unseen version, records the pass, marks approvals up and does not rerun", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rig = loopRig({ results: [ok] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.canary).toHaveBeenCalledOnce();
    expect(rig.up).toHaveBeenCalledOnce();
    expect(rig.down).not.toHaveBeenCalled();
    expect(await rig.watch.check()).toMatchObject({ changed: false, saved: PASS });
    await rig.loop.stop();
  });

  it("a launch or transient failure leaves the version unconsumed and retries with backoff up to retryMaxMs", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const transient = fails("launch", "transient", "T3 unreachable");
    const rig = loopRig({ results: [transient, transient, transient, transient, transient, ok], retryMaxMs: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(1);
    expect(await rig.watch.check()).toMatchObject({ changed: true });
    expect(existsSync(rig.path)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rig.canary).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rig.canary).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rig.canary).toHaveBeenCalledTimes(6);
    expect(rig.up).toHaveBeenCalledOnce();
    expect(rig.down).not.toHaveBeenCalled();
    expect(rig.failed).not.toHaveBeenCalled();
    await rig.loop.stop();
  });

  it("a first broken failure records broken, marks approvals down, reruns at once, and fires the hook only when the rerun fails at the same stage", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = loopRig({ results: [fails("respond"), fails("respond")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    expect(rig.down).toHaveBeenNthCalledWith(1, "canary respond: adapter said no", "checking");
    expect(rig.down).toHaveBeenLastCalledWith("canary respond: adapter said no", "fixing");
    expect(rig.failed).toHaveBeenCalledOnce();
    expect(rig.failed).toHaveBeenCalledWith(failure("respond"), { to: "0.1.0+orch2" });
    expect(await rig.watch.check()).toMatchObject({ saved: { verdict: "broken", stage: "respond", reason: "adapter said no" } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    await rig.loop.stop();
  });

  it("a broken failure that passes on the rerun is a flake: verdict pass, approvals up, no hook", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rig = loopRig({ results: [fails("approval_seen"), ok] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.failed).not.toHaveBeenCalled();
    expect(rig.up).toHaveBeenLastCalledWith();
    expect(await rig.watch.check()).toMatchObject({ saved: PASS });
    await rig.loop.stop();
  });

  it("broken at two different stages is unconfirmed: no hook, device text says checking again, reruns with backoff until two runs agree", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = loopRig({ results: [fails("approval_seen"), fails("completed"), fails("completed")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    expect(rig.failed).not.toHaveBeenCalled();
    expect(rig.down).toHaveBeenLastCalledWith("canary completed: adapter said no", "checking");
    expect(rig.down.mock.calls.every(([, phase]) => phase === "checking")).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(rig.canary).toHaveBeenCalledTimes(3);
    expect(rig.failed).toHaveBeenCalledExactlyOnceWith(failure("completed"), { to: "0.1.0+orch2" });
    expect(rig.down).toHaveBeenLastCalledWith("canary completed: adapter said no", "fixing");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.canary).toHaveBeenCalledTimes(3);
    await rig.loop.stop();
  });

  it("keeps rerunning with doubling backoff while broken stages keep changing, and a pass clears it", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rig = loopRig({ results: [fails("approval_seen"), fails("respond"), fails("completed"), fails("respond"), ok], retryMaxMs: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rig.canary).toHaveBeenCalledTimes(5);
    expect(rig.failed).not.toHaveBeenCalled();
    expect(rig.up).toHaveBeenCalledOnce();
    await rig.loop.stop();
  });

  it("with no hook attached a confirmed failure never claims a fix is in progress", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = vi.fn();
    const queue = [fails("respond"), fails("respond")];
    const loop = startVersionLoop({
      watch: new VersionWatch(async () => env("0.1.0"), tmpState()),
      intervalMs: 1000,
      retryMaxMs: 4000,
      blocked: () => undefined,
      canary: () => queue.shift()!(),
      markApprovalsUp: vi.fn(),
      markApprovalsDown: down,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(down).toHaveBeenLastCalledWith("canary respond: adapter said no", "none");
    await loop.stop();
  });

  it("a throwing hook is logged and the text does not claim a fix", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = vi.fn();
    const queue = [fails("respond"), fails("respond")];
    const loop = startVersionLoop({
      watch: new VersionWatch(async () => env("0.1.0"), tmpState()),
      intervalMs: 1000,
      retryMaxMs: 4000,
      blocked: () => undefined,
      canary: () => queue.shift()!(),
      markApprovalsUp: vi.fn(),
      markApprovalsDown: down,
      onCanaryFailed: () => {
        throw new Error("repair boom");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(down).toHaveBeenLastCalledWith("canary respond: adapter said no", "none");
    await loop.stop();
  });

  it("a state file that cannot be written is logged naming its path, still applies to devices, and backs off instead of rerunning every tick", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const statePath = "/nonexistent-state/t3-version.json";
    const record = vi.fn(() => {
      throw new Error(`could not save T3 version state ${statePath}: EACCES`);
    });
    const up = vi.fn();
    const results = [ok, ok, ok, ok];
    const canary = vi.fn(() => results.shift()!());
    const loop = startVersionLoop({
      watch: { check: async () => ({ current: env("0.1.0"), to: "0.1.0+orch2", changed: true }), record },
      intervalMs: 1000,
      retryMaxMs: 2000,
      blocked: () => undefined,
      canary,
      markApprovalsUp: up,
      markApprovalsDown: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(up).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(statePath), expect.anything());
    expect(canary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(canary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(canary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(canary).toHaveBeenCalledTimes(3);
    await loop.stop();
  });

  it("a broken verdict that cannot be saved still reaches devices and is still confirmed from memory", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = vi.fn();
    const failed = vi.fn();
    const queue = [fails("respond"), fails("respond")];
    const loop = startVersionLoop({
      watch: {
        check: async () => ({ current: env("0.1.0"), to: "0.1.0+orch2", changed: true }),
        record: () => {
          throw new Error("could not save T3 version state /x: ENOSPC");
        },
      },
      intervalMs: 1000,
      retryMaxMs: 2000,
      blocked: () => undefined,
      canary: () => queue.shift()!(),
      markApprovalsUp: vi.fn(),
      markApprovalsDown: down,
      onCanaryFailed: failed,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(down).toHaveBeenNthCalledWith(1, "canary respond: adapter said no", "checking");
    expect(failed).toHaveBeenCalledOnce();
    await loop.stop();
  });

  it("a saved broken verdict reaches devices even while the canary is blocked by a missing token, and nothing is run", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const path = tmpState();
    const seed = new VersionWatch(async () => env("0.1.0"), path);
    seed.record((await seed.check()).current, BROKEN);
    const rig = loopRig({ path, results: [], blocked: () => "no T3 internal token" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.down).toHaveBeenCalledExactlyOnceWith("canary respond: decision not accepted", "checking");
    expect(rig.canary).not.toHaveBeenCalled();
    await rig.loop.stop();
  });

  it("a transient rerun keeps the broken verdict and the down mark, fires no hook, and retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = loopRig({ results: [fails("respond"), fails("launch", "transient", "T3 unreachable"), fails("respond")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.failed).not.toHaveBeenCalled();
    expect(await rig.watch.check()).toMatchObject({ saved: { verdict: "broken", stage: "respond" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledTimes(3);
    expect(rig.failed).toHaveBeenCalledOnce();
    await rig.loop.stop();
  });

  it("restart with a saved broken verdict marks approvals down before the rerun finishes, reruns once, and confirms a same-stage failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const path = tmpState();
    const seed = new VersionWatch(async () => env("0.1.0"), path);
    seed.record((await seed.check()).current, BROKEN);
    let finish!: (result: CanaryResult) => void;
    const rig = loopRig({ path, results: [() => new Promise<CanaryResult>((resolve) => (finish = resolve))] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.down).toHaveBeenCalledExactlyOnceWith("canary respond: decision not accepted", "checking");
    expect(rig.canary).toHaveBeenCalledOnce();
    expect(rig.failed).not.toHaveBeenCalled();
    finish(failure("respond", "broken", "still not accepted"));
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.failed).toHaveBeenCalledExactlyOnceWith(failure("respond", "broken", "still not accepted"), { to: "0.1.0+orch2" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.canary).toHaveBeenCalledOnce();
    await rig.loop.stop();
  });

  it("restart with a saved pass for the current version runs no canary", async () => {
    vi.useFakeTimers();
    const path = tmpState();
    const seed = new VersionWatch(async () => env("0.1.0"), path);
    seed.record((await seed.check()).current, PASS);
    const rig = loopRig({ path, results: [] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.canary).not.toHaveBeenCalled();
    expect(rig.down).not.toHaveBeenCalled();
    await rig.loop.stop();
  });

  it("a pass written by another process (the CLI canary) clears the mark on the next tick without a rerun", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = loopRig({ results: [fails("respond"), fails("respond")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.down).toHaveBeenCalled();
    expect(rig.up).not.toHaveBeenCalled();
    const outside = new VersionWatch(async () => env("0.1.0"), rig.path);
    outside.record((await outside.check()).current, PASS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.up).toHaveBeenCalledOnce();
    expect(rig.canary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.up).toHaveBeenCalledOnce();
    await rig.loop.stop();
  });

  it("a broken verdict written by another process sets the mark and is rerun once to confirm", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rig = loopRig({ results: [ok, fails("respond", "broken", "again")] });
    await vi.advanceTimersByTimeAsync(0);
    const outside = new VersionWatch(async () => env("0.1.0"), rig.path);
    outside.record((await outside.check()).current, BROKEN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.down).toHaveBeenNthCalledWith(1, "canary respond: decision not accepted", "checking");
    expect(rig.canary).toHaveBeenCalledTimes(2);
    expect(rig.failed).toHaveBeenCalledOnce();
    await rig.loop.stop();
  });

  it("a version bump after a pass runs the canary again", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let current = env("0.1.0");
    const rig = loopRig({ results: [ok, ok], getEnv: async () => current });
    await vi.advanceTimersByTimeAsync(0);
    current = env("0.2.0");
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    expect(await rig.watch.check()).toMatchObject({ changed: false, to: "0.2.0+orch2" });
    await rig.loop.stop();
  });

  it("while blocked it does not check, so nothing is consumed, and logs the reason once", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let reason: string | undefined = "no T3 internal token";
    const rig = loopRig({ results: [ok], blocked: () => reason });
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.canary).not.toHaveBeenCalled();
    expect(error.mock.calls.filter(([line]) => String(line).includes("no T3 internal token"))).toHaveLength(1);
    reason = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.canary).toHaveBeenCalledOnce();
    await rig.loop.stop();
  });

  it("a failing version check or canary is logged and the loop keeps going", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let reads = 0;
    const rig = loopRig({
      results: [() => Promise.reject(new Error("canary blew up")), ok],
      getEnv: async () => {
        if (++reads === 1) throw new Error("T3 unreachable");
        return env("0.1.0");
      },
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.canary).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("T3 unreachable"), expect.anything());
    expect(error).toHaveBeenCalledWith(expect.stringContaining("canary blew up"), expect.anything());
    await rig.loop.stop();
  });

  it("a throwing hook still leaves approvals marked down", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = [fails("respond"), fails("respond")];
    const down = vi.fn();
    const loop = startVersionLoop({
      watch: new VersionWatch(async () => env("0.1.0"), tmpState()),
      intervalMs: 1000,
      retryMaxMs: 4000,
      blocked: () => undefined,
      canary: () => queue.shift()!(),
      markApprovalsUp: vi.fn(),
      markApprovalsDown: down,
      onCanaryFailed: () => {
        throw new Error("repair boom");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(down).toHaveBeenCalled();
    await loop.stop();
  });

  it("stop waits for an in-flight canary", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release!: () => void;
    const rig = loopRig({ results: [() => new Promise<CanaryResult>((resolve) => (release = () => resolve({ ok: true, ms: 1 })))] });
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = rig.loop.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
