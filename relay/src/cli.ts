#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AdminUnavailableError, adminRequest, type AdminReply, type AdminRequest } from "./admin.js";
import { pairT3Internal } from "./approvals/index.js";
import { DeviceAuth } from "./auth/devices.js";
import { DEFAULT_CONFIG_PATH, DEFAULT_SECRETS_PATH, loadConfig } from "./config.js";
import { readSecret, type SecretInput } from "./read-secret.js";
import { SecretsStore, type TokenRecord } from "./secrets.js";
import { ADMIN_SOCKET_NAME, startRelay } from "./serve.js";
import { main as simMain } from "./sim/main.js";
import { DEFAULT_SIM_CONFIG_PATH } from "./sim/sim-config.js";
import { pairT3Mcp } from "./t3/mcp-oauth.js";

export type CliContext = {
  configPath: string;
  secretsPath: string;
  simConfigPath: string;
  stdin: SecretInput;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  waitForShutdown: () => Promise<void>;
};

const USAGE = `usage: t3-cardputer-relay <command>
  serve                                      run the relay
  pair                                       print a device pairing code (relay must be running)
  devices                                    list paired devices and locked-out sources (relay must be running)
  revoke <deviceId>                          remove a paired device
  pair-t3 --mcp <code> --internal <token>    store the T3 MCP and internal tokens
  secrets set github                         read the GitHub token from stdin and store it
  sim [pair <relay-url> <code>] [--wav f] [--url u]   drive the relay as a simulated device`;

class UsageError extends Error {
  override name = "UsageError";
}

function parse<T extends Record<string, { type: "string" }>>(args: string[], options: T, positionals: number) {
  try {
    const { values, positionals: rest } = parseArgs({ args, options, allowPositionals: positionals > 0, strict: true });
    if (rest.length > positionals) throw new UsageError(`unexpected argument ${JSON.stringify(rest[positionals])}`);
    return { values: values as { [K in keyof T]?: string }, rest };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError((error as Error).message);
  }
}

function secretsOf(ctx: CliContext): SecretsStore {
  return new SecretsStore(ctx.secretsPath);
}

async function admin(ctx: CliContext, request: AdminRequest): Promise<AdminReply> {
  const config = loadConfig(ctx.configPath);
  const reply = await adminRequest(join(config.stateDir, ADMIN_SOCKET_NAME), request, config.limits.adminRequestTimeoutMs);
  if (!reply.ok) throw new Error(`relay refused ${request.op}: ${reply.error}`);
  return reply;
}

async function pair(ctx: CliContext): Promise<number> {
  const reply = await admin(ctx, { op: "pair" });
  if (!("code" in reply)) throw new Error("relay answered pair without a code");
  const minutes = Math.round((Date.parse(reply.expiresAt) - Date.now()) / 60_000);
  ctx.stdout(`pairing code: ${reply.code}`);
  ctx.stdout(`expires: ${reply.expiresAt} (in ${minutes} min)`);
  return 0;
}

async function devices(ctx: CliContext): Promise<number> {
  const reply = await admin(ctx, { op: "devices" });
  if (!("devices" in reply)) throw new Error("relay answered devices without a list");
  if (reply.devices.length === 0) ctx.stdout("no devices paired");
  for (const device of reply.devices) ctx.stdout(`${device.id}  ${device.name}  last seen ${device.lastSeenAt ?? "never"}`);
  if (reply.lockouts.length === 0) ctx.stdout("lockouts: none");
  for (const lockout of reply.lockouts) ctx.stdout(`lockout: ${lockout.source} locked out, retry in ${Math.ceil(lockout.retryAfterMs / 1000)}s`);
  return 0;
}

async function revoke(ctx: CliContext, args: string[]): Promise<number> {
  const [id] = parse(args, {}, 1).rest;
  if (id === undefined) throw new UsageError("revoke needs <deviceId>");
  const revoked = await revokeVia(ctx, id);
  if (!revoked) throw new UsageError(`unknown device id ${id}: run \`t3-cardputer-relay devices\` to list ids`);
  if (secretsOf(ctx).read().devices.some((device) => device.id === id)) {
    throw new Error(`revoke did not stick: device ${id} is still in ${ctx.secretsPath} (a concurrent write restored it), run revoke again`);
  }
  ctx.stdout(`revoked ${id}`);
  return 0;
}

