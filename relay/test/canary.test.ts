import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterBrokenError, type PendingApproval } from "../src/approvals/index.js";
import { runCanary, reactToCanary, type CanaryDeps, type CanaryResult } from "../src/canary.js";
import { VersionWatch, startVersionLoop } from "../src/version-watch.js";

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
    expect(result).toMatchObject({ ok: false, stage: "approval_seen" });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("canaryTimeoutMs=40");
    expect(approvals.respond).not.toHaveBeenCalled();
    expect(t3.settleThread).toHaveBeenCalledOnce();
  });

  it("canary always settles the scratch thread, even on failure", async () => {
    const failures: [string, Parameters<typeof fakes>[0], string][] = [
      ["approval_seen", { listPending: async () => { throw new Error("ws closed"); } }, "ws closed"],
      ["respond", { respond: async () => { throw new Error("rejected"); } }, "rejected"],
      ["completed", { waitForRun: async () => ({ status: "failed", timedOut: false }) }, "failed"],
      ["completed", { waitForRun: async () => ({ status: "running", timedOut: true }) }, "timed out"],
    ];
    for (const [stage, overrides, text] of failures) {
      const { deps, t3 } = fakes(overrides);
      const result = await runCanary(deps, OPTS);
      expect(result).toMatchObject({ ok: false, stage });
      expect((result as { reason: string }).reason).toContain(text);
      expect(t3.settleThread).toHaveBeenCalledExactlyOnceWith("mcp:c");
    }
  });

  it("a launch failure reports stage launch and has nothing to settle", async () => {
    const { deps, t3 } = fakes({ launch: async () => { throw new Error("capability_denied"); } });
    expect(await runCanary(deps, OPTS)).toEqual({ ok: false, stage: "launch", reason: "capability_denied" });
    expect(t3.settleThread).not.toHaveBeenCalled();
  });

  it("AdapterBrokenError at any adapter stage reports the adapter's reason verbatim", async () => {
    const broken = new AdapterBrokenError("subscribeThread: expected snapshot");
    const listing = fakes({ listPending: async () => { throw broken; } });
    expect(await runCanary(listing.deps, OPTS)).toEqual({ ok: false, stage: "approval_seen", reason: "subscribeThread: expected snapshot" });
    const responding = fakes({ respond: async () => { throw broken; } });
    expect(await runCanary(responding.deps, OPTS)).toEqual({ ok: false, stage: "respond", reason: "subscribeThread: expected snapshot" });
    expect(listing.t3.settleThread).toHaveBeenCalledOnce();
    expect(responding.t3.settleThread).toHaveBeenCalledOnce();
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

describe("VersionWatch", () => {
  it("first check reports changed with no from and persists", async () => {
    const path = tmpState();
    expect(await new VersionWatch(async () => env("0.1.0"), path).check()).toEqual({ changed: true, to: "0.1.0+orch2" });
    expect(await new VersionWatch(async () => env("0.1.0"), path).check()).toEqual({ changed: false, to: "0.1.0+orch2" });
  });

  it("VersionWatch reports changed on serverVersion bump and persists", async () => {
    const path = tmpState();
    let current = env("0.1.0");
    const watch = new VersionWatch(async () => current, path);
    await watch.check();
    current = env("0.1.1");
    expect(await watch.check()).toEqual({ changed: true, from: "0.1.0+orch2", to: "0.1.1+orch2" });
    expect(await new VersionWatch(async () => current, path).check()).toEqual({ changed: false, to: "0.1.1+orch2" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(env("0.1.1"));
    expect(readdirSync(join(path, ".."))).toEqual(["t3-version.json"]);
  });

  it("an orchestration protocol bump alone is a change", async () => {
    const path = tmpState();
    await new VersionWatch(async () => env("0.1.0", 2), path).check();
    expect(await new VersionWatch(async () => env("0.1.0", 3), path).check()).toEqual({ changed: true, from: "0.1.0+orch2", to: "0.1.0+orch3" });
  });

  it("does not persist when the environment read fails", async () => {
    const path = tmpState();
    await new VersionWatch(async () => env("0.1.0"), path).check();
    await expect(new VersionWatch(async () => { throw new Error("T3 unreachable"); }, path).check()).rejects.toThrow("T3 unreachable");
    expect(await new VersionWatch(async () => env("0.1.0"), path).check()).toMatchObject({ changed: false });
  });

  it("names the file when the state is corrupt", async () => {
    const path = tmpState();
    await new VersionWatch(async () => env("0.1.0"), path).check();
    writeFileSync(path, "{nope");
    await expect(new VersionWatch(async () => env("0.1.0"), path).check()).rejects.toThrow(path);
  });
});

describe("startVersionLoop", () => {
  it("checks at startup, runs onChange on a change, and re-checks on the interval", async () => {
    vi.useFakeTimers();
    const changes: { from?: string; to: string }[] = [];
    const results = [{ changed: true, to: "a" }, { changed: false, to: "a" }, { changed: true, from: "a", to: "b" }];
    const check = vi.fn(async () => results.shift() ?? { changed: false, to: "b" });
    const loop = startVersionLoop({ watch: { check }, intervalMs: 1000, blocked: () => undefined, onChange: async (change) => void changes.push(change) });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([{ changed: true, to: "a" }].map(({ changed: _c, ...rest }) => rest));
    await vi.advanceTimersByTimeAsync(2000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(changes.at(-1)).toEqual({ from: "a", to: "b" });
    await loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("while blocked it does not check, so the change stays pending, and logs the reason once", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let reason: string | undefined = "no T3 internal token";
    const check = vi.fn(async () => ({ changed: true, to: "a" }));
    const onChange = vi.fn(async () => {});
    const loop = startVersionLoop({ watch: { check }, intervalMs: 1000, blocked: () => reason, onChange });
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).not.toHaveBeenCalled();
    expect(error.mock.calls.filter(([line]) => String(line).includes("no T3 internal token"))).toHaveLength(1);
    reason = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledOnce();
    await loop.stop();
  });

  it("a failing check or onChange is logged and the loop keeps going", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const check = vi.fn<() => Promise<{ changed: boolean; to: string }>>()
      .mockRejectedValueOnce(new Error("T3 unreachable"))
      .mockResolvedValue({ changed: true, to: "a" });
    const onChange = vi.fn().mockRejectedValueOnce(new Error("canary blew up")).mockResolvedValue(undefined);
    const loop = startVersionLoop({ watch: { check }, intervalMs: 1000, blocked: () => undefined, onChange });
    await vi.advanceTimersByTimeAsync(2500);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("T3 unreachable"), expect.anything());
    expect(error).toHaveBeenCalledWith(expect.stringContaining("canary blew up"), expect.anything());
    await loop.stop();
  });

  it("stop waits for an in-flight canary", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const onChange = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const loop = startVersionLoop({ watch: { check: async () => ({ changed: true, to: "a" }) }, intervalMs: 1000, blocked: () => undefined, onChange });
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = loop.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("reactToCanary", () => {
  const versions = { from: "0.1.0+orch2", to: "0.1.1+orch2" };
  const failure = (stage: Extract<CanaryResult, { ok: false }>["stage"]): CanaryResult => ({ ok: false, stage, reason: "adapter said no" });

  it("a pass marks approvals up and calls no failure hook", () => {
    const hooks = { markApprovalsUp: vi.fn(), markApprovalsDown: vi.fn(), onCanaryFailed: vi.fn() };
    vi.spyOn(console, "log").mockImplementation(() => {});
    reactToCanary({ ok: true, ms: 1234 }, versions, hooks);
    expect(hooks.markApprovalsUp).toHaveBeenCalledOnce();
    expect(hooks.markApprovalsDown).not.toHaveBeenCalled();
    expect(hooks.onCanaryFailed).not.toHaveBeenCalled();
  });

  it("an adapter-stage failure marks approvals down with stage and reason, then calls the hook with the versions", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const stage of ["approval_seen", "respond", "completed"] as const) {
      const hooks = { markApprovalsUp: vi.fn(), markApprovalsDown: vi.fn(), onCanaryFailed: vi.fn() };
      reactToCanary(failure(stage), versions, hooks);
      expect(hooks.markApprovalsDown).toHaveBeenCalledExactlyOnceWith(`canary ${stage}: adapter said no`);
      expect(hooks.onCanaryFailed).toHaveBeenCalledExactlyOnceWith(failure(stage), versions);
    }
  });

  it("a launch failure never touched the adapter, so it neither marks approvals down nor calls the hook", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks = { markApprovalsUp: vi.fn(), markApprovalsDown: vi.fn(), onCanaryFailed: vi.fn() };
    reactToCanary(failure("launch"), versions, hooks);
    expect(hooks.markApprovalsDown).not.toHaveBeenCalled();
    expect(hooks.onCanaryFailed).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("launch"));
  });

  it("a throwing hook still leaves approvals marked down", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks = { markApprovalsUp: vi.fn(), markApprovalsDown: vi.fn(), onCanaryFailed: vi.fn(() => { throw new Error("repair boom"); }) };
    expect(() => reactToCanary(failure("respond"), versions, hooks)).not.toThrow();
    expect(hooks.markApprovalsDown).toHaveBeenCalledOnce();
  });
});
