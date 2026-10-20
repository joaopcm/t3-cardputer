// receipt: 10_000 sources x 20 failures held 6.79 MB heap (ungced upper bound), far past any single-user homelab and still cheap
export const MAX_TRACKED_SOURCES = 10_000;

export type LockoutReason = "too_many_failures" | "source_cap";

export interface LockoutDecision {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: LockoutReason;
}

export class Lockout {
  private readonly failures = new Map<string, number[]>();
  private lastSweepAt = Date.now();
  private nextEvictionAt = 0;

  constructor(
    readonly limitPerWindow: number,
    readonly windowMs: number,
    readonly maxTrackedSources: number = MAX_TRACKED_SOURCES,
  ) {}

  check(source: string): LockoutDecision {
    const now = Date.now();
    const times = this.live(source, now);
    if (times) {
      if (times.length < this.limitPerWindow) return { allowed: true };
      return { allowed: false, reason: "too_many_failures", retryAfterMs: times[0]! + this.windowMs - now };
    }
    if (this.failures.size < this.maxTrackedSources) return { allowed: true };
    this.sweepIfEvictable(now);
    if (this.failures.size < this.maxTrackedSources) return { allowed: true };
    return { allowed: false, reason: "source_cap", retryAfterMs: this.nextEvictionAt - now };
  }

  recordFailure(source: string): void {
    const now = Date.now();
    if (now - this.lastSweepAt >= this.windowMs) this.sweep(now);
    const times = this.live(source, now);
    if (times) {
      if (times.length < this.limitPerWindow) times.push(now);
      return;
    }
    if (this.failures.size >= this.maxTrackedSources) this.sweepIfEvictable(now);
    if (this.failures.size >= this.maxTrackedSources) return;
    this.failures.set(source, [now]);
  }

  get trackedSources(): number {
    return this.failures.size;
  }

  private live(source: string, now: number): number[] | undefined {
    const times = this.failures.get(source);
    if (!times) return undefined;
    const cutoff = now - this.windowMs;
    const firstLive = times.findIndex((t) => t > cutoff);
    if (firstLive === -1) {
      this.failures.delete(source);
      return undefined;
    }
    if (firstLive > 0) times.splice(0, firstLive);
    return times;
  }

  private sweepIfEvictable(now: number): void {
    if (now >= this.nextEvictionAt) this.sweep(now);
  }

  private sweep(now: number): void {
    this.lastSweepAt = now;
    let soonest = Infinity;
    for (const source of [...this.failures.keys()]) {
      const times = this.live(source, now);
      if (times) soonest = Math.min(soonest, times[times.length - 1]! + this.windowMs);
    }
    this.nextEvictionAt = soonest;
  }
}
