import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import WebSocket from "ws";
import { AdapterBrokenError, type ApprovalDecision, type ApprovalsAdapter, type PendingApproval } from "../../src/approvals/index.js";
import { DeviceAuth } from "../../src/auth/devices.js";
import { DEFAULT_CONFIG, DEFAULT_LIMITS, type Limits } from "../../src/config.js";
import { DefaultsStore } from "../../src/defaults-store.js";
import { relayMessageSchema, type RelayMessage } from "../../src/protocol/messages.js";
import { SecretsStore } from "../../src/secrets.js";
import { startServer, type T3Client } from "../../src/server.js";
import type { ApprovalsDownPhase } from "../../src/session.js";
import type { Stt } from "../../src/stt/types.js";
import { T3AuthError, T3UnavailableError, type T3LaunchInput, type T3Model, type T3Project, type T3Question, type T3ThreadSummary } from "../../src/t3/mcp.js";

function nonPrintable(value: unknown): string | undefined {
  if (typeof value === "string") return /[^\x20-\x7e]/.test(value) ? JSON.stringify(value) : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  for (const item of Object.values(value)) {
    const found = nonPrintable(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

export const POLL_MS = 20;
export const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

export function summary(threadId: string, status = "running", updatedAt = HOURS_AGO(2), title = `title ${threadId}`): T3ThreadSummary {
  return { threadId, projectId: "p1", title, status, updatedAt };
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export class FakeT3 implements T3Client {
  down = false;
  authBroken = false;
  projects: T3Project[] = [{ projectId: "p1", name: "api", defaultModel: "claude-opus-5", defaultWorkspace: "worktree" }];
  models: T3Model[] = [];
  modelsError: string | undefined;
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
  async listModels() {
    this.guard();
    if (this.modelsError !== undefined) throw new Error(this.modelsError);
    return this.models;
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

export class FakeApprovals implements ApprovalsAdapter {
  pending: PendingApproval[] = [];
  responses: { threadId: string; requestId: string; decision: ApprovalDecision }[] = [];
  broken: string | undefined;
  unreachable: string | undefined;

  async listPending(threadIds: string[]) {
    if (this.broken !== undefined && threadIds.length > 0) throw new AdapterBrokenError(this.broken);
    if (this.unreachable !== undefined && threadIds.length > 0) throw new T3UnavailableError(this.unreachable);
    return this.pending.filter((p) => threadIds.includes(p.threadId));
  }
  async respond(threadId: string, requestId: string, decision: ApprovalDecision) {
    this.responses.push({ threadId, requestId, decision });
    this.pending = this.pending.filter((p) => p.requestId !== requestId);
  }
  async close() {}
}

export const fakeStt: Stt = { transcribe: async () => "" };

export type Closed = { code: number; reason: string };

export class Device {
  readonly received: RelayMessage[] = [];
  readonly closed: Promise<Closed>;
  private readonly unread: RelayMessage[] = [];
  private wake: (() => void) | undefined;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) throw new Error("relay sent a binary frame");
      const text = data.toString();
      const json: unknown = JSON.parse(text);
      const offender = nonPrintable(json);
      if (offender !== undefined) throw new Error(`relay sent non-printable text: ${offender}`);
      const msg = relayMessageSchema.parse(json);
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
export const onCleanup = (cleanup: () => Promise<void> | void) => cleanups.push(cleanup);
export function cleanupAfterEach(): void {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
}

export async function startRelay(limits: Partial<Limits> = {}, stt: Stt = fakeStt) {
  const dir = mkdtempSync(join(tmpdir(), "relay-session-"));
  const allLimits: Limits = { ...DEFAULT_LIMITS, pollIntervalMs: POLL_MS, helloTimeoutMs: 150, ...limits };
  const auth = new DeviceAuth(new SecretsStore(join(dir, "secrets.json")), allLimits);
  const t3 = new FakeT3();
  const approvals = new FakeApprovals();
  const defaults = new DefaultsStore(join(dir, "defaults.json"));
  const brokenReasons: string[] = [];
  const brokenHook: { phase: ApprovalsDownPhase } = { phase: "checking" };
  const server = await startServer({
    config: { ...DEFAULT_CONFIG, port: 0, stateDir: dir, limits: allLimits },
    t3,
    approvals,
    auth,
    defaults,
    stt,
    approvalsState: () => ({ available: true }),
    onAdapterBroken: (reason) => {
      brokenReasons.push(reason);
      return brokenHook.phase;
    },
  });
  onCleanup(() => server.close());
  return { dir, server, auth, t3, approvals, defaults, brokenReasons, brokenHook };
}
