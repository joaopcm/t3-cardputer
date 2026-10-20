import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const positiveInt = z.number().int().positive();

export const limitsSchema = z.strictObject({
  maxReplyPages: positiveInt,
  maxHomeRows: positiveInt,
  audioMaxSeconds: positiveInt,
  audioIdleTimeoutMs: positiveInt,
  whisperRestartsPerWindow: positiveInt,
  whisperRestartWindowMs: positiveInt,
  whisperStartTimeoutMs: positiveInt,
  whisperRequestTimeoutMs: positiveInt,
  pollIntervalMs: positiveInt,
  authFailuresPerWindow: positiveInt,
  authWindowMs: positiveInt,
  authMaxTrackedSources: positiveInt,
  pairingCodeTtlMs: positiveInt,
  adminRequestTimeoutMs: positiveInt,
  mcpRequestTimeoutMs: positiveInt,
  mcpWaitGraceMs: positiveInt,
  mcpMaxPages: positiveInt,
  approvalsRpcTimeoutMs: positiveInt,
  helloTimeoutMs: positiveInt,
  idempotencyTtlMs: positiveInt,
  idempotencyMaxEntries: positiveInt,
  heartbeatIntervalMs: positiveInt,
  heartbeatMaxMissed: positiveInt,
  canaryTimeoutMs: positiveInt,
  canaryRetryMaxMs: positiveInt,
  repairPollIntervalMs: positiveInt,
  repairAttemptTimeoutMs: positiveInt,
  repairStepTimeoutMs: positiveInt,
});

export const configSchema = z.strictObject({
  port: positiveInt.max(65535),
  t3BaseUrl: z.url(),
  stateDir: z.string().min(1),
  whisper: z.strictObject({ binDir: z.string().min(1), model: z.string().min(1), port: positiveInt.max(65535), threads: positiveInt }),
  canary: z.strictObject({ model: z.string().min(1) }),
  repair: z.strictObject({
    model: z.string().min(1),
    maxAttemptsPerVersion: positiveInt,
    githubRepo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name"),
    deployDir: z.string().min(1),
    projectId: z.string().min(1).optional(),
  }),
  limits: limitsSchema,
});

export type Limits = z.infer<typeof limitsSchema>;
export type RelayConfig = z.infer<typeof configSchema>;

const dataDir = join(homedir(), ".local", "share", "t3-cardputer");

export const DEFAULT_LIMITS: Limits = {
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (e), one poll (project list + a thread list per project, 8 projects) is ~80 ms serial on T3, so 2000 ms is ~4% duty; the relay's own side measured 1.41 ms CPU per poll (Task 9, receipt-sized 73.7 KB list, 3 running threads, fake MCP in-process)
  pollIntervalMs: 2000,
  // receipt: pending plan 2
  maxReplyPages: 32,
  // receipt: pending plan 2
  maxHomeRows: 50,
  // receipt: docs/receipts/2026-10-20-whisper-cpu.md, the spec's 5-30 s prompts x4; a full 120 s clip transcribed in 61-65 s on medium.en and holds 3.84 MB
  audioMaxSeconds: 120,
  // receipt: pending plan 2, the measured hotspot jitter decides it
  audioIdleTimeoutMs: 5000,
  // receipt: docs/receipts/2026-10-20-whisper-cpu.md, whisper-server died 0 times in 59 requests over 17 starts, so 3 restarts in the window only trips a crash loop
  whisperRestartsPerWindow: 3,
  // receipt: sized with whisperRestartsPerWindow, 10 min lets a one-off crash age out while a loop that dies in under a second trips in that second
  whisperRestartWindowMs: 10 * 60 * 1000,
  // receipt: docs/receipts/2026-10-20-whisper-cpu.md, model load measured 0.4 to 1.8 s with the file cached, so 60 s is ~33x the slowest and only trips a hung load
  whisperStartTimeoutMs: 60_000,
  // receipt: docs/receipts/2026-10-20-whisper-cpu.md, the longest allowed recording (120 s) took 65.1 s worst on medium.en, so 260 s is 4x that
  whisperRequestTimeoutMs: 260_000,
  // receipt: a healthy device produces 0 auth failures, so 20 per source only trips a revoked device retrying on backoff or a stranger guessing; the 31^8 (~8.5e11) code space makes 20 per 10 min per source hopeless
  authFailuresPerWindow: 20,
  // receipt: sized with authFailuresPerWindow, a 10 min window holds a revoked device's backoff retries to a throttle, backoff cadence pending plan 2
  authWindowMs: 10 * 60 * 1000,
  // receipt: 10_000 sources x 20 failures held 6.79 MB heap (no gc, upper bound), far past any single-user homelab and still cheap
  authMaxTrackedSources: 10_000,
  // receipt: pending plan 2 — time to type the code on the ADV keyboard
  pairingCodeTtlMs: 10 * 60 * 1000,
  // receipt: 200 pair + 200 devices + 50 revoke (50 paired devices) over the admin socket took 0.22-0.26 ms p50 and 3.5 ms worst, so 5 s only trips a hung relay
  adminRequestTimeoutMs: 5000,
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (e), slowest MCP call measured was 114 ms, so 30 s only trips on a hung server
  mcpRequestTimeoutMs: 30_000,
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (e), loopback round trip p95 was under 120 ms, so 10 s past the wait is a tripwire
  mcpWaitGraceMs: 10_000,
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (e), busiest project was 57 threads in 2 pages of 50, so 50 pages covers 2500 threads per project
  mcpMaxPages: 50,
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (b), respond answered in 7-17 ms and the snapshot in 7 ms, so 10 s only trips on a hung or changed server
  approvalsRpcTimeoutMs: 10_000,
  // receipt: pending Task 13; a healthy device writes hello right after the upgrade, one round trip through Funnel, so 10 s only trips a stalled or idle socket
  helloTimeoutMs: 10_000,
  // receipt: a device retries an unacked id on its next connection, which can be the next wake after a night asleep, so 24 h covers it
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  // receipt: 10_000 entries held 6.69 MB heap measured with 120-char errors on every ack (upper bound), far past a day of one person's replies
  idempotencyMaxEntries: 10_000,
  // receipt: pending plan 2 (ADV over a phone hotspot); a ping is ~2 bytes each way, and 30 s finds a dead device well inside the minutes a carrier NAT keeps an idle mapping
  heartbeatIntervalMs: 30_000,
  // receipt: pending plan 2; one lost pong on a lossy hotspot is normal, two in a row (60 s silent) is a dead or half-open socket
  heartbeatMaxMissed: 2,
  // receipt: docs/receipts/2026-10-20-canary.md, 4 live runs took 5.6-6.4 s, so 5x the slowest (6433 ms) is 32165 ms and only trips a broken or hung run
  canaryTimeoutMs: 32_165,
  // receipt: docs/receipts/2026-10-20-canary.md, a canary is one 5.6-6.4 s Haiku turn, so backing off from the 20 s version check to 1 h caps a persistent no-verdict failure (revoked token, T3 down) at 24 turns a day after the first few
  canaryRetryMaxMs: 3_600_000,
  // receipt: CI's steps took 1.5 s install + 0.8 s typecheck + 2.6 s test locally (Task 14), runner start pending Task 15; one PR poll is one GraphQL call against GitHub's 5000/h user budget, so 120/h is 2.4%
  repairPollIntervalMs: 30_000,
  // receipt: pending first real repair run; one Opus turn plus CI plus a staging canary, 2 h only trips a stuck thread, and the next attempt starts fresh
  repairAttemptTimeoutMs: 2 * 60 * 60 * 1000,
  // receipt: Task 14 measured pnpm install --frozen-lockfile 0.76-1.47 s (cold store 1.44 s), pnpm build 0.66 s, cli start 0.2 s; gh and git fetch against GitHub pending Task 15; 60 s is 40x the slowest
  repairStepTimeoutMs: 60_000,
};

