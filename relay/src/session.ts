import type WebSocket from "ws";
import { AdapterBrokenError, ApprovalRejectedError, type ApprovalDecision, type ApprovalsAdapter, type PendingApproval } from "./approvals/index.js";
import { LockedOutError, type DeviceAuth } from "./auth/devices.js";
import type { Limits } from "./config.js";
import type { DefaultsStore, ProjectDefaults } from "./defaults-store.js";
import { FrameBudgetError, encodeFrame, encodePreWelcomeError } from "./protocol/frame.js";
import {
  CLOSE_AUTH,
  CLOSE_BAD_HELLO,
  CLOSE_HELLO_TIMEOUT,
  CLOSE_REPLACED,
  FIRST_FRAME_NOT_HELLO,
  PROTOCOL_VERSION,
  ProtocolError,
  clipText,
  parseDeviceMessage,
  rejectionFor,
  type DeviceMessage,
  type ErrorCode,
  type RelayMessage,
} from "./protocol/messages.js";
import { AudioBuffer, BudgetError } from "./stt/audio-buffer.js";
import type { Stt } from "./stt/types.js";
import { T3AuthError, T3UnavailableError, type T3Mcp, type T3Project, type T3Question, type T3ThreadSummary } from "./t3/mcp.js";
import { toDeviceAscii } from "./text/device-text.js";
import { buildHome } from "./views/home.js";
import { buildProjects } from "./views/projects.js";
import { buildRequest } from "./views/request.js";
import { buildThreadPage, type ThreadPageMessage } from "./views/thread.js";
import { EMPTY_SNAPSHOT, T3_AUTH_WARNING, type AdapterHealth, type WatchSnapshot, type Watcher, type WatcherT3 } from "./watcher.js";

export type T3Client = WatcherT3 & Pick<T3Mcp, "answerQuestion" | "latestAssistantMessage" | "send" | "launch">;
export type ApprovalsState = { available: boolean; reason?: string };
export type ApprovalsDownPhase = "checking" | "fixing" | "none";
const DOWN_PHASE_SUFFIX: Record<ApprovalsDownPhase, string> = { checking: ", checking again", fixing: ", fix in progress", none: "" };

export type HubDeps = {
  limits: Limits;
  relayVersion: string;
  t3: T3Client;
  approvals: ApprovalsAdapter;
  auth: Pick<DeviceAuth, "verify">;
  defaults: Pick<DefaultsStore, "get" | "remember">;
  stt: Stt;
  approvalsState: () => ApprovalsState;
  warnings?: () => string[];
  onAdapterBroken?: (reason: string) => ApprovalsDownPhase;
};

type Hello = Extract<DeviceMessage, { type: "hello" }>;
type Ack = Extract<RelayMessage, { type: "ack" }>;
type Of<T extends DeviceMessage["type"]> = Extract<DeviceMessage, { type: T }>;
type PendingRequest = { kind: "approval"; approval: PendingApproval } | { kind: "question"; question: T3Question };

// receipt: RFC 6455 7.4.1, 1011 is a server-side failure
const CLOSE_INTERNAL = 1011;
// T3 has no per-project runtime mode default, and approval-required is the only mode whose approvals reach the device
const FALLBACK_RUNTIME_MODE = "approval-required";
const NOT_DEVICE_SAFE = /[^\x20-\x7e]/;
const NOT_DEVICE_SAFE_ALL = /[^\x20-\x7e]/g;

export class AckCache {
  private readonly entries = new Map<string, { at: number; ack: Promise<Ack> }>();

  constructor(private readonly limits: Pick<Limits, "idempotencyTtlMs" | "idempotencyMaxEntries">) {}

  run(key: string, work: () => Promise<Ack>): Promise<Ack> {
    const now = Date.now();
    for (const [k, entry] of this.entries) {
      if (now - entry.at < this.limits.idempotencyTtlMs) break;
      this.entries.delete(k);
    }
    const hit = this.entries.get(key);
    if (hit) return hit.ack;
    if (this.entries.size >= this.limits.idempotencyMaxEntries) {
      const oldest = this.entries.keys().next().value!;
      console.error(`idempotency cache full: idempotencyMaxEntries=${this.limits.idempotencyMaxEntries}, evicting ${oldest} to remember ${key}`);
      this.entries.delete(oldest);
    }
    const ack = work();
    this.entries.set(key, { at: now, ack });
    return ack;
  }
}