async function revokeVia(ctx: CliContext, id: string): Promise<boolean> {
  try {
    const reply = await admin(ctx, { op: "revoke", id });
    return "revoked" in reply && reply.revoked;
  } catch (error) {
    if (!(error instanceof AdminUnavailableError)) throw error;
    return new DeviceAuth(secretsOf(ctx), loadConfig(ctx.configPath).limits).revoke(id);
  }
}

async function pairT3(ctx: CliContext, args: string[]): Promise<number> {
  const { mcp, internal } = parse(args, { mcp: { type: "string" }, internal: { type: "string" } }, 0).values;
  if (mcp === undefined) throw new UsageError("pair-t3 needs --mcp <code>");
  if (internal === undefined) throw new UsageError("pair-t3 needs --internal <token>");
  const { t3BaseUrl } = loadConfig(ctx.configPath);
  const attempts = [
    { name: "mcp", key: "t3McpToken", pair: () => pairT3Mcp(t3BaseUrl, mcp) },
    { name: "internal", key: "t3InternalToken", pair: () => pairT3Internal(t3BaseUrl, internal) },
  ] as const;
  const stored: Partial<Record<(typeof attempts)[number]["key"], TokenRecord>> = {};
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      stored[attempt.key] = await attempt.pair();
    } catch (error) {
      failures.push(`pair-t3 ${attempt.name} failed: ${(error as Error).message}`);
    }
  }
  const store = secretsOf(ctx);
  if (Object.keys(stored).length > 0) store.write({ ...store.read(), ...stored });
  for (const attempt of attempts) {
    const record = stored[attempt.key];
    if (record) ctx.stdout(`${attempt.name} token stored, expires ${record.expiresAt}`);
  }
  for (const failure of failures) ctx.stderr(failure);
  return failures.length === 0 ? 0 : 1;
}

async function secrets(ctx: CliContext, args: string[]): Promise<number> {
  const [verb, name] = parse(args, {}, 2).rest;
  if (verb !== "set") throw new UsageError("secrets needs `set github`");
  if (name !== "github") throw new UsageError(`secrets set knows only github, not ${JSON.stringify(name)}`);
  if (ctx.stdin.isTTY === true) ctx.stderr("paste the GitHub token (input is hidden), then press enter");
  const token = await readSecret(ctx.stdin);
  if (token === "") throw new UsageError("secrets set github: stdin was empty, pipe the token in");
  const store = secretsOf(ctx);
  store.write({ ...store.read(), githubToken: token });
  ctx.stdout("github token stored");
  return 0;
}

async function serve(ctx: CliContext, args: string[]): Promise<number> {
  parse(args, {}, 0);
  const relay = await startRelay(ctx);
  ctx.stdout(`relay listening on 127.0.0.1:${relay.port}`);
  await ctx.waitForShutdown();
  await relay.close();
  return 0;
}

export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "--help":
      case "-h":
      case "help":
        ctx.stdout(USAGE);
        return 0;
      case "serve":
        return await serve(ctx, args);
      case "pair":
        parse(args, {}, 0);
        return await pair(ctx);
      case "devices":
        parse(args, {}, 0);
        return await devices(ctx);
      case "revoke":
        return await revoke(ctx, args);
      case "pair-t3":
        return await pairT3(ctx, args);
      case "secrets":
        return await secrets(ctx, args);
      case "sim":
        return await simMain(args[0] === "pair" ? args : ["run", ...args], ctx.simConfigPath);
      case undefined:
        throw new UsageError("missing command");
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.stderr(`${error.message}\n${USAGE}`);
      return 2;
    }
    ctx.stderr((error as Error).message);
    return 1;
  }
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2), {
    configPath: DEFAULT_CONFIG_PATH,
    secretsPath: DEFAULT_SECRETS_PATH,
    simConfigPath: DEFAULT_SIM_CONFIG_PATH,
    stdin: process.stdin,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    waitForShutdown: waitForSignal,
  }).then((code) => process.exit(code));
}
