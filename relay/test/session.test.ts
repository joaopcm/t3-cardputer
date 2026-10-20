import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AdapterBrokenError, type ApprovalDecision, type ApprovalsAdapter, type PendingApproval } from "../src/approvals/index.js";
import { DeviceAuth } from "../src/auth/devices.js";
import { DEFAULT_CONFIG, DEFAULT_LIMITS, type Limits } from "../src/config.js";
import { DefaultsStore } from "../src/defaults-store.js";
import { relayMessageSchema, type RelayMessage } from "../src/protocol/messages.js";
import { SecretsStore } from "../src/secrets.js";
import { startServer, type T3Client } from "../src/server.js";
import { Watcher } from "../src/watcher.js";
import type { Stt } from "../src/stt/types.js";
import { T3AuthError, T3UnavailableError, type T3LaunchInput, type T3Project, type T3Question, type T3ThreadSummary } from "../src/t3/mcp.js";

const POLL_MS = 20;
const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function summary(threadId: string, status = "running", updatedAt = HOURS_AGO(2), title = `title ${threadId}`): T3ThreadSummary {
  return { threadId, projectId: "p1", title, status, updatedAt };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

class FakeT3 implements T3Client {
  down = false;
  authBroken = false;
  projects: T3Project[] = [{ projectId: "p1", name: "api", defaultModel: "claude-opus-5", defaultWorkspace: "worktree" }];
  threads: T3ThreadSummary[] = [];
  questions = new Map<string, T3Question[]>();
  sends: { threadId: string; text: string; mode: string; clientRequestId: string }[] = [];
  launches: T3LaunchInput[] = [];
  answers: { threadId: string; requestId: string; answers: Record<string, unknown> }[] = [];
  sendGate: Promise<void> | undefined;
  replies = new Map<string, string>();
  reads = 0;

  private guard(): void {
    if (this.down) throw new T3UnavailableError("T3 unreachable at test");
    if (this.authBroken) throw new T3AuthError("mcp", "T3 rejected the MCP token (401)");
  }

  async listProjects() {
    this.guard();
    return this.projects;
  }
  async listThreads(projectId: string) {
    this.guard();
    return this.threads.filter((t) => t.projectId === projectId);
  }
  async listRecentlyCompleted(projectId: string, sinceMs: number) {
    this.guard();
    return this.threads.filter((t) => t.projectId === projectId && t.status === "completed" && Date.parse(t.updatedAt) >= sinceMs);
  }
  async listQuestions(threadId: string) {
    this.guard();
    return this.questions.get(threadId) ?? [];
  }
  async answerQuestion(threadId: string, requestId: string, answers: Record<string, unknown>) {
    this.guard();
    this.answers.push({ threadId, requestId, answers });
  }
  async latestAssistantMessage(threadId: string) {
    this.guard();
    this.reads++;
    return { text: this.replies.get(threadId) ?? `reply on ${threadId}`, model: "claude-opus-5", at: HOURS_AGO(2) };
  }
  async send(threadId: string, text: string, mode: "queue" | "steer", clientRequestId: string) {
    this.guard();
    this.sends.push({ threadId, text, mode, clientRequestId });
    await this.sendGate;
  }
  async launch(input: T3LaunchInput) {
    this.guard();
    this.launches.push(input);
    return { threadId: `launched-${this.launches.length}` };
  }
}

class FakeApprovals implements ApprovalsAdapter {
  pending: PendingApproval[] = [];
  responses: { threadId: string; requestId: string; decision: ApprovalDecision }[] = [];
  broken: string | undefined;

  async listPending(threadIds: string[]) {
    if (this.broken !== undefined && threadIds.length > 0) throw new AdapterBrokenError(this.broken);
    return this.pending.filter((p) => threadIds.includes(p.threadId));
  }
  async respond(threadId: string, requestId: string, decision: ApprovalDecision) {
    this.responses.push({ threadId, requestId, decision });
    this.pending = this.pending.filter((p) => p.requestId !== requestId);
  }
  async close() {}
}

const fakeStt: Stt = { transcribe: async () => "" };

type Closed = { code: number; reason: string };

class Device {
  readonly received: RelayMessage[] = [];
  readonly closed: Promise<Closed>;
  private readonly unread: RelayMessage[] = [];
  private wake: (() => void) | undefined;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) throw new Error("relay sent a binary frame");
      const text = data.toString();
      if (/[^\x20-\x7e]/.test(text)) throw new Error(`relay sent non-ascii: ${text}`);
      const msg = relayMessageSchema.parse(JSON.parse(text));
      this.received.push(msg);
      this.unread.push(msg);
      this.wake?.();
    });
    this.closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static async open(port: number, options: WebSocket.ClientOptions = {}): Promise<Device> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/device`, options);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new Device(ws);
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  hello(token: string, overrides: Record<string, unknown> = {}): void {
    this.send({ type: "hello", v: 1, token, fw: "0.1.0", cols: 40, bodyRows: 8, maxFrameBytes: 4096, maxHomeRows: 8, ...overrides });
  }

  async next<T extends RelayMessage["type"]>(
    type: T,
    match: (msg: Extract<RelayMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Extract<RelayMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.unread.findIndex((m) => m.type === type && match(m as Extract<RelayMessage, { type: T }>));
      if (index !== -1) return this.unread.splice(index, 1)[0] as Extract<RelayMessage, { type: T }>;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${type} within ${timeoutMs} ms, got ${JSON.stringify(this.unread)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  close(): void {
    this.ws.terminate();
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(limits: Partial<Limits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-session-"));
  const allLimits: Limits = { ...DEFAULT_LIMITS, pollIntervalMs: POLL_MS, helloTimeoutMs: 150, ...limits };
  const auth = new DeviceAuth(new SecretsStore(join(dir, "secrets.json")), allLimits);
  const { code } = auth.createPairingCode();
  const { token, deviceId } = auth.redeem(code, "cardputer", "198.51.100.1");
  const t3 = new FakeT3();
  const approvals = new FakeApprovals();
  const defaults = new DefaultsStore(join(dir, "defaults.json"));
  const brokenReasons: string[] = [];
  const server = await startServer({
    config: { ...DEFAULT_CONFIG, port: 0, stateDir: dir, limits: allLimits },
    t3,
    approvals,
    auth,
    defaults,
    stt: fakeStt,
    approvalsState: () => ({ available: true }),
    onAdapterBroken: (reason) => brokenReasons.push(reason),
  });
  cleanups.push(() => server.close());
  const connect = async (options: WebSocket.ClientOptions = {}) => {
    const device = await Device.open(server.port, options);
    cleanups.push(() => device.close());
    return device;
  };
  const connected = async (overrides: Record<string, unknown> = {}) => {
    const device = await connect();
    device.hello(token, overrides);
    await device.next("welcome");
    await device.next("home");
    return device;
  };
  return { server, auth, token, deviceId, t3, approvals, defaults, brokenReasons, connect, connected };
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
