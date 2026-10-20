import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import type { Limits, RelayConfig } from "../config.js";
import type { Stt } from "./types.js";

export type WhisperConfig = {
  whisper: RelayConfig["whisper"];
  limits: Pick<Limits, "whisperRestartsPerWindow" | "whisperRestartWindowMs" | "whisperStartTimeoutMs" | "whisperRequestTimeoutMs">;
  onSpawn?: (pid: number) => void;
};

export type WhisperStt = Required<Stt> & {
  readonly restarts: number;
  close(): Promise<void>;
};

const LISTEN_HOST = "127.0.0.1";
// receipt: docs/receipts/2026-10-20-whisper-cpu.md, model load is seconds, so a 100 ms poll adds at most 100 ms to the first transcript
const READY_POLL_MS = 100;
const NON_SPEECH_TAG = /\[[A-Z_ ]+\]/g;

export function createWhisperStt(cfg: WhisperConfig): WhisperStt {
  return new WhisperServer(cfg);
}

class WhisperServer implements WhisperStt {
  restarts = 0;
  private child: ChildProcess | undefined;
  private ready: Promise<void> = Promise.resolve();
  private readonly deaths: number[] = [];
  private failure: string | undefined;
  private closing = false;
  private readonly listeners = new Set<() => void>();
  private readonly baseUrl: string;

  constructor(private readonly cfg: WhisperConfig) {
    this.baseUrl = `http://${LISTEN_HOST}:${cfg.whisper.port}`;
    this.start();
  }

  warning(): string | undefined {
    return this.failure;
  }

  onWarningChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  async transcribe(wav: Buffer): Promise<string> {
    if (this.closing) throw new Error("whisper stt is closed");
    this.recoverIfWindowPassed();
    if (this.failure !== undefined) throw new Error(this.failure);
    try {
      await this.ready;
    } catch (error) {
      throw new Error(`whisper-server unavailable: ${(error as Error).message}`);
    }
    const { whisperRequestTimeoutMs } = this.cfg.limits;
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    body.set("response_format", "json");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/inference`, { method: "POST", body, signal: AbortSignal.timeout(whisperRequestTimeoutMs) });
    } catch (error) {
      if ((error as Error).name === "TimeoutError") {
        this.child?.kill("SIGKILL");
        throw new Error(`whisper-server did not answer: whisperRequestTimeoutMs=${whisperRequestTimeoutMs}, restarting it`);
      }
      throw new Error(`whisper-server request failed: ${(error as Error).message}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`whisper-server answered ${response.status}: ${text.slice(0, 80)}`);
    const parsed = JSON.parse(text) as { text?: string; error?: string };
    if (typeof parsed.text !== "string") throw new Error(`whisper-server returned no text: ${parsed.error ?? text.slice(0, 80)}`);
    return parsed.text.replace(NON_SPEECH_TAG, " ").replace(/\s+/g, " ").trim();
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }

  private start(): void {
    const { whisper } = this.cfg;
    const model = join(dirname(whisper.binDir), "models", `ggml-${whisper.model}.bin`);
    const child = spawn(
      join(whisper.binDir, "build", "bin", "whisper-server"),
      ["-m", model, "-t", String(whisper.threads), "-l", "en", "--host", LISTEN_HOST, "--port", String(whisper.port)],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    this.child = child;
    if (child.pid !== undefined) this.cfg.onSpawn?.(child.pid);
    let dead = false;
    const died = (cause: string) => {
      if (dead) return;
      dead = true;
      this.onDeath(cause);
    };
    child.once("error", (error) => died(`spawn failed: ${error.message}`));
    child.once("exit", (code, signal) => died(`exit code=${code} signal=${signal}`));
    this.ready = this.waitReady(child);
    this.ready.catch(() => {});
  }

  private async waitReady(child: ChildProcess): Promise<void> {
    const { whisperStartTimeoutMs } = this.cfg.limits;
    const deadline = Date.now() + whisperStartTimeoutMs;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    while (!exited()) {
      try {
        const response = await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(READY_POLL_MS) });
        if (response.ok) return;
      } catch {}
      if (Date.now() >= deadline) {
        child.kill("SIGKILL");
        throw new Error(`whisper-server was not ready: whisperStartTimeoutMs=${whisperStartTimeoutMs}, restarting it`);
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error("whisper-server exited before it was ready");
  }

  private onDeath(cause: string): void {
    if (this.closing) return;
    console.error(`whisper-server died (${cause})`);
    this.deaths.push(Date.now());
    this.pruneDeaths();
    const { whisperRestartsPerWindow } = this.cfg.limits;
    if (this.deaths.length > whisperRestartsPerWindow) {
      this.setFailure(this.crashLoopMessage());
      return;
    }
    this.restarts++;
    this.start();
  }

  private recoverIfWindowPassed(): void {
    if (this.failure === undefined) return;
    this.pruneDeaths();
    if (this.deaths.length > this.cfg.limits.whisperRestartsPerWindow) return;
    this.setFailure(undefined);
    this.restarts++;
    this.start();
  }

  private pruneDeaths(): void {
    const cutoff = Date.now() - this.cfg.limits.whisperRestartWindowMs;
    while (this.deaths.length > 0 && this.deaths[0]! <= cutoff) this.deaths.shift();
  }

  private crashLoopMessage(): string {
    const { whisperRestartsPerWindow, whisperRestartWindowMs } = this.cfg.limits;
    return `voice down: whisper-server died ${this.deaths.length} times, whisperRestartsPerWindow=${whisperRestartsPerWindow}, whisperRestartWindowMs=${whisperRestartWindowMs}, see relay log`;
  }

  private setFailure(failure: string | undefined): void {
    this.failure = failure;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("whisper warning listener threw", error);
      }
    }
  }
}
