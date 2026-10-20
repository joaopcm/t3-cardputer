import { AdapterBrokenError, type ApprovalsAdapter, type PendingApproval } from "./approvals/index.js";
import { T3AuthError, T3UnavailableError, type T3Mcp, type T3Project, type T3Question, type T3ThreadSummary } from "./t3/mcp.js";
import { DONE_WINDOW_MS, RUNNING_STATUSES } from "./views/home.js";

export const T3_AUTH_WARNING = "T3 token rejected: run `t3-cardputer-relay pair-t3` on homelab";

export type WatcherT3 = Pick<T3Mcp, "listProjects" | "listThreads" | "listRecentlyCompleted" | "listQuestions">;

export type AdapterHealth = { state: "ok" | "idle" | "unauthorized" } | { state: "broken" | "unreachable"; reason: string };

export type WatchSnapshot = {
  t3: "ok" | "unreachable";
  projects: T3Project[];
  threads: (T3ThreadSummary & { project: string })[];
  approvals: PendingApproval[];
  questions: Map<string, T3Question[]>;
  warnings: string[];
  adapter: AdapterHealth;
};

export const EMPTY_SNAPSHOT: WatchSnapshot = { t3: "ok", projects: [], threads: [], approvals: [], questions: new Map(), warnings: [], adapter: { state: "idle" } };

export class Watcher {
  private readonly listeners = new Set<(snapshot: WatchSnapshot) => void>();
  private waiters: ((snapshot: WatchSnapshot) => void)[] = [];
  private readonly recentlyDone = new Map<string, T3ThreadSummary>();
  private latest: WatchSnapshot | undefined;
  private backfilled = false;
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private unreachable: string | undefined;

  constructor(
    private readonly t3: WatcherT3,
    private readonly approvals: Pick<ApprovalsAdapter, "listPending">,
    private readonly intervalMs: number,
  ) {}

  onChange(cb: (snapshot: WatchSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.running) return;
    const generation = ++this.generation;
    const tick = async () => {
      try {
        const snapshot = await this.poll();
        if (generation !== this.generation) return;
        this.latest = snapshot;
        this.flushWaiters(snapshot);
        for (const listener of this.listeners) {
          try {
            listener(snapshot);
          } catch (error) {
            console.error("watcher: a snapshot listener threw, polling continues", error);
          }
        }
      } finally {
        if (generation === this.generation) this.timer = setTimeout(tick, this.intervalMs);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
    this.backfilled = false;
    this.recentlyDone.clear();
    this.flushWaiters({ ...EMPTY_SNAPSHOT, t3: "unreachable" });
  }

  current(): Promise<WatchSnapshot> {
    if (this.latest) return Promise.resolve(this.latest);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private flushWaiters(snapshot: WatchSnapshot): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(snapshot);
  }

  private async poll(): Promise<WatchSnapshot> {
    const last = this.latest ?? EMPTY_SNAPSHOT;
    try {
      const snapshot = await this.read();
      if (this.unreachable !== undefined) console.log(`watcher: T3 reachable again after: ${this.unreachable}`);
      this.unreachable = undefined;
      return snapshot;
    } catch (error) {
      if (error instanceof T3UnavailableError) {
        if (error.message !== this.unreachable) console.error(`watcher: ${error.message}`);
        this.unreachable = error.message;
        return { ...last, t3: "unreachable", warnings: error.httpStatus === undefined ? [] : [error.message] };
      }
      if (error instanceof T3AuthError) return { ...last, t3: "unreachable", warnings: [T3_AUTH_WARNING] };
      console.error("watcher: T3 poll failed", error);
      return { ...last, warnings: [`T3 poll failed: ${(error as Error).message}`] };
    }
  }

  private async read(): Promise<WatchSnapshot> {
    const projects = await this.t3.listProjects();
    const listed = (await Promise.all(projects.map((p) => this.t3.listThreads(p.projectId)))).flat();
    if (!this.backfilled) {
      const since = Date.now() - DONE_WINDOW_MS;
      for (const thread of (await Promise.all(projects.map((p) => this.t3.listRecentlyCompleted(p.projectId, since)))).flat()) {
        this.recentlyDone.set(thread.threadId, thread);
      }
      this.backfilled = true;
    }
    const threads = this.withRecentlyDone(listed);

    const running = threads.filter((t) => RUNNING_STATUSES.has(t.status)).map((t) => t.threadId);
    const questions = new Map(await Promise.all(running.map(async (id) => [id, await this.t3.listQuestions(id)] as const)));
    const { approvals, adapter, warnings } = await this.readApprovals(running);

    const names = new Map(projects.map((p) => [p.projectId, p.name]));
    return {
      t3: "ok",
      projects,
      threads: threads.map((t) => ({ ...t, project: names.get(t.projectId) ?? t.projectId })),
      approvals,
      questions,
      warnings,
      adapter,
    };
  }

  private withRecentlyDone(listed: T3ThreadSummary[]): T3ThreadSummary[] {
    const cutoff = Date.now() - DONE_WINDOW_MS;
    for (const thread of listed) if (thread.status === "completed") this.recentlyDone.set(thread.threadId, thread);
    const listedIds = new Set(listed.map((t) => t.threadId));
    const vanished: T3ThreadSummary[] = [];
    for (const [id, thread] of this.recentlyDone) {
      if (Date.parse(thread.updatedAt) < cutoff) this.recentlyDone.delete(id);
      else if (!listedIds.has(id)) vanished.push(thread);
    }
    return [...listed, ...vanished];
  }

  private async readApprovals(threadIds: string[]): Promise<Pick<WatchSnapshot, "approvals" | "adapter" | "warnings">> {
    if (threadIds.length === 0) return { approvals: [], adapter: { state: "idle" }, warnings: [] };
    try {
      return { approvals: await this.approvals.listPending(threadIds), adapter: { state: "ok" }, warnings: [] };
    } catch (error) {
      if (error instanceof AdapterBrokenError) return { approvals: [], adapter: { state: "broken", reason: error.reason }, warnings: [] };
      if (error instanceof T3UnavailableError) return { approvals: [], adapter: { state: "unreachable", reason: error.message }, warnings: [] };
      if (error instanceof T3AuthError) return { approvals: [], adapter: { state: "unauthorized" }, warnings: [T3_AUTH_WARNING] };
      throw error;
    }
  }
}
