import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { PendingApproval } from "../src/approvals/index.js";
import type { Limits } from "../src/config.js";
import type { RelayMessage } from "../src/protocol/messages.js";
import { T3UnavailableError } from "../src/t3/mcp.js";
import { Watcher, type WatchSnapshot } from "../src/watcher.js";
import { Device, FakeApprovals, FakeT3, HOURS_AGO, POLL_MS, cleanupAfterEach, deferred, onCleanup, startRelay, summary } from "./helpers/relay-fixture.js";

cleanupAfterEach();

async function setup(limits: Partial<Limits> = {}) {
  const relay = await startRelay(limits);
  const { code } = relay.auth.createPairingCode();
  const { token, deviceId } = relay.auth.redeem(code, "cardputer", "198.51.100.1");
  const connect = async (options: WebSocket.ClientOptions = {}) => {
    const device = await Device.open(relay.server.port, options);
    onCleanup(() => device.close());
    return device;
  };
  const connected = async (overrides: Record<string, unknown> = {}) => {
    const device = await connect();
    device.hello(token, overrides);
    await device.next("welcome");
    await device.next("home");
    return device;
  };
  return { ...relay, token, deviceId, connect, connected };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("device session", () => {
  it("hello with valid token gets welcome then home", async () => {
    const { t3, connect, token } = await setup();
    t3.threads = [summary("t1")];
    const device = await connect();
    device.hello(token);
    await device.next("home");
    expect(device.received.map((m) => m.type).slice(0, 2)).toEqual(["welcome", "home"]);
    const home = device.received[1] as Extract<RelayMessage, { type: "home" }>;
    expect(home.rows.map((r) => r.threadId)).toEqual(["t1"]);
    expect(home.t3).toBe("ok");
    expect(home.approvals).toEqual({ available: true });
  });

  it("no hello within timeout closes 4401", async () => {
    const { connect } = await setup({ helloTimeoutMs: 50 });
    const device = await connect();
    const error = await device.next("error");
    expect(error.code).toBe("auth");
    expect(error.message).toContain("helloTimeoutMs=50");
    expect((await device.closed).code).toBe(4401);
  });

  it("bad token closes 4401 and counts toward lockout", async () => {
    const { connect, auth } = await setup();
    const device = await connect();
    device.hello("not-a-token");
    expect((await device.next("error")).code).toBe("auth");
    expect((await device.closed).code).toBe(4401);
    expect(auth.lockout.trackedSources).toBe(1);
    expect(device.received.map((m) => m.type)).toEqual(["error"]);
  });

  it("a first frame that is not a hello closes 4401", async () => {
    const { connect } = await setup();
    const device = await connect();
    device.send({ type: "list_projects", id: "a1" });
    expect((await device.next("error")).code).toBe("auth");
    expect((await device.closed).code).toBe(4401);
  });

  it("reply id repeated after reconnect calls t3.send once", async () => {
    const { t3, connected, deviceId } = await setup();
    t3.threads = [summary("t1")];
    const gate = deferred();
    t3.sendGate = gate.promise;
    const reply = { type: "reply", id: "r1", threadId: "t1", text: "go ahead", mode: "queue" };

    const first = await connected();
    first.send(reply);
    await pause(POLL_MS);
    first.close();

    const second = await connected();
    second.send(reply);
    gate.resolve();
    expect(await second.next("ack")).toEqual({ type: "ack", id: "r1", ok: true });
    second.send(reply);
    expect(await second.next("ack")).toEqual({ type: "ack", id: "r1", ok: true });

    expect(t3.sends).toEqual([{ threadId: "t1", text: "go ahead", mode: "queue", clientRequestId: `${deviceId}:r1` }]);
  });

  it("launch id repeated after reconnect launches once", async () => {
    const { t3, connected } = await setup();
    const launch = { type: "launch", id: "l1", projectId: "p1", text: "fix the flaky test" };
    const first = await connected();
    first.send(launch);
    expect((await first.next("ack")).ok).toBe(true);
    first.close();
    const second = await connected();
    second.send(launch);
    expect(await second.next("ack")).toEqual({ type: "ack", id: "l1", ok: true });
    expect(t3.launches).toHaveLength(1);
  });

  it("launch without options uses the project's T3 defaults, then the remembered ones", async () => {
    const { t3, defaults, connected } = await setup();
    const device = await connected();

    device.send({ type: "launch", id: "l1", projectId: "p1", text: "first task\nwith details" });
    expect((await device.next("ack")).ok).toBe(true);
    expect(t3.launches[0]).toEqual({ projectId: "p1", title: "first task", message: "first task\nwith details", workspace: "worktree", runtimeMode: "approval-required" });
    expect(defaults.get("p1")).toEqual({ model: "claude-opus-5", workspace: "worktree", runtimeMode: "approval-required" });

    device.send({ type: "launch", id: "l2", projectId: "p1", text: "second", model: "claude-sonnet-5-5", workspace: "root", runtimeMode: "auto" });
    expect((await device.next("ack")).ok).toBe(true);
    expect(t3.launches[1]).toMatchObject({ model: "claude-sonnet-5-5", workspace: "root", runtimeMode: "auto" });

    device.send({ type: "launch", id: "l3", projectId: "p1", text: "third" });
    expect((await device.next("ack")).ok).toBe(true);
    expect(t3.launches[2]).toMatchObject({ model: "claude-sonnet-5-5", workspace: "root", runtimeMode: "auto" });
  });

  it("disconnect closes that device with an auth error then 4401, releases it, and leaves others alone", async () => {
    const { server, connected, connect, auth, token, deviceId } = await setup();
    const other = auth.redeem(auth.createPairingCode().code, "other", "198.51.100.2");
    const victim = await connected();
    const bystander = await connect();
    bystander.hello(other.token);
    await bystander.next("home");

    expect(server.disconnect(deviceId, "device revoked, re-pair this device")).toBe(true);
    expect((await victim.next("error")).code).toBe("auth");
    expect((await victim.closed).code).toBe(4401);
    expect(server.disconnect(deviceId, "again")).toBe(false);
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN);

    const back = await connect();
    back.hello(token);
    await back.next("welcome");
  });

  it("second connection for same device closes the first with 4000 and only the newest gets pushes", async () => {
    const { t3, connected } = await setup();
    const first = await connected();
    const second = await connected();
    expect((await first.closed).code).toBe(4000);
    const firstCount = first.received.length;

    t3.threads = [summary("t9")];
    await second.next("home", (h) => h.rows.some((r) => r.threadId === "t9"));
    await pause(POLL_MS * 5);
    const homesWithT9 = second.received.filter((m) => m.type === "home" && m.rows.some((r) => r.threadId === "t9"));
    expect(homesWithT9).toHaveLength(1);
    expect(first.received).toHaveLength(firstCount);
  });

  it("session survives T3 outage: home.t3 flips to unreachable then back to ok", async () => {
    const { t3, connected } = await setup();
    t3.threads = [summary("t1")];
    const device = await connected();
    t3.down = true;
    const down = await device.next("home", (h) => h.t3 === "unreachable", POLL_MS * 5);
    expect(down.rows.map((r) => r.threadId)).toEqual(["t1"]);
    t3.down = false;
    await device.next("home", (h) => h.t3 === "ok", POLL_MS * 5);
  });

  it("T3 auth failure warns with the re-pair command", async () => {
    const { t3, connected } = await setup();
    const device = await connected();
    t3.authBroken = true;
    const home = await device.next("home", (h) => h.warnings.length > 0);
    expect(home.warnings).toContain("T3 token rejected: run `t3-cardputer-relay pair-t3` on homelab");
  });

  it("open_thread sends the page then jumps to the pending approval", async () => {
    const { t3, approvals, connected } = await setup();
    t3.threads = [summary("t1")];
    approvals.pending = [{ threadId: "t1", requestId: "req1", summary: "pnpm db:migrate", detail: [], decisions: ["allow_once", "allow_always", "deny", "deny_with_reason"] }];
    const device = await connected();
    device.send({ type: "open_thread", id: "o1", threadId: "t1" });
    expect(await device.next("ack")).toEqual({ type: "ack", id: "o1", ok: true });
    const page = await device.next("thread_page");
    expect(page.lines).toEqual(["reply on t1"]);
    const request = await device.next("request");
    expect(request).toMatchObject({ threadId: "t1", requestId: "req1", kind: "approval" });
  });

  it("respond on approval calls adapter.respond with mapped decision", async () => {
    const { t3, approvals, connected, deviceId } = await setup();
    t3.threads = [summary("t1")];
    const decisions: PendingApproval["decisions"] = ["allow_once", "allow_always", "deny", "deny_with_reason"];
    approvals.pending = [
      { threadId: "t1", requestId: "req1", summary: "a", detail: [], decisions },
      { threadId: "t1", requestId: "req2", summary: "b", detail: [], decisions },
    ];
    const device = await connected();
    device.send({ type: "respond", id: "p1", threadId: "t1", requestId: "req1", value: "allow_always" });
    expect(await device.next("ack")).toEqual({ type: "ack", id: "p1", ok: true });
    device.send({ type: "respond", id: "p2", threadId: "t1", requestId: "req2", value: "deny_with_reason", text: "use staging" });
    expect(await device.next("ack")).toEqual({ type: "ack", id: "p2", ok: true });

    expect(approvals.responses).toEqual([
      { threadId: "t1", requestId: "req1", decision: { kind: "allow_always" } },
      { threadId: "t1", requestId: "req2", decision: { kind: "deny_with_reason", reason: "use staging" } },
    ]);
    expect(t3.sends).toEqual([{ threadId: "t1", text: "use staging", mode: "queue", clientRequestId: `${deviceId}:p2` }]);
  });

  it("respond walks a multi-question request one question at a time, then answers T3 once", async () => {
    const { t3, connected } = await setup();
    t3.threads = [summary("t2")];
    t3.questions.set("t2", [
      { requestId: "q1", questionId: "color", prompt: "Red or blue?", options: [{ label: "Red", value: "Red" }, { label: "Blue", value: "Blue" }], multiSelect: false },
      { requestId: "q1", questionId: "why", prompt: "Why?", options: [], multiSelect: false },
    ]);
    const device = await connected();
    device.send({ type: "open_thread", id: "o1", threadId: "t2" });
    expect((await device.next("request")).lines).toEqual(["Red or blue?"]);

    device.send({ type: "respond", id: "a1", threadId: "t2", requestId: "q1", value: "Blue" });
    expect(await device.next("ack")).toMatchObject({ id: "o1", ok: true });
    expect(await device.next("ack")).toEqual({ type: "ack", id: "a1", ok: true });
    const second = await device.next("request");
    expect(second).toMatchObject({ requestId: "q1", lines: ["Why?"] });
    expect(t3.answers).toEqual([]);

    device.send({ type: "respond", id: "a2", threadId: "t2", requestId: "q1", value: "text", text: "it matches" });
    expect(await device.next("ack")).toEqual({ type: "ack", id: "a2", ok: true });
    expect(t3.answers).toEqual([{ threadId: "t2", requestId: "q1", answers: { color: "Blue", why: "it matches" } }]);
  });

  it("an adapter break flips approvals off once and calls onAdapterBroken", async () => {
    const { t3, approvals, connected, brokenReasons } = await setup();
    t3.threads = [summary("t1")];
    const device = await connected();
    approvals.broken = "snapshot moved";
    const home = await device.next("home", (h) => !h.approvals.available);
    expect(home.approvals.reason).toContain("snapshot moved");
    await pause(POLL_MS * 5);
    expect(brokenReasons).toEqual(["snapshot moved"]);
    approvals.broken = undefined;
    await device.next("home", (h) => h.approvals.available);
  });

  it("an approvals socket timeout says approvals are unreachable, keeps the thread list, and claims no fix", async () => {
    const { t3, approvals, connected, brokenReasons } = await setup();
    t3.threads = [summary("t1")];
    const device = await connected();
    approvals.unreachable = "orchestration.subscribeThread: no reply within approvalsRpcTimeoutMs=10000";
    const home = await device.next("home", (h) => !h.approvals.available);
    expect(home.t3).toBe("ok");
    expect(home.rows.map((r) => r.threadId)).toEqual(["t1"]);
    expect(home.approvals.reason).toBe("approvals unreachable: orchestration.subscribeThread: no reply within approvalsRpcTimeoutMs=10000");
    expect(brokenReasons).toEqual([]);
    approvals.unreachable = undefined;
    await device.next("home", (h) => h.approvals.available);
  });

  it("a canary failure marks approvals down on connected devices until a canary passes, whatever the live adapter says", async () => {
    const { t3, server, connected } = await setup();
    t3.threads = [summary("t1")];
    const device = await connected();
    server.markApprovalsDown("canary respond: decision not accepted", "checking");
    const down = await device.next("home", (h) => !h.approvals.available);
    expect(down.approvals.reason).toContain("canary respond: decision not accepted");
    await pause(POLL_MS * 5);
    server.markApprovalsUp();
    await device.next("home", (h) => h.approvals.available);
  });

  it("the device text claims a fix only once one is running, and says it is checking again before that", async () => {
    const { t3, server, connected } = await setup();
    t3.threads = [summary("t1")];
    const device = await connected();
    server.markApprovalsDown("canary respond: nope", "checking");
    const checking = await device.next("home", (h) => !h.approvals.available);
    expect(checking.approvals.reason).toBe("approvals down: canary respond: nope, checking again");
    server.markApprovalsDown("canary respond: nope", "fixing");
    const fixing = await device.next("home", (h) => h.approvals.reason?.includes("fix in progress") === true);
    expect(fixing.approvals.reason).toBe("approvals down: canary respond: nope, fix in progress");
    server.markApprovalsDown("canary respond: nope", "none");
    const none = await device.next("home", (h) => h.approvals.reason === "approvals down: canary respond: nope");
    expect(none.approvals.available).toBe(false);
  });

  it("a repair warning shows on Home until approvals come back up", async () => {
    const { t3, server, connected } = await setup();
    t3.threads = [summary("t1")];
    const device = await connected();
    server.markApprovalsDown("canary respond: nope", "none");
    server.setRepairWarning("approvals repair gave up after 3 attempts for T3 0.0.27+orch3");
    const warned = await device.next("home", (h) => h.warnings.length > 0);
    expect(warned.warnings).toContain("approvals repair gave up after 3 attempts for T3 0.0.27+orch3");
    server.markApprovalsUp();
    const up = await device.next("home", (h) => h.approvals.available);
    expect(up.warnings).toEqual([]);
  });

  it("frame over device maxFrameBytes is replaced by error naming max_frame_bytes", async () => {
    const { t3, connect, token } = await setup();
    t3.threads = Array.from({ length: 8 }, (_, i) => summary(`thread-${i}`, "running", HOURS_AGO(2), "a long title that fills the row"));
    const device = await connect();
    device.hello(token, { maxFrameBytes: 256 });
    await device.next("welcome");
    const error = await device.next("error");
    expect(error.code).toBe("internal");
    expect(error.message).toMatch(/max_frame_bytes=256, home needed \d+/);
    expect(device.received.some((m) => m.type === "home")).toBe(false);
  });

  it("a completed thread that auto-settles out of the active list stays on home as done", async () => {
    const { t3, connected } = await setup();
    t3.threads = [summary("t5", "completed")];
    const device = await connected();
    expect(device.received.find((m) => m.type === "home")).toMatchObject({ rows: [{ threadId: "t5", kind: "done" }] });
    t3.threads = [summary("t6")];
    const home = await device.next("home", (h) => h.rows.some((r) => r.threadId === "t6"));
    expect(home.rows.map((r) => [r.threadId, r.kind])).toEqual([["t6", "running"], ["t5", "done"]]);
  });

  it("pushes the open thread's page when it changes, without the device asking", async () => {
    const { t3, connected } = await setup();
    t3.threads = [summary("t1", "running", HOURS_AGO(3))];
    const device = await connected();
    device.send({ type: "open_thread", id: "o1", threadId: "t1" });
    expect((await device.next("thread_page")).header.status).toBe("running");
    await pause(POLL_MS * 4);
    expect(t3.reads).toBe(1);

    t3.replies.set("t1", "all done");
    t3.threads = [summary("t1", "completed", HOURS_AGO(2))];
    const page = await device.next("thread_page", (p) => p.header.status === "completed");
    expect(page.lines).toEqual(["all done"]);
    await pause(POLL_MS * 4);
    expect(t3.reads).toBe(2);
    expect(device.received.filter((m) => m.type === "thread_page")).toHaveLength(2);
  });

  it("trusts only the last X-Forwarded-For hop from a loopback peer", async () => {
    const { connect, auth } = await setup({ authFailuresPerWindow: 1 });
    const device = await connect({ headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.77" } });
    device.hello("not-a-token");
    expect((await device.closed).code).toBe(4401);
    expect(auth.lockout.check("198.51.100.77").allowed).toBe(false);
    expect(auth.lockout.check("203.0.113.9").allowed).toBe(true);
  });

  it("terminates a device that stops answering pings and keeps one that answers", async () => {
    const { connected, token, connect } = await setup({ heartbeatIntervalMs: 20, heartbeatMaxMissed: 2 });
    const silent = await connect({ autoPong: false });
    silent.hello(token);
    await silent.next("welcome");
    expect((await silent.closed).code).toBe(1006);

    const alive = await connected();
    await pause(20 * 8);
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("acks a bad request with ok false naming the field and keeps the socket open", async () => {
    const { connected } = await setup();
    const device = await connected();
    device.send({ type: "reply", id: "x1", threadId: "t1", text: "", mode: "queue" });
    expect(await device.next("ack")).toMatchObject({ id: "x1", ok: false });
    device.send({ type: "open_thread", id: "x2", threadId: "missing" });
    expect(await device.next("ack")).toEqual({ type: "ack", id: "x2", ok: false, error: "thread not found: missing" });
  });
});

describe("watcher", () => {
  it("a throwing listener neither stops polling nor starves the other listeners", async () => {
    const watcher = new Watcher(new FakeT3(), new FakeApprovals(), 5);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    let seen = 0;
    watcher.onChange(() => {
      throw new Error("listener blew up");
    });
    watcher.onChange(() => seen++);
    try {
      watcher.start();
      await pause(60);
    } finally {
      watcher.stop();
      console.error = original;
    }
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("logs each change of T3 reachability once and warns on Home with the HTTP status when it is not a plain connection failure", async () => {
    const t3 = new FakeT3();
    let failure: Error | undefined;
    t3.listProjects = async () => {
      if (failure) throw failure;
      return t3.projects;
    };
    const watcher = new Watcher(t3, new FakeApprovals(), 5);
    const errors: string[] = [];
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(String(args[0])));
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
    const snapshots: WatchSnapshot[] = [];
    watcher.onChange((snapshot) => snapshots.push(snapshot));
    const settle = async () => {
      const at = snapshots.length;
      await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(at + 3));
      return snapshots.at(-1)!;
    };
    try {
      watcher.start();
      await settle();
      failure = new T3UnavailableError("T3 at http://127.0.0.1:3773 answered HTTP 403 (t3_project_list), reconnecting", { httpStatus: 403 });
      const forbidden = await settle();
      expect(forbidden.t3).toBe("unreachable");
      expect(forbidden.warnings).toEqual(["T3 at http://127.0.0.1:3773 answered HTTP 403 (t3_project_list), reconnecting"]);
      expect(errors.filter((e) => e.includes("HTTP 403"))).toHaveLength(1);
      failure = new T3UnavailableError("T3 unreachable at http://127.0.0.1:3773 (t3_project_list)");
      const down = await settle();
      expect(down.warnings).toEqual([]);
      expect(errors.filter((e) => e.includes("T3 unreachable at"))).toHaveLength(1);
      failure = undefined;
      const back = await settle();
      expect(back.t3).toBe("ok");
      expect(logs.filter((l) => l.includes("T3 reachable again"))).toHaveLength(1);
    } finally {
      watcher.stop();
      vi.restoreAllMocks();
    }
  });

  it("stop releases callers still waiting for the first snapshot", async () => {
    const watcher = new Watcher(new FakeT3(), new FakeApprovals(), 60_000);
    const waiting = watcher.current();
    watcher.stop();
    expect((await waiting).t3).toBe("unreachable");
  });
});

describe("pairing endpoint", () => {
  async function pair(port: number, body: string) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("redeems a code for a token that opens a session", async () => {
    const { server, auth, connect } = await setup();
    const { code } = auth.createPairingCode();
    const paired = await pair(server.port, JSON.stringify({ code, name: "second cardputer" }));
    expect(paired.status).toBe(200);
    const device = await connect();
    device.hello(paired.body.token as string);
    await device.next("welcome");
  });

  it("answers every pairing failure the same way", async () => {
    const { server } = await setup();
    const unknown = await pair(server.port, JSON.stringify({ code: "AAAAAAAA", name: "x" }));
    const malformed = await pair(server.port, "not json");
    expect(unknown).toEqual({ status: 401, body: { error: "pairing failed" } });
    expect(malformed).toEqual(unknown);
  });
});
