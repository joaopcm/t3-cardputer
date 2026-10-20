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
  pollIntervalMs: positiveInt,
  authFailuresPerWindow: positiveInt,
  authWindowMs: positiveInt,
  mcpRequestTimeoutMs: positiveInt,
  mcpWaitGraceMs: positiveInt,
  mcpMaxPages: positiveInt,
});

export const configSchema = z.strictObject({
  port: positiveInt.max(65535),
  t3BaseUrl: z.url(),
  stateDir: z.string().min(1),
  whisper: z.strictObject({ binDir: z.string().min(1), model: z.string().min(1) }),
  canary: z.strictObject({ model: z.string().min(1) }),
  repair: z.strictObject({
    model: z.string().min(1),
    maxAttemptsPerVersion: positiveInt,
    githubRepo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name"),
    deployDir: z.string().min(1),
  }),
  limits: limitsSchema,
});

export type Limits = z.infer<typeof limitsSchema>;
export type RelayConfig = z.infer<typeof configSchema>;

const dataDir = join(homedir(), ".local", "share", "t3-cardputer");

export const DEFAULT_LIMITS: Limits = {
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (e), one poll (project list + a thread list per project, 8 projects) is ~80 ms serial, so 2000 ms is ~4% duty
  pollIntervalMs: 2000,
  // receipt: pending plan 2
  maxReplyPages: 32,
  // receipt: pending plan 2
  maxHomeRows: 50,
  // receipt: pending Task 11
  audioMaxSeconds: 60,
  // receipt: pending Task 11
  audioIdleTimeoutMs: 5000,
  // receipt: pending Task 8
  authFailuresPerWindow: 20,
  // receipt: pending Task 8
  authWindowMs: 10 * 60 * 1000,
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (e), slowest MCP call measured was 114 ms, so 30 s only trips on a hung server
  mcpRequestTimeoutMs: 30_000,
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (e), loopback round trip p95 was under 120 ms, so 10 s past the wait is a tripwire
  mcpWaitGraceMs: 10_000,
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (e), busiest project was 57 threads in 2 pages of 50, so 50 pages covers 2500 threads per project
  mcpMaxPages: 50,
};

export const DEFAULT_CONFIG: RelayConfig = {
  port: 8787,
  t3BaseUrl: "http://127.0.0.1:3773",
  stateDir: join(homedir(), ".local", "state", "t3-cardputer"),
  whisper: { binDir: join(dataDir, "whisper"), model: "small.en" },
  canary: { model: "claude-haiku-5-5" },
  repair: {
    model: "claude-opus-5-5",
    // receipt: pending Task 14
    maxAttemptsPerVersion: 3,
    githubRepo: "joaopcm/t3-cardputer",
    deployDir: join(dataDir, "deploy"),
  },
  limits: DEFAULT_LIMITS,
};

const configDir = join(homedir(), ".config", "t3-cardputer");

export const DEFAULT_CONFIG_PATH = join(configDir, "relay.json");
export const DEFAULT_SECRETS_PATH = join(configDir, "secrets.json");

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