export class Hub {
  readonly acks: AckCache;
  private readonly sessions = new Map<string, Session>();
  private readonly answers = new Map<string, Record<string, string>>();
  private broken: { reason: string; phase: ApprovalsDownPhase } | undefined;
  private canaryCleared: string | undefined;
  private canaryDown: { reason: string; phase: ApprovalsDownPhase } | undefined;
  private repairWarning: string | undefined;
  private adapter: AdapterHealth = { state: "idle" };

  constructor(
    readonly deps: HubDeps,
    readonly watcher: Watcher,
  ) {
    this.acks = new AckCache(deps.limits);
    watcher.onChange((snapshot) => this.onSnapshot(snapshot));
    deps.stt.onWarningChange?.(() => {
      for (const session of this.sessions.values()) session.refreshHome();
    });
  }

  accept(ws: WebSocket, source: string): void {
    new Session(ws, source, this);
  }

  claim(deviceId: string, session: Session): void {
    const older = this.sessions.get(deviceId);
    this.sessions.set(deviceId, session);
    older?.replace();
    this.watcher.start();
  }

  release(deviceId: string, session: Session): void {
    if (this.sessions.get(deviceId) !== session) return;
    this.sessions.delete(deviceId);
    if (this.sessions.size === 0) this.watcher.stop();
  }

  disconnect(deviceId: string, reason: string): boolean {
    const session = this.sessions.get(deviceId);
    if (session === undefined) return false;
    this.release(deviceId, session);
    session.revoke(reason);
    return true;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.terminate();
    this.sessions.clear();
    this.watcher.stop();
  }

  warnings(): string[] {
    return [...(this.deps.warnings?.() ?? []), this.deps.stt.warning?.(), this.repairWarning].filter((warning) => warning !== undefined);
  }

  setRepairWarning(text: string | undefined): void {
    if (text === this.repairWarning) return;
    this.repairWarning = text;
    for (const session of this.sessions.values()) session.refreshHome();
  }

  approvalsState(): ApprovalsState {
    if (this.broken !== undefined) return { available: false, reason: clipText(`approvals down: ${this.broken.reason}${DOWN_PHASE_SUFFIX[this.broken.phase]}`) };
    if (this.canaryDown !== undefined) return { available: false, reason: clipText(`approvals down: ${this.canaryDown.reason}${DOWN_PHASE_SUFFIX[this.canaryDown.phase]}`) };
    if (this.adapter.state === "unauthorized") return { available: false, reason: T3_AUTH_WARNING };
    if (this.adapter.state === "unreachable") return { available: false, reason: clipText(`approvals unreachable: ${this.adapter.reason}`) };
    return this.deps.approvalsState();
  }

  markApprovalsDown(reason: string, phase: ApprovalsDownPhase): void {
    this.canaryDown = { reason, phase };
    if (this.broken !== undefined) this.broken.phase = phase;
    console.error(`approvals marked down by canary (${phase}): ${reason}`);
    this.refreshHomes();
  }

  markApprovalsUp(): void {
    if (this.canaryDown === undefined && this.repairWarning === undefined && this.broken === undefined) return;
    this.canaryCleared = this.broken?.reason;
    this.canaryDown = undefined;
    this.repairWarning = undefined;
    this.broken = undefined;
    this.refreshHomes();
  }

  adapterWorked(): void {
    this.broken = undefined;
    this.canaryCleared = undefined;
  }

  adapterBroke(reason: string, refresh = true): void {
    if (this.broken?.reason === reason) return;
    let phase: ApprovalsDownPhase = "none";
    if (reason !== this.canaryCleared) {
      try {
        phase = this.deps.onAdapterBroken?.(reason) ?? "none";
      } catch (error) {
        console.error("onAdapterBroken threw, approvals stay marked down with no check coming", error);
      }
    }
    this.broken = { reason, phase };
    console.error(`approvals adapter broken (${phase === "none" && reason === this.canaryCleared ? "the canary passed, so no repair" : phase}): ${reason}`);
    if (refresh) this.refreshHomes();
  }

