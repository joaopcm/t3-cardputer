import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { T3Environment } from "./t3/environment.js";

const seenSchema = z.object({ serverVersion: z.string(), orchestrationProtocolVersion: z.number().int() });
type Seen = z.infer<typeof seenSchema>;

export type VersionChange = { changed: boolean; from?: string; to: string };

const label = (seen: Seen) => `${seen.serverVersion}+orch${seen.orchestrationProtocolVersion}`;

export class VersionWatch {
  constructor(
    private readonly getEnv: () => Promise<Pick<T3Environment, "serverVersion" | "orchestrationProtocolVersion">>,
    private readonly statePath: string,
  ) {}

  async check(): Promise<VersionChange> {
    const { serverVersion, orchestrationProtocolVersion } = await this.getEnv();
    const now: Seen = { serverVersion, orchestrationProtocolVersion };
    const previous = this.load();
    if (previous !== undefined && label(previous) === label(now)) return { changed: false, to: label(now) };
    this.persist(now);
    return previous === undefined ? { changed: true, to: label(now) } : { changed: true, from: label(previous), to: label(now) };
  }

  private load(): Seen | undefined {
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
    const result = seenSchema.safeParse(parsed);
    if (!result.success) throw new Error(`invalid T3 version state ${this.statePath}: ${result.error.message}, delete it to re-run the canary`);
    return result.data;
  }

  private persist(seen: Seen): void {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(seen, null, 2));
    renameSync(tmp, this.statePath);
  }
}

export type VersionLoopDeps = {
  watch: Pick<VersionWatch, "check">;
  intervalMs: number;
  blocked: () => string | undefined;
  onChange: (versions: { from?: string; to: string }) => Promise<void>;
};

export function startVersionLoop(deps: VersionLoopDeps): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastBlocked: string | undefined;

  const tick = async () => {
    const reason = deps.blocked();
    if (reason !== undefined) {
      if (reason !== lastBlocked) console.error(`canary skipped until fixed: ${reason}`);
      lastBlocked = reason;
      return;
    }
    lastBlocked = undefined;
    let change: VersionChange;
    try {
      change = await deps.watch.check();
    } catch (error) {
      console.error(`T3 version check failed: ${(error as Error).message}`, error);
      return;
    }
    if (!change.changed) return;
    const { changed: _changed, ...versions } = change;
    try {
      await deps.onChange(versions);
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
