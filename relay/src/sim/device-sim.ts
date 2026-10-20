import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { DEFAULT_LIMITS } from "../config.js";
import {
  CLOSE_AUTH,
  CLOSE_BAD_HELLO,
  CLOSE_HELLO_TIMEOUT,
  CLOSE_PROTOCOL_VERSION,
  CLOSE_REPLACED,
  DEVICE_PATH,
  PRE_WELCOME_FRAME_BYTES,
  PROTOCOL_VERSION,
  relayMessageSchema,
  type DeviceMessage,
  type RelayMessage,
} from "../protocol/messages.js";
import { deviceSocketUrl } from "./sim-config.js";
import { CHUNK_MS, parseWav, pcmChunks } from "./wav.js";

export type SimOptions = {
  url: string;
  token: string;
  cols: 40;
  bodyRows: 8;
  maxFrameBytes: number;
  script?: string[];
  wav?: string;
  write?: (text: string) => void;
  stepTimeoutMs?: number;
  transcribeTimeoutMs?: number;
  greetTimeoutMs?: number;
};

export type SimResult = { screens: string[]; problems: string[]; closeCode: number | undefined };

// receipt: relay/test/e2e.test.ts runs 11 scripted steps against the real server in about 0.4 s on loopback, so 5 s only trips a dead relay or a lost view
export const DEFAULT_STEP_TIMEOUT_MS = 5000;
// receipt: the relay answers transcript_final or an error within whisperRequestTimeoutMs, so the sim waits that long
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = DEFAULT_LIMITS.whisperRequestTimeoutMs;
// receipt: docs/protocol.md Ordering rule 2, the first home may wait up to mcpRequestTimeoutMs for a hung T3, so the sim waits that plus a step
export const DEFAULT_GREET_TIMEOUT_MS = DEFAULT_LIMITS.mcpRequestTimeoutMs + DEFAULT_STEP_TIMEOUT_MS;
const FIRMWARE_VERSION = "sim-0.1.0";
const MARKERS = { approval: "!", question: "?", failed: "x", running: "*", done: "-" } as const;

type Of<T extends RelayMessage["type"]> = Extract<RelayMessage, { type: T }>;
type ViewType = "thread_page" | "projects" | "transcript_final";
type Screen =
  | { kind: "home" }
  | { kind: "thread"; threadId: string }
  | { kind: "request"; request: Of<"request"> }
  | { kind: "reason"; request: Of<"request">; value: string }
  | { kind: "projects" }
  | { kind: "prompt"; project: Of<"projects">["items"][number] }
  | { kind: "voice"; transcript: string; target: VoiceTarget };
type VoiceTarget = { kind: "thread"; threadId: string } | { kind: "project"; projectId: string };

export async function runSim(opts: SimOptions): Promise<SimResult> {
  const sim = new DeviceSim(opts);
  return sim.run();
}