  private refreshHomes(): void {
    for (const session of this.sessions.values()) session.refreshHome();
  }

  answersFor(threadId: string, requestId: string): Record<string, string> {
    const key = `${threadId}\n${requestId}`;
    let collected = this.answers.get(key);
    if (!collected) this.answers.set(key, (collected = {}));
    return collected;
  }

  forgetAnswers(threadId: string, requestId: string): void {
    this.answers.delete(`${threadId}\n${requestId}`);
  }

  private onSnapshot(snapshot: WatchSnapshot): void {
    this.adapter = snapshot.adapter;
    if (snapshot.adapter.state === "broken") this.adapterBroke(snapshot.adapter.reason, false);
    if (snapshot.adapter.state === "ok") this.adapterWorked();
    if (snapshot.adapter.state === "idle") this.broken = undefined;
    if (snapshot.t3 === "ok") {
      const live = new Set([...snapshot.questions].flatMap(([threadId, qs]) => qs.map((q) => `${threadId}\n${q.requestId}`)));
      for (const key of this.answers.keys()) if (!live.has(key)) this.answers.delete(key);
    }
    for (const session of this.sessions.values()) session.onSnapshot(snapshot);
  }
}

export class Session {
  private hello: Hello | undefined;
  private deviceId: string | undefined;
  private established: Promise<boolean> | undefined;
  private closed = false;
  private lastHomeKey: string | undefined;
  private openThreadId: string | undefined;
  private shownRequestKey: string | undefined;
  private refusedRequestKey: string | undefined;
  private openPage = 1;
  private shownPageVersion: string | undefined;
  private refreshingPage = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private missedPongs = 0;
  private readonly messages = new Map<string, { updatedAt: string; message: Awaited<ReturnType<T3Client["latestAssistantMessage"]>> }>();
  private readonly helloTimer: NodeJS.Timeout;
  private lastSnapshot: WatchSnapshot | undefined;
  private audio: { buffer: AudioBuffer; idleTimer: NodeJS.Timeout } | undefined;
  private audioAbort: string | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly source: string,
    private readonly hub: Hub,
  ) {
    const { helloTimeoutMs } = hub.deps.limits;
    this.helloTimer = setTimeout(() => this.refuse("hello_timeout", `no hello within helloTimeoutMs=${helloTimeoutMs}`, CLOSE_HELLO_TIMEOUT), helloTimeoutMs);
    ws.on("message", (data, isBinary) => {
      this.onFrame(data, isBinary).catch((error: unknown) => {
        console.error(`device ${this.deviceId}: frame handling failed`, error);
        this.send({ type: "error", code: "internal", message: clipText(`relay failed: ${(error as Error).message}`) });
      });
    });
    ws.on("close", () => this.onClose());
    ws.on("error", (error) => console.error(`device socket error from ${source}`, error));
  }

  replace(): void {
    this.closed = true;
    this.ws.close(CLOSE_REPLACED, "replaced");
  }

  revoke(reason: string): void {
    this.send({ type: "error", code: "auth", message: clipText(reason) });
    this.closed = true;
    this.ws.close(CLOSE_AUTH, "revoked");
  }

  terminate(): void {
    this.closed = true;
    this.ws.terminate();
  }

  onSnapshot(snapshot: WatchSnapshot): void {
    if (this.closed || !this.hello) return;
    this.pushHome(snapshot);
    this.refreshOpenPage(snapshot);
    this.showOpenRequest(snapshot);
  }

  refreshHome(): void {
    if (this.closed || !this.hello || !this.lastSnapshot) return;
    this.pushHome(this.lastSnapshot);
  }

  private onClose(): void {
    clearTimeout(this.helloTimer);
    clearInterval(this.heartbeat);
    this.dropAudio();
    this.closed = true;
    if (this.deviceId !== undefined) this.hub.release(this.deviceId, this);
  }

  private async onFrame(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    const raw = isBinary ? "" : data.toString();
    if (!this.established) {
      this.established = this.onHello(raw, isBinary).catch((error: unknown) => {
        console.error(`device hello from ${this.source} failed`, error);
        return this.refuse("internal", "relay failed while checking hello", CLOSE_INTERNAL);
      });
      return;
    }
    if (!(await this.established) || this.closed) return;
    if (isBinary) {
      this.onAudioFrame(toBuffer(data));
      return;
    }
    let msg: DeviceMessage;
    try {
      msg = parseDeviceMessage(raw);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      const rejection = rejectionFor(raw, error, true);
      if (rejection.kind === "ack") this.send({ type: "ack", id: rejection.id, ok: false, error: rejection.error });
      else this.send({ type: "error", code: rejection.code, message: rejection.message });
      if (rejection.kind === "error" && rejection.close !== undefined) this.ws.close(rejection.close);
      return;
    }
    if (msg.type === "hello") {
      this.send({ type: "error", code: "bad_message", message: "hello already received on this connection" });
      return;
    }
    if (msg.type === "audio_end") {
      await this.audioEnd(msg.id);
      return;
    }
    this.send(await this.handle(msg));
  }

  private async onHello(raw: string, isBinary: boolean): Promise<boolean> {
    clearTimeout(this.helloTimer);
    if (isBinary) return this.refuse("bad_message", FIRST_FRAME_NOT_HELLO, CLOSE_BAD_HELLO);
    let msg: DeviceMessage;
    try {
      msg = parseDeviceMessage(raw);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      const rejection = rejectionFor(raw, error, false);
      if (rejection.kind === "ack") throw new Error("rejectionFor returned an ack before welcome");
      return this.refuse(rejection.code, rejection.message, rejection.close ?? CLOSE_BAD_HELLO);
    }
    if (msg.type !== "hello") return this.refuse("bad_message", FIRST_FRAME_NOT_HELLO, CLOSE_BAD_HELLO);

    let device;
    try {
      device = this.hub.deps.auth.verify(msg.token, this.source);
    } catch (error) {
      if (!(error instanceof LockedOutError)) throw error;
      console.error(`device auth refused for ${this.source}: ${error.reason}, retry in ${error.retryAfterMs} ms`);
      return this.refuse("auth", error.message, CLOSE_AUTH);
    }
    if (!device) return this.refuse("auth", "token rejected, re-pair this device", CLOSE_AUTH);
    if (this.closed) return false;

    this.hello = msg;
    this.deviceId = device.id;
    this.hub.claim(device.id, this);
    this.startHeartbeat();
    this.send({ type: "welcome", v: PROTOCOL_VERSION, relay: this.hub.deps.relayVersion });
    const snapshot = await this.firstSnapshot();
    if (this.closed) return false;
    this.pushHome(snapshot);
    return true;
  }

  private firstSnapshot(): Promise<WatchSnapshot> {
    const { mcpRequestTimeoutMs } = this.hub.deps.limits;
    const slow: WatchSnapshot = { ...EMPTY_SNAPSHOT, t3: "unreachable", warnings: [`T3 slow: no answer within mcpRequestTimeoutMs=${mcpRequestTimeoutMs}, home follows when it answers`] };
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(slow), mcpRequestTimeoutMs);
      timer.unref();
      void this.hub.watcher.current().then((snapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      });
    });
  }

  private refuse(code: ErrorCode, message: string, closeCode: number): false {
    this.closed = true;
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(encodePreWelcomeError(code, clipText(message)));
      this.ws.close(closeCode);
    }
    return false;
  }

  private send(msg: RelayMessage): boolean {
    if (this.ws.readyState !== this.ws.OPEN || !this.hello) return false;
    let frame: string;
    let delivered = true;
    try {
      frame = encodeFrame(msg, this.hello.maxFrameBytes);
    } catch (error) {
      if (!(error instanceof FrameBudgetError)) throw error;
      console.error(`device ${this.deviceId}: ${error.message}`);
      frame = encodeFrame({ type: "error", code: "internal", message: clipText(error.message) }, this.hello.maxFrameBytes);
      delivered = false;
    }
    if (NOT_DEVICE_SAFE.test(frame)) {
      console.error(`relay bug: ${msg.type} frame for device ${this.deviceId} carries non-ascii, replaced with ?: ${frame.slice(0, 200)}`);
      frame = frame.replace(NOT_DEVICE_SAFE_ALL, "?");
    }
    this.ws.send(frame);
    return delivered;
  }

  private pushHome(snapshot: WatchSnapshot): void {
    const hello = this.hello!;
    this.lastSnapshot = snapshot;
    const home = buildHome({
      threads: snapshot.threads,
      approvals: snapshot.approvals,
      questions: snapshot.questions,
      now: new Date(),
      maxRows: Math.min(hello.maxHomeRows, this.hub.deps.limits.maxHomeRows),
      cols: hello.cols,
      approvalsState: this.hub.approvalsState(),
      warnings: [...snapshot.warnings, ...this.hub.warnings()].map(clipText),
      t3: snapshot.t3,
    });
    const key = JSON.stringify(home);
    if (key === this.lastHomeKey) return;
    this.lastHomeKey = key;
    this.send(home);
  }

  private showOpenRequest(snapshot: WatchSnapshot): void {
    if (this.openThreadId === undefined) return;
    const pending = this.pendingRequest(this.openThreadId, snapshot);
    if (!pending) {
      this.shownRequestKey = undefined;
      return;
    }
    this.showRequest(this.openThreadId, pending);
  }

  private showRequest(threadId: string, pending: PendingRequest): void {
    const key = pending.kind === "approval" ? pending.approval.requestId : `${pending.question.requestId}\n${pending.question.questionId}`;
    if (key === this.shownRequestKey || key === this.refusedRequestKey) return;
    const { cols, bodyRows, maxFrameBytes } = this.hello!;
    const screen = { cols, bodyRows, maxFrameBytes };
    let request: RelayMessage;
    try {
      request = pending.kind === "approval" ? buildRequest(pending.approval, screen) : buildRequest(pending.question, screen, threadId);
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof FrameBudgetError)) throw error;
      console.error(`device ${this.deviceId}: request ${key} cannot be shown: ${error.message}`);
      if (this.send({ type: "error", code: "internal", message: clipText(error.message) })) this.refusedRequestKey = key;
      return;
    }
    if (this.send(request)) this.shownRequestKey = key;
  }

  private pendingRequest(threadId: string, snapshot: WatchSnapshot): PendingRequest | undefined {
    const approval = snapshot.approvals.find((a) => a.threadId === threadId);
    if (approval) return { kind: "approval", approval };
    const questions = snapshot.questions.get(threadId) ?? [];
    const first = questions[0];
    if (!first) return undefined;
    const collected = this.hub.answersFor(threadId, first.requestId);
    const question = questions.find((q) => q.requestId === first.requestId && !(q.questionId in collected));
    return question && { kind: "question", question };
  }

  private async handle(msg: Exclude<DeviceMessage, Hello | Of<"audio_end">>): Promise<Ack> {
    const key = `${this.deviceId}:${msg.id}`;
    switch (msg.type) {
      case "reply":
        return this.hub.acks.run(key, () => this.guarded(msg.id, () => this.reply(msg, key)));
      case "launch":
        return this.hub.acks.run(key, () => this.guarded(msg.id, () => this.launch(msg)));
      case "respond":
        return this.hub.acks.run(key, () => this.guarded(msg.id, () => this.respond(msg, key)));
      case "open_thread":
        return this.guarded(msg.id, () => this.openThread(msg.id, msg.threadId, 1));
      case "page":
        return this.guarded(msg.id, () => this.openThread(msg.id, msg.threadId, msg.page));
      case "list_projects":
        return this.guarded(msg.id, () => this.listProjects(msg.id));
      case "refresh":
        return this.guarded(msg.id, () => this.refresh(msg.id));
      case "audio_start":
        return this.audioStart(msg.id);
      case "audio_cancel":
        this.dropAudio();
        this.audioAbort = undefined;
        return ok(msg.id);
    }
  }

  private audioStart(id: string): Ack {
    if (this.audio) return fail(id, "audio already started, send audio_end or audio_cancel first");
    const { audioMaxSeconds } = this.hub.deps.limits;
    this.audioAbort = undefined;
    this.audio = { buffer: new AudioBuffer(16000, audioMaxSeconds), idleTimer: this.idleTimer() };
    return ok(id);
  }

  private idleTimer(): NodeJS.Timeout {
    const { audioIdleTimeoutMs } = this.hub.deps.limits;
    return setTimeout(
      () => this.abortAudio(`audio budget: audio_idle_timeout_ms=${audioIdleTimeoutMs}, no audio frame for ${audioIdleTimeoutMs}ms, recording dropped`),
      audioIdleTimeoutMs,
    );
  }

  private onAudioFrame(chunk: Buffer): void {
    const audio = this.audio;
    if (!audio) {
      this.send({ type: "error", code: "audio_not_started", message: "audio frame outside an audio window, send audio_start first" });
      return;
    }
    clearTimeout(audio.idleTimer);
    audio.idleTimer = this.idleTimer();
    try {
      audio.buffer.push(chunk);
    } catch (error) {
      if (error instanceof BudgetError) this.abortAudio(error.message);
      else if (error instanceof RangeError) this.send({ type: "error", code: "bad_audio", message: clipText(error.message) });
      else throw error;
    }
  }

  private abortAudio(message: string): void {
    this.dropAudio();
    this.audioAbort = message;
    this.send({ type: "error", code: "bad_audio", message: clipText(message) });
  }

  private dropAudio(): void {
    if (this.audio) clearTimeout(this.audio.idleTimer);
    this.audio = undefined;
  }

  private async audioEnd(id: string): Promise<void> {
    const audio = this.audio;
    if (!audio) {
      const why = this.audioAbort ?? "no audio window open, send audio_start first";
      this.audioAbort = undefined;
      this.send(fail(id, why));
      return;
    }
    this.dropAudio();
    if (audio.buffer.durationSec === 0) {
      this.send(fail(id, "no audio received"));
      return;
    }
    this.send(ok(id));
    try {
      const text = await this.hub.deps.stt.transcribe(audio.buffer.toWav());
      this.send({ type: "transcript_final", text: toDeviceAscii(text).replace(/\s+/g, " ").trim() });
    } catch (error) {
      console.error(`device ${this.deviceId}: transcription failed`, error);
      this.send({ type: "error", code: "internal", message: clipText((error as Error).message) });
    }
  }

  private async guarded(id: string, work: () => Promise<Ack>): Promise<Ack> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof T3UnavailableError) return fail(id, "T3 unreachable");
      if (error instanceof T3AuthError) return fail(id, T3_AUTH_WARNING);
      if (error instanceof ApprovalRejectedError) return fail(id, "already answered");
      if (error instanceof AdapterBrokenError) {
        this.hub.adapterBroke(error.reason);
        return fail(id, `approvals down: ${error.reason}`);
      }
      console.error(`device ${this.deviceId}: request ${id} failed`, error);
      return fail(id, (error as Error).message);
    }
  }

  private async reply(msg: Of<"reply">, clientRequestId: string): Promise<Ack> {
    await this.hub.deps.t3.send(msg.threadId, msg.text, msg.mode, clientRequestId);
    return ok(msg.id);
  }

  private async launch(msg: Of<"launch">): Promise<Ack> {
    const { t3, defaults } = this.hub.deps;
    const project = (await this.hub.watcher.current()).projects.find((p) => p.projectId === msg.projectId);
    if (!project) return fail(msg.id, `project not found: ${msg.projectId}`);
    const used = { ...t3Defaults(project), ...defaults.get(project.projectId), ...definedLaunchOptions(msg) };
    await t3.launch({
      projectId: project.projectId,
      title: msg.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? msg.text,
      message: msg.text,
      workspace: used.workspace,
      runtimeMode: used.runtimeMode,
      ...(used.model !== "" && used.model !== project.defaultModel ? { model: used.model } : {}),
    });
    if (used.model !== "") defaults.remember(project.projectId, used);
    return ok(msg.id);
  }

  private async respond(msg: Of<"respond">, clientRequestId: string): Promise<Ack> {
    const snapshot = await this.hub.watcher.current();
    const approval = snapshot.approvals.find((a) => a.threadId === msg.threadId && a.requestId === msg.requestId);
    if (approval) return this.respondApproval(msg, approval, clientRequestId);
    const questions = (snapshot.questions.get(msg.threadId) ?? []).filter((q) => q.requestId === msg.requestId);
    if (questions.length > 0) return this.respondQuestion(msg, questions);
    return fail(msg.id, "request is not pending");
  }

  private async respondApproval(msg: Of<"respond">, approval: PendingApproval, clientRequestId: string): Promise<Ack> {
    const kind = approval.decisions.find((d) => d === msg.value);
    if (!kind) return fail(msg.id, `value "${msg.value}" is not one of ${approval.decisions.join(", ")}`);
    if (kind === "deny_with_reason" && msg.text === undefined) return fail(msg.id, "deny_with_reason needs text");
    const decision: ApprovalDecision = kind === "deny_with_reason" ? { kind, reason: msg.text! } : { kind };
    await this.hub.deps.approvals.respond(approval.threadId, approval.requestId, decision);
    this.hub.adapterWorked();
    if (decision.kind !== "deny_with_reason") return ok(msg.id);
    try {
      await this.hub.deps.t3.send(approval.threadId, decision.reason, "queue", clientRequestId);
    } catch (error) {
      const why = error instanceof T3UnavailableError ? "T3 unreachable" : (error as Error).message;
      return fail(msg.id, `denied, but the reason was not sent: ${why}`);
    }
    return ok(msg.id);
  }

  private async respondQuestion(msg: Of<"respond">, questions: T3Question[]): Promise<Ack> {
    const collected = this.hub.answersFor(msg.threadId, msg.requestId);
    const current = questions.find((q) => !(q.questionId in collected));
    if (current) {
      const answer = msg.value === "text" ? msg.text : current.options.find((o) => o.value === msg.value)?.value;
      if (answer === undefined) {
        return fail(msg.id, msg.value === "text" ? "a text answer needs text" : `value "${msg.value}" is not an option`);
      }
      collected[current.questionId] = answer;
      const next = questions.find((q) => !(q.questionId in collected));
      if (next) {
        this.showRequest(msg.threadId, { kind: "question", question: next });
        return ok(msg.id);
      }
    }
    await this.hub.deps.t3.answerQuestion(msg.threadId, msg.requestId, collected);
    this.hub.forgetAnswers(msg.threadId, msg.requestId);
    return ok(msg.id);
  }

  private async openThread(id: string, threadId: string, page: number): Promise<Ack> {
    const snapshot = await this.hub.watcher.current();
    const summary = snapshot.threads.find((t) => t.threadId === threadId);
    if (!summary) return fail(id, `thread not found: ${threadId}`);
    const view = await this.threadPage(summary, page);
    if (page > view.pages) return fail(id, `page ${page} is past the last page ${view.pages}`);
    this.send(view);
    if (this.openThreadId !== threadId) this.shownRequestKey = undefined;
    this.openThreadId = threadId;
    this.openPage = view.page;
    this.shownPageVersion = pageVersion(summary);
    this.showOpenRequest(snapshot);
    return ok(id);
  }

  private async refresh(id: string): Promise<Ack> {
    const snapshot = await this.hub.watcher.current();
    this.lastHomeKey = undefined;
    this.pushHome(snapshot);
    const threadId = this.openThreadId;
    const summary = snapshot.threads.find((t) => t.threadId === threadId);
    if (summary === undefined) return ok(id);
    const view = await this.threadPage(summary, this.openPage);
    if (this.openThreadId !== summary.threadId) return ok(id);
    this.send(view);
    this.openPage = view.page;
    this.shownPageVersion = pageVersion(summary);
    this.shownRequestKey = undefined;
    this.refusedRequestKey = undefined;
    this.showOpenRequest(snapshot);
    return ok(id);
  }

  private refreshOpenPage(snapshot: WatchSnapshot): void {
    const threadId = this.openThreadId;
    const page = this.openPage;
    if (threadId === undefined || this.refreshingPage) return;
    const summary = snapshot.threads.find((t) => t.threadId === threadId);
    if (!summary || pageVersion(summary) === this.shownPageVersion) return;
    this.refreshingPage = true;
    this.threadPage(summary, page)
      .then((view) => {
        if (this.closed || this.openThreadId !== threadId || this.openPage !== page) return;
        this.openPage = view.page;
        this.shownPageVersion = pageVersion(summary);
        this.send(view);
      })
      .catch((error: unknown) => {
        if (!(error instanceof T3UnavailableError)) console.error(`device ${this.deviceId}: refreshing open thread ${threadId} failed`, error);
      })
      .finally(() => {
        this.refreshingPage = false;
      });
  }

  private startHeartbeat(): void {
    const { heartbeatIntervalMs, heartbeatMaxMissed } = this.hub.deps.limits;
    this.ws.on("pong", () => {
      this.missedPongs = 0;
    });
    this.heartbeat = setInterval(() => {
      if (this.missedPongs >= heartbeatMaxMissed) {
        console.error(`device ${this.deviceId}: no pong to ${this.missedPongs} pings, heartbeatMaxMissed=${heartbeatMaxMissed} at heartbeatIntervalMs=${heartbeatIntervalMs}, terminating`);
        this.ws.terminate();
        return;
      }
      this.missedPongs++;
      this.ws.ping();
    }, heartbeatIntervalMs);
  }

  private async threadPage(summary: T3ThreadSummary & { project: string }, page: number): Promise<ThreadPageMessage> {
    let cached = this.messages.get(summary.threadId);
    if (cached?.updatedAt !== summary.updatedAt) {
      cached = { updatedAt: summary.updatedAt, message: await this.hub.deps.t3.latestAssistantMessage(summary.threadId) };
      this.messages.set(summary.threadId, cached);
    }
    return buildThreadPage({
      summary,
      project: summary.project,
      message: cached.message,
      page,
      cols: this.hello!.cols,
      bodyRows: this.hello!.bodyRows,
      maxPages: this.hub.deps.limits.maxReplyPages,
    });
  }

  private async listProjects(id: string): Promise<Ack> {
    const projects = await this.hub.deps.t3.listProjects();
    const byId = new Map(projects.map((p) => [p.projectId, p]));
    const activity = new Map<string, number>();
    for (const thread of (await this.hub.watcher.current()).threads) {
      const at = Date.parse(thread.updatedAt);
      if (at > (activity.get(thread.projectId) ?? 0)) activity.set(thread.projectId, at);
    }
    const hello = this.hello!;
    const view = buildProjects(
      projects,
      { get: (projectId) => this.hub.deps.defaults.get(projectId) ?? t3Defaults(byId.get(projectId)) },
      { model: "", workspace: "root", runtimeMode: FALLBACK_RUNTIME_MODE },
      { maxRows: Math.min(hello.maxHomeRows, this.hub.deps.limits.maxHomeRows), maxFrameBytes: hello.maxFrameBytes, activity },
    );
    this.send(view);
    return ok(id);
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

function pageVersion(thread: T3ThreadSummary): string {
  return `${thread.updatedAt}\n${thread.status}`;
}

function ok(id: string): Ack {
  return { type: "ack", id, ok: true };
}

function fail(id: string, error: string): Ack {
  return { type: "ack", id, ok: false, error: clipText(error) };
}

function t3Defaults(project: T3Project | undefined): ProjectDefaults {
  return { model: project?.defaultModel ?? "", workspace: project?.defaultWorkspace ?? "root", runtimeMode: FALLBACK_RUNTIME_MODE };
}

function definedLaunchOptions(msg: Of<"launch">): Partial<ProjectDefaults> {
  const out: Partial<ProjectDefaults> = {};
  if (msg.model !== undefined) out.model = msg.model;
  if (msg.workspace !== undefined) out.workspace = msg.workspace;
  if (msg.runtimeMode !== undefined) out.runtimeMode = msg.runtimeMode;
  return out;
}
