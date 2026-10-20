import { isIPv4, isIPv6 } from "node:net";

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
    readonly maxTrackedSources: number,
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

function ipv4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function ipv6Groups(address: string): number[] {
  const [head = "", tail] = address.split("::") as [string, string?];
  const parse = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [parseInt(group, 16)];
          const [a, b, c, d] = group.split(".").map(Number) as [number, number, number, number];
          return [(a << 8) | b, (c << 8) | d];
        });
  const headGroups = parse(head);
  if (tail === undefined) return headGroups;
  const tailGroups = parse(tail);
  return [...headGroups, ...new Array<number>(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups];
}

export function lockoutSourceKey(remoteAddress: string): string {
  const address = remoteAddress.split("%")[0]!;
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return remoteAddress;
  const groups = ipv6Groups(address);
  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isV4Mapped) return ipv4FromGroups(groups[6]!, groups[7]!);
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}