class DeviceSim {
  private ws!: WebSocket;
  private readonly write: (text: string) => void;
  private readonly stepTimeoutMs: number;
  private readonly transcribeTimeoutMs: number;
  private readonly greetTimeoutMs: number;
  private readonly clear: boolean;
  private readonly pcm: Buffer | undefined;
  private readonly screens: string[] = [];
  private readonly problems: string[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly unacked = new Set<string>();
  private readonly awaitingView = new Map<string, ViewType>();

  private closeCode: number | undefined;
  private lastError = "";
  private received = 0;
  private home: Of<"home"> | undefined;
  private page: Of<"thread_page"> | undefined;
  private projects: Of<"projects"> | undefined;
  private screen: Screen = { kind: "home" };
  private opening: string | undefined;
  private openId: string | undefined;
  private launchId: string | undefined;
  private respondId: string | undefined;
  private respondedRequest: Of<"request"> | undefined;
  private audioStartId: string | undefined;
  private audioRefused = false;
  private notice = "";
  private lastFrame = "";
  private quit = false;
  private closingByUs = false;
  private voiceTarget: VoiceTarget | undefined;

  constructor(private readonly opts: SimOptions) {
    this.write = opts.write ?? ((text) => void process.stdout.write(text));
    this.stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.transcribeTimeoutMs = opts.transcribeTimeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS;
    this.greetTimeoutMs = opts.greetTimeoutMs ?? DEFAULT_GREET_TIMEOUT_MS;
    this.clear = opts.write === undefined && process.stdout.isTTY === true;
    this.pcm = opts.wav === undefined ? undefined : parseWav(readFileSync(opts.wav));
  }

  async run(): Promise<SimResult> {
    await this.connect();
    const greeted = await this.until(() => this.home !== undefined || this.closeCode !== undefined, this.greetTimeoutMs);
    if (!greeted) this.problem(`no home within greet_timeout_ms=${this.greetTimeoutMs} of hello`);
    if (greeted) {
      for await (const line of this.lines()) {
        if (this.closeCode !== undefined || this.quit) break;
        await this.settle();
        if (this.closeCode !== undefined) break;
        await this.onLine(line);
        if (this.closeCode !== undefined || this.quit) break;
      }
      await this.settle();
    }
    await this.disconnect();
    return { screens: this.screens, problems: this.problems, closeCode: this.closeCode };
  }

  private async *lines(): AsyncGenerator<string> {
    if (this.opts.script !== undefined) {
      yield* this.opts.script;
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    rl.prompt();
    for await (const line of rl) {
      yield line;
      rl.prompt();
    }
  }

  private connect(): Promise<void> {
    this.ws = new WebSocket(deviceSocketUrl(this.opts.url, DEVICE_PATH));
    this.ws.on("message", (data, isBinary) => this.onFrame(data, isBinary));
    this.ws.on("close", (code) => {
      this.onClose(code);
    });
    return new Promise((resolve, reject) => {
      this.ws.once("error", reject);
      this.ws.once("open", () => {
        this.ws.off("error", reject);
        this.ws.on("error", (error) => this.problem(`socket error: ${error.message}`));
        this.ws.send(
          JSON.stringify({
            type: "hello",
            v: PROTOCOL_VERSION,
            token: this.opts.token,
            fw: FIRMWARE_VERSION,
            cols: this.opts.cols,
            bodyRows: this.opts.bodyRows,
            maxFrameBytes: this.opts.maxFrameBytes,
            maxHomeRows: this.opts.bodyRows,
          }),
        );
        resolve();
      });
    });
  }

  private async disconnect(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.closingByUs = true;
    const closed = this.until(() => this.ws.readyState === WebSocket.CLOSED);
    this.ws.close(1000);
    await closed;
  }

  private onClose(code: number): void {
    if (!this.closingByUs) {
      this.closeCode = code;
      this.print(`\n${this.closeAction(code)}`);
    }
    this.notify();
  }

  private closeAction(code: number): string {
    switch (code) {
      case CLOSE_PROTOCOL_VERSION:
        return `closed ${code}: protocol mismatch, stop reconnecting. ${this.lastError}`;
      case CLOSE_AUTH:
        return `closed ${code}: auth rejected, stop reconnecting and show "re-pair". ${this.lastError}`;
      case CLOSE_BAD_HELLO:
        return `closed ${code}: hello rejected, stop reconnecting. ${this.lastError}`;
      case CLOSE_HELLO_TIMEOUT:
        return `closed ${code}: hello timed out, keep the token and reconnect with backoff. ${this.lastError}`;
      case CLOSE_REPLACED:
        return `closed ${code}: taken over by another connection, stop reconnecting`;
      default:
        return `closed ${code}: firmware would reconnect with backoff`;
    }
  }

  private onFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.problem("relay sent a binary frame, the relay never sends binary");
      return;
    }
    const raw = data.toString();
    const bytes = Buffer.byteLength(raw);
    const welcomed = this.received > 0;
    const limit = welcomed ? this.opts.maxFrameBytes : PRE_WELCOME_FRAME_BYTES;
    if (bytes > limit) this.problem(`frame ${bytes} bytes over ${welcomed ? "maxFrameBytes" : "PRE_WELCOME_FRAME_BYTES"}=${limit}`);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.problem(`frame is not json: ${raw.slice(0, 60)}`);
      return;
    }
    const offender = nonPrintable(json, "");
    if (offender !== undefined) this.problem(`text is not printable ASCII at ${offender}`);
    const parsed = relayMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.problem(`frame breaks the contract: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}: ${raw.slice(0, 80)}`);
      return;
    }
    const msg = parsed.data;
    this.received++;
    if (this.received === 1 && msg.type !== "welcome" && msg.type !== "error") this.problem(`first relay frame was ${msg.type}, not welcome`);
    if (this.received === 2 && msg.type !== "home" && msg.type !== "error") this.problem(`second relay frame was ${msg.type}, not home`);
    this.checkFit(msg);
    this.onMessage(msg);
    this.render();
    this.notify();
  }

  private checkFit(msg: RelayMessage): void {
    const { cols, bodyRows } = this.opts;
    if (msg.type === "home") {
      if (msg.rows.length > bodyRows) this.problem(`home has ${msg.rows.length} rows, maxHomeRows=${bodyRows}`);
      for (const row of msg.rows) {
        if (3 + row.project.length + row.title.length > cols - 5) this.problem(`home row too long for ${cols} cols: ${row.project} ${row.title}`);
      }
    } else if (msg.type === "thread_page") {
      if (msg.lines.length > bodyRows) this.problem(`thread_page has ${msg.lines.length} lines, bodyRows=${bodyRows}`);
      if (msg.lines.some((l) => l.length > cols)) this.problem(`thread_page line over ${cols} cols`);
    } else if (msg.type === "projects") {
      if (msg.items.length > bodyRows) this.problem(`projects has ${msg.items.length} items, maxHomeRows=${bodyRows}`);
    } else if (msg.type === "request") {
      if (msg.lines.some((l) => l.length > cols)) this.problem(`request line over ${cols} cols`);
      if (msg.lines.length + msg.options.length > bodyRows) this.problem(`request has ${msg.lines.length} lines + ${msg.options.length} options, bodyRows=${bodyRows}`);
    }
  }

  private onMessage(msg: RelayMessage): void {
    switch (msg.type) {
      case "welcome":
        return;
      case "ack":
        return this.onAck(msg);
      case "home":
        this.home = msg;
        return;
      case "thread_page":
        this.page = msg;
        this.consumeView("thread_page");
        if (this.opening === msg.threadId) {
          this.opening = undefined;
          this.screen = { kind: "thread", threadId: msg.threadId };
        }
        return;
      case "request":
        if (this.isOnThread(msg.threadId)) this.screen = { kind: "request", request: msg };
        else this.notice = `request on another thread: ${msg.lines[0] ?? msg.requestId}`;
        return;
      case "projects":
        this.projects = msg;
        this.consumeView("projects");
        if (this.screen.kind === "home") this.screen = { kind: "projects" };
        return;
      case "transcript_partial":
        this.notice = `hearing: ${msg.text}`;
        return;
      case "transcript_final":
        this.consumeView("transcript_final");
        if (this.voiceTarget === undefined) this.notice = "transcript with no voice target";
        else this.screen = { kind: "voice", transcript: msg.text, target: this.voiceTarget };
        return;
      case "error":
        this.lastError = msg.message;
        if (msg.code === "bad_audio" || msg.code === "internal") this.dropAwaited("transcript_final");
        this.notice = `relay error ${msg.code}: ${msg.message}`;
        return;
    }
  }

  private isOnThread(threadId: string): boolean {
    const s = this.screen;
    if (this.opening === threadId) return true;
    if (s.kind === "thread") return s.threadId === threadId;
    return s.kind === "request" && s.request.threadId === threadId;
  }

  private onAck(msg: Of<"ack">): void {
    this.unacked.delete(msg.id);
    if (msg.ok) {
      if (msg.id === this.launchId) {
        this.screen = { kind: "home" };
        this.notice = "task launched";
      }
      return;
    }
    this.awaitingView.delete(msg.id);
    this.notice = `refused: ${msg.error ?? "no reason given"}`;
    if (msg.id === this.openId) this.opening = undefined;
    if (msg.id === this.respondId && this.respondedRequest !== undefined) this.screen = { kind: "request", request: this.respondedRequest };
    if (msg.id === this.audioStartId) this.audioRefused = true;
  }

  private dropAwaited(type: ViewType): void {
    for (const [id, awaited] of this.awaitingView) if (awaited === type) this.awaitingView.delete(id);
  }

  private consumeView(type: ViewType): void {
    for (const [id, awaited] of this.awaitingView) {
      if (awaited === type) {
        this.awaitingView.delete(id);
        return;
      }
    }
  }

  private act(build: (id: string) => DeviceMessage, view?: ViewType): string {
    const id = randomBytes(4).toString("hex");
    this.unacked.add(id);
    if (view !== undefined) this.awaitingView.set(id, view);
    this.ws.send(JSON.stringify(build(id)));
    return id;
  }

  private async onLine(raw: string): Promise<void> {
    this.notice = "";
    const line = raw.trim();
    if (line.startsWith("?")) {
      const wanted = line.slice(1);
      if (!(await this.until(() => this.lastFrame.includes(wanted)))) this.problem(`screen never showed "${wanted}" within step_timeout_ms=${this.stepTimeoutMs}`);
      return;
    }
    if (line === "/q") {
      this.quit = true;
      return;
    }
    if (line === "/b") {
      this.opening = undefined;
      this.screen = { kind: "home" };
    } else if (line === "/talk") {
      await this.talk();
    } else {
      await this.onInput(line);
    }
    this.render();
  }

  private async onInput(line: string): Promise<void> {
    const s = this.screen;
    switch (s.kind) {
      case "home":
        return this.onHome(line);
      case "projects": {
        const project = this.projects?.items[Number(line) - 1];
        if (project === undefined) this.notice = `pick 1 to ${this.projects?.items.length ?? 0}`;
        else this.screen = { kind: "prompt", project };
        return;
      }
      case "prompt":
        if (line !== "") this.launch(s.project.projectId, line);
        return;
      case "thread":
        return this.onThread(s.threadId, line);
      case "request":
        return this.onRequest(s.request, line);
      case "reason":
        if (line !== "") this.respond(s.request, s.value, line);
        return;
      case "voice":
        return this.onVoice(s, line);
    }
  }

  private onHome(line: string): void {
    if (/^\d+$/.test(line)) {
      const row = this.home?.rows[Number(line) - 1];
      if (row === undefined) {
        this.notice = `no row ${line}`;
        return;
      }
      this.opening = row.threadId;
      this.openId = this.act((id) => ({ type: "open_thread", id, threadId: row.threadId }), "thread_page");
    } else if (line.toUpperCase() === "N") {
      this.act((id) => ({ type: "list_projects", id }), "projects");
    } else if (line.toUpperCase() === "R") {
      this.act((id) => ({ type: "refresh", id }));
    } else {
      this.notice = "home keys: row number, N new task, R refresh";
    }
  }

  private onThread(threadId: string, line: string): void {
    if (line === "/r") {
      this.act((id) => ({ type: "refresh", id }));
    } else if (line === "/n" || line === "/p") {
      const page = (this.page?.page ?? 1) + (line === "/n" ? 1 : -1);
      this.act((id) => ({ type: "page", id, threadId, page }), "thread_page");
    } else if (line !== "") {
      this.reply(threadId, line);
    }
  }

  private reply(threadId: string, line: string): void {
    const steer = line.startsWith("!steer ");
    const text = steer ? line.slice("!steer ".length).trim() : line;
    if (text === "") {
      this.notice = "!steer needs text";
      return;
    }
    this.act((id) => ({ type: "reply", id, threadId, text, mode: steer ? "steer" : "queue" }));
  }

  private launch(projectId: string, text: string): void {
    this.launchId = this.act((id) => ({ type: "launch", id, projectId, text }));
  }

  private onRequest(request: Of<"request">, line: string): void {
    if (line === "") {
      this.screen = { kind: "thread", threadId: request.threadId };
      return;
    }
    if (request.options.length === 0) {
      this.respond(request, "text", line);
      return;
    }
    const option = request.options.find((o) => o.key.toUpperCase() === line.toUpperCase());
    if (option === undefined) {
      this.notice = `keys: ${request.options.map((o) => o.key).join("/")}`;
    } else if (option.value === "deny_with_reason" || option.value === "text") {
      this.screen = { kind: "reason", request, value: option.value };
    } else {
      this.respond(request, option.value);
    }
  }

  private respond(request: Of<"request">, value: string, text?: string): void {
    this.respondedRequest = request;
    this.screen = { kind: "thread", threadId: request.threadId };
    this.respondId = this.act((id) => ({
      type: "respond",
      id,
      threadId: request.threadId,
      requestId: request.requestId,
      value,
      ...(text === undefined ? {} : { text }),
    }));
  }

  private onVoice(s: Extract<Screen, { kind: "voice" }>, line: string): void {
    if (line.toLowerCase() === "x") {
      this.screen = s.target.kind === "thread" ? { kind: "thread", threadId: s.target.threadId } : { kind: "home" };
      return;
    }
    const text = line === "" ? s.transcript : line;
    if (text === "") {
      this.notice = "nothing to send, x discards";
      return;
    }
    if (s.target.kind === "thread") {
      this.reply(s.target.threadId, text);
      this.screen = { kind: "thread", threadId: s.target.threadId };
    } else {
      this.launch(s.target.projectId, text);
    }
  }

  private async talk(): Promise<void> {
    if (this.pcm === undefined) {
      this.notice = "no audio: start the sim with --wav file.wav";
      return;
    }
    const s = this.screen;
    if (s.kind === "thread") this.voiceTarget = { kind: "thread", threadId: s.threadId };
    else if (s.kind === "prompt") this.voiceTarget = { kind: "project", projectId: s.project.projectId };
    else {
      this.notice = "/talk works on a thread or a task prompt";
      return;
    }
    this.audioRefused = false;
    this.audioStartId = this.act((id) => ({ type: "audio_start", id, sampleRate: 16000 }));
    const startedAt = Date.now();
    let sent = 0;
    for (const chunk of pcmChunks(this.pcm)) {
      sent++;
      await sleep(startedAt + sent * CHUNK_MS - Date.now());
      if (this.audioRefused || this.closeCode !== undefined) break;
      this.ws.send(chunk, { binary: true });
    }
    if (this.audioRefused || this.closeCode !== undefined) return;
    this.act((id) => ({ type: "audio_end", id }), "transcript_final");
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private until(done: () => boolean, timeoutMs = this.stepTimeoutMs): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(ok);
      };
      const check = () => {
        if (done()) finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(check);
    });
  }

  private async settle(): Promise<void> {
    const transcribing = [...this.awaitingView.values()].includes("transcript_final");
    const timeoutMs = transcribing ? this.transcribeTimeoutMs : this.stepTimeoutMs;
    const settled = await this.until(() => (this.unacked.size === 0 && this.awaitingView.size === 0) || this.closeCode !== undefined, timeoutMs);
    if (settled) return;
    this.problem(`relay did not answer within ${transcribing ? "transcribe_timeout_ms" : "step_timeout_ms"}=${timeoutMs}: unacked=${this.unacked.size}, views=${[...this.awaitingView.values()].join(",")}`);
    this.unacked.clear();
    this.awaitingView.clear();
  }

  private problem(text: string): void {
    this.problems.push(text);
    this.print(`\nPROBLEM: ${text}`);
  }

  private print(text: string): void {
    this.write(`${text}\n`);
  }

  private render(): void {
    if (this.home === undefined) return;
    const frame = this.frame();
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.screens.push(frame);
    this.write(`${this.clear ? "\x1b[2J\x1b[H" : "\n"}${frame}\n`);
  }

  private frame(): string {
    const { cols, bodyRows } = this.opts;
    const view = this.view();
    const fit = (text: string) => text.slice(0, cols).padEnd(cols);
    const body = [...view.body];
    while (body.length < bodyRows) body.push("");
    const gutter = (i: number) => (view.numbered && i < view.body.length ? `${i + 1} ` : "  ");
    const rule = `  +${"-".repeat(cols)}+`;
    const out = [rule, ...view.bar.map((l) => `  |${fit(l)}|`), ...body.map((l, i) => `${gutter(i)}|${fit(l)}|`), `  |${fit(view.hint)}|`, rule];
    const notes = [...this.statusNotes(), ...(this.notice === "" ? [] : [this.notice])];
    return [...out, ...notes].join("\n");
  }

  private statusNotes(): string[] {
    if (this.home === undefined) return [];
    const notes = [...this.home.warnings];
    if (this.home.t3 === "unreachable") notes.push("T3 unreachable");
    if (!this.home.approvals.available) notes.push(`approvals down: ${this.home.approvals.reason ?? "no reason given"}`);
    if (this.screen.kind === "projects" && this.projects?.truncated !== undefined) {
      const { hidden, budget, limit, actual } = this.projects.truncated;
      notes.push(`+${hidden} more projects: ${budget}=${limit}, needed ${actual}`);
    }
    if (this.screen.kind === "thread" && this.page?.truncated !== undefined) {
      const { budget, limit, actual } = this.page.truncated;
      notes.push(`reply truncated: ${budget}=${limit}, needed ${actual}`);
    }
    return notes;
  }

  private view(): { bar: string[]; body: string[]; hint: string; numbered: boolean } {
    const s = this.screen;
    const { cols } = this.opts;
    switch (s.kind) {
      case "home": {
        const rows = this.home?.rows ?? [];
        const counts = this.home?.counts;
        return {
          bar: [`T3 sim  needs ${counts?.needs ?? 0} run ${counts?.running ?? 0} done ${counts?.done ?? 0}`],
          body: rows.map((row) => homeLine(row, cols)),
          hint: "1-8 open  N new  R refresh  /q quit",
          numbered: true,
        };
      }
      case "thread": {
        const page = this.page?.threadId === s.threadId ? this.page : undefined;
        return {
          bar: page
            ? [spread(`${page.header.project} ${page.header.title}`, page.header.status, cols), `${page.header.model} ${page.page}/${page.pages}`]
            : [`thread ${s.threadId}`, "loading"],
          body: page?.lines ?? [],
          hint: "text reply !steer x /n /p /r /talk /b",
          numbered: false,
        };
      }
      case "request":
        return {
          bar: [`${s.request.kind} ${s.request.threadId}`],
          body: [...s.request.lines, "", ...(s.request.options.length === 0 ? ["type your answer"] : s.request.options.map((o) => `[${o.key}] ${o.label}`))],
          hint: s.request.options.length === 0 ? "type answer, Enter sends  /b back" : "press a key  Enter thread  /b back",
          numbered: false,
        };
      case "reason":
        return { bar: [s.value === "text" ? "your answer" : "why deny?"], body: [], hint: "type it, Enter sends  /b back", numbered: false };
      case "projects":
        return {
          bar: ["new task 1/2"],
          body: (this.projects?.items ?? []).map((p) => p.name),
          hint: "number picks  /b back",
          numbered: true,
        };
      case "prompt":
        return {
          bar: ["new task 2/2"],
          body: [s.project.name, `${s.project.defaults.model} ${s.project.defaults.workspace} ${s.project.defaults.runtimeMode}`],
          hint: "type prompt, Enter starts /talk /b back",
          numbered: false,
        };
      case "voice":
        return { bar: ["transcript"], body: wrapHard(s.transcript, cols), hint: "Enter send  x discard  or retype", numbered: false };
    }
  }
}

function nonPrintable(value: unknown, path: string): string | undefined {
  if (typeof value === "string") return /[^\x20-\x7e]/.test(value) ? `${path || "message"}: ${JSON.stringify(value).slice(0, 60)}` : undefined;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = nonPrintable(item, `${path}[${i}]`);
      if (found !== undefined) return found;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const found = nonPrintable(item, path === "" ? key : `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function homeLine(row: Of<"home">["rows"][number], cols: number): string {
  const head = `${MARKERS[row.kind]} ${row.project} ${row.title}`;
  return `${head.padEnd(cols - 5)} ${row.age.padStart(4)}`;
}

function spread(left: string, right: string, cols: number): string {
  return `${left.slice(0, Math.max(0, cols - right.length - 1)).padEnd(cols - right.length)}${right}`;
}

function wrapHard(text: string, cols: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += cols) out.push(text.slice(at, at + cols));
  return out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