export const DEFAULT_CONFIG: RelayConfig = {
  port: 8787,
  t3BaseUrl: "http://127.0.0.1:3773",
  stateDir: join(homedir(), ".local", "state", "t3-cardputer"),
  // receipt: docs/receipts/2026-10-20-whisper-cpu.md, threads=8 matches the 8 physical cores and beat 4 (1.7x slower) and 16 (1.07x slower)
  whisper: { binDir: join(dataDir, "whisper"), model: "medium.en", port: 8788, threads: 8 },
  canary: { model: "claude-haiku-5-5" },
  repair: {
    model: "claude-opus-5-5",
    // receipt: pending first real repair run
    maxAttemptsPerVersion: 3,
    githubRepo: "joaopcm/t3-cardputer",
    deployDir: join(dataDir, "deploy"),
  },
  limits: DEFAULT_LIMITS,
};

const configDir = join(homedir(), ".config", "t3-cardputer");

export const DEFAULT_CONFIG_PATH = join(configDir, "relay.json");
export const DEFAULT_SECRETS_PATH = join(configDir, "secrets.json");
export const CONFIG_PATH_ENV = "T3_CARDPUTER_RELAY_CONFIG";
export const SECRETS_PATH_ENV = "T3_CARDPUTER_RELAY_SECRETS";

export function relayPathsFrom(env: NodeJS.ProcessEnv): { configPath: string; secretsPath: string } {
  return { configPath: env[CONFIG_PATH_ENV] || DEFAULT_CONFIG_PATH, secretsPath: env[SECRETS_PATH_ENV] || DEFAULT_SECRETS_PATH };
}

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlain(current) && isPlain(value) ? merge(current, value) : value;
  }
  return out;
}

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isPlain(node)) return undefined;
    node = node[key as string];
  }
  return node;
}

function describeIssues(error: z.ZodError, merged: unknown): string {
  return error.issues
    .flatMap((issue) => {
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => `${[...issue.path, key].join(".")}: unknown key`);
      }
      const key = issue.path.join(".") || "(root)";
      return [`${key}: invalid value ${JSON.stringify(valueAt(merged, issue.path))} (${issue.message})`];
    })
    .join("; ");
}

function readConfigFile(path: string): Plain | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid config ${path}: not valid JSON (${(error as Error).message})`);
  }
  if (!isPlain(parsed)) throw new Error(`invalid config ${path}: top level must be a JSON object`);
  return parsed;
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): RelayConfig {
  const fromFile = readConfigFile(path);
  const merged = fromFile ? merge(DEFAULT_CONFIG, fromFile) : DEFAULT_CONFIG;
  const result = configSchema.safeParse(merged);
  if (!result.success) throw new Error(`invalid config ${path}: ${describeIssues(result.error, merged)}`);
  return result.data;
}
