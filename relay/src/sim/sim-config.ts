import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PAIR_BODY_BYTES_MAX } from "../protocol/messages.js";

export const DEFAULT_SIM_CONFIG_PATH = join(homedir(), ".config", "t3-cardputer", "sim.json");

const simConfigSchema = z.strictObject({ url: z.string().min(1), token: z.string().min(1) });
export type SimConfig = z.infer<typeof simConfigSchema>;

export function saveSimConfig(path: string, config: SimConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadSimConfig(path: string): SimConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no sim config at ${path}, pair first: sim pair <relay-url> <code> [name]`);
  }
  const parsed = simConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`bad sim config at ${path}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export async function pairDevice(baseUrl: string, code: string, name: string): Promise<string> {
  const body = JSON.stringify({ code, name });
  if (Buffer.byteLength(body) > PAIR_BODY_BYTES_MAX) {
    throw new Error(`pair body too large: pair_body_bytes_max=${PAIR_BODY_BYTES_MAX}, needed ${Buffer.byteLength(body)}`);
  }
  const response = await fetch(new URL("/v1/pair", httpBase(baseUrl)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const reply: unknown = await response.json().catch(() => ({}));
  if (response.status === 200) {
    const token = z.object({ token: z.string().min(1) }).safeParse(reply);
    if (token.success) return token.data.token;
    throw new Error("pairing returned 200 without a token");
  }
  const message = z.object({ error: z.string() }).safeParse(reply);
  throw new Error(`pairing failed (${response.status}): ${message.success ? message.data.error : "no error message"}`);
}

export function httpBase(url: string): string {
  return url.replace(/^ws(s?):/, "http$1:");
}

export function deviceSocketUrl(url: string, path: string): string {
  const base = new URL(url);
  base.protocol = base.protocol === "https:" || base.protocol === "wss:" ? "wss:" : "ws:";
  base.pathname = path;
  return base.toString();
}
