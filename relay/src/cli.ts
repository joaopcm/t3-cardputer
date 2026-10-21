#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AdminUnavailableError, adminRequest, type AdminReply, type AdminRequest } from "./admin.js";
import { pairT3Internal } from "./approvals/index.js";
import { DeviceAuth } from "./auth/devices.js";
import { runCanary, type CanaryDeps } from "./canary.js";
import { loadConfig, relayPathsFrom, type RelayConfig } from "./config.js";
import { INSTALL_SITE, installLink } from "./install-link.js";
import { readSecret, type SecretInput } from "./read-secret.js";
import { SecretsStore, type TokenRecord } from "./secrets.js";
import { ADMIN_SOCKET_NAME, VERSION_STATE_NAME, connectT3, startRelay } from "./serve.js";
import { main as simMain } from "./sim/main.js";
import { DEFAULT_SIM_CONFIG_PATH } from "./sim/sim-config.js";
import { getEnvironment } from "./t3/environment.js";
import { T3Mcp } from "./t3/mcp.js";
import { pairT3Mcp } from "./t3/mcp-oauth.js";
import { VersionWatch, verdictOf, type VersionCheck } from "./version-watch.js";
import { RELAY_VERSION } from "./version.js";

export type CliContext = {
  configPath: string;
  secretsPath: string;
  simConfigPath: string;
  stdin: SecretInput;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  waitForShutdown: () => Promise<void>;
  openCanary?: (config: RelayConfig, secrets: SecretsStore) => CanaryDeps & { close(): Promise<void> };
  openMcp?: (config: RelayConfig, secrets: SecretsStore) => Pick<T3Mcp, "listModels" | "close">;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
};

const USAGE = `usage: t3-cardputer-relay <command>
  --version                                  print the version
  serve                                      run the relay
  pair                                       print a device pairing code (relay must be running)
  install-link                               print an install link that carries a device pairing code (relay must be running)
  devices                                    list paired devices and locked-out sources (relay must be running)
  revoke <deviceId>                          remove a paired device
  pair-t3 --mcp <code> --internal <token>    store the T3 MCP and internal tokens
  pair-t3 --stdin                            same, reading {"mcp":"<code>","internal":"<code>"} from stdin
  renew                                      make fresh T3 tokens with the t3 CLI, or print how to
  update                                     download and run the latest setup.sh --update
  models [--json]                            list the T3 models this relay can launch
  secrets set github                         read the GitHub token from stdin and store it
  canary                                     run the live approvals canary against T3 (exit 0 pass, 1 fail)
  sim [pair <relay-url> <code>] [--wav f] [--url u]   drive the relay as a simulated device`;

class UsageError extends Error {
  override name = "UsageError";
}

type OptionSpec = Record<string, { type: "string" } | { type: "boolean" }>;
type OptionValues<T extends OptionSpec> = { [K in keyof T]?: T[K] extends { type: "boolean" } ? boolean : string };

function parse<T extends OptionSpec>(args: string[], options: T, positionals: number) {
  try {
    const { values, positionals: rest } = parseArgs({ args, options, allowPositionals: positionals > 0, strict: true });
    if (rest.length > positionals) throw new UsageError(`unexpected argument ${JSON.stringify(rest[positionals])}`);
    return { values: values as OptionValues<T>, rest };
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

async function createPairingCode(ctx: CliContext): Promise<{ code: string; expiresAt: string; minutes: number }> {
  const reply = await admin(ctx, { op: "pair" });
  if (!("code" in reply)) throw new Error("relay answered pair without a code");
  return { code: reply.code, expiresAt: reply.expiresAt, minutes: Math.round((Date.parse(reply.expiresAt) - Date.now()) / 60_000) };
}

async function pair(ctx: CliContext): Promise<number> {
  const { code, expiresAt, minutes } = await createPairingCode(ctx);
  ctx.stdout(`pairing code: ${code}`);
  ctx.stdout(`expires: ${expiresAt} (in ${minutes} min)`);
  return 0;
}

async function printInstallLink(ctx: CliContext, args: string[]): Promise<number> {
  parse(args, {}, 0);
  const { publicUrl } = loadConfig(ctx.configPath);
  if (publicUrl === undefined) throw new Error("install-link needs publicUrl in relay.json (setup.sh sets it), or set publicUrl to the URL `tailscale funnel status` shows");
  const { code, minutes } = await createPairingCode(ctx);
  ctx.stdout(installLink(publicUrl, code));
  ctx.stdout(`code expires in ${minutes} min`);
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
  if (!revoked.revoked) throw new UsageError(`unknown device id ${id}: run \`t3-cardputer-relay devices\` to list ids`);
  if (secretsOf(ctx).read().devices.some((device) => device.id === id)) {
    throw new Error(`revoke did not stick: device ${id} is still in ${ctx.secretsPath} (a concurrent write restored it), run revoke again`);
  }
  ctx.stdout(revoked.disconnected ? `revoked ${id}, connected device dropped` : `revoked ${id}`);
  return 0;
}

async function revokeVia(ctx: CliContext, id: string): Promise<{ revoked: boolean; disconnected: boolean }> {
  try {
    const reply = await admin(ctx, { op: "revoke", id });
    return "revoked" in reply ? reply : { revoked: false, disconnected: false };
  } catch (error) {
    if (!(error instanceof AdminUnavailableError)) throw error;
    return { revoked: new DeviceAuth(secretsOf(ctx), loadConfig(ctx.configPath).limits).revoke(id), disconnected: false };
  }
}

type PairingCodes = { mcp: string; internal: string };

const pairingCodesSchema = z.strictObject({ mcp: z.string().min(1), internal: z.string().min(1) });
const PAIR_STDIN_SHAPE = '{"mcp":"<code>","internal":"<code>"}';

async function pairT3(ctx: CliContext, args: string[]): Promise<number> {
  const { mcp, internal, stdin } = parse(args, { mcp: { type: "string" }, internal: { type: "string" }, stdin: { type: "boolean" } }, 0).values;
  if (stdin === true) {
    if (mcp !== undefined || internal !== undefined) throw new UsageError("pair-t3 takes --stdin or --mcp/--internal, not both");
    return pairBoth(ctx, await readPairingCodes(ctx));
  }
  if (mcp === undefined) throw new UsageError("pair-t3 needs --mcp <code>");
  if (internal === undefined) throw new UsageError("pair-t3 needs --internal <token>");
  return pairBoth(ctx, { mcp, internal });
}

async function readPairingCodes(ctx: CliContext): Promise<PairingCodes> {
  if (ctx.stdin.isTTY === true) ctx.stderr(`paste ${PAIR_STDIN_SHAPE} (input is hidden), then press enter`);
  const text = await readSecret(ctx.stdin);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = pairingCodesSchema.safeParse(json);
  if (!parsed.success) throw new UsageError(`pair-t3 --stdin needs ${PAIR_STDIN_SHAPE} on stdin`);
  return parsed.data;
}

async function pairBoth(ctx: CliContext, { mcp, internal }: PairingCodes): Promise<number> {
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

const T3_PAIRING_ARGS = ["auth", "pairing", "create", "--json", "--ttl", "5m", "--label", "t3-cardputer-relay"];
// receipt: pending, no t3 CLI on the host this was written on; the T3 server it calls answered every loopback request in under 120 ms (docs/receipts/2026-10-20-approvals-spike.md (e)), so 60 s only trips a hung CLI
const T3_CLI_TIMEOUT_MS = 60_000;
const pairingCreatedSchema = z.looseObject({ credential: z.string().min(1) });

function findOnPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

const T3_PAIRING_COMMAND = `t3 ${T3_PAIRING_ARGS.join(" ")}`;

function runT3PairingCreate(t3: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(t3, T3_PAIRING_ARGS, { timeout: T3_CLI_TIMEOUT_MS, killSignal: "SIGKILL", encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) return resolve(stdout);
      const why = error.killed ? `timed out: T3_CLI_TIMEOUT_MS=${T3_CLI_TIMEOUT_MS}` : `exit ${error.code ?? error.signal}`;
      reject(new Error(`t3 auth pairing create failed: ${why}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`));
    });
  });
}

async function createT3PairingCode(t3: string): Promise<string> {
  const printed = await runT3PairingCreate(t3);
  let json: unknown;
  try {
    json = JSON.parse(printed);
  } catch {
    json = undefined;
  }
  const parsed = pairingCreatedSchema.safeParse(json);
  if (!parsed.success) throw new Error(`renew: \`${T3_PAIRING_COMMAND}\` printed no JSON with a credential, is this the T3 CLI?`);
  return parsed.data.credential;
}

async function renew(ctx: CliContext, args: string[]): Promise<number> {
  parse(args, {}, 0);
  const t3 = findOnPath("t3", (ctx.env ?? process.env).PATH);
  if (t3 === undefined) {
    ctx.stdout("t3 is not on PATH here. run these two where T3 runs and take `credential` from each:");
    for (let i = 0; i < 2; i++) ctx.stdout(`  ${T3_PAIRING_COMMAND}`);
    ctx.stdout("then: t3-cardputer-relay pair-t3 --stdin");
    ctx.stdout('and paste {"mcp":"<credential 1>","internal":"<credential 2>"}');
    return 0;
  }
  const mcp = await createT3PairingCode(t3);
  const internal = await createT3PairingCode(t3);
  return pairBoth(ctx, { mcp, internal });
}

export const SETUP_URL = `${INSTALL_SITE}/setup.sh`;

function runInheritingStdio(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === null) reject(new Error(`${file} ${args.join(" ")} was killed by ${signal}`));
      else resolve(code);
    });
  });
}

async function update(ctx: CliContext, args: string[]): Promise<number> {
  parse(args, {}, 0);
  if (loadConfig(ctx.configPath).repair.projectId !== undefined) {
    ctx.stderr("this relay updates itself from main (self-repair), update skipped");
    return 1;
  }
  let response: Response;
  let script: string;
  try {
    response = await (ctx.fetch ?? fetch)(SETUP_URL, { redirect: "error" });
    script = response.ok ? await response.text() : "";
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new Error(`update: GET ${SETUP_URL} failed (${cause instanceof Error ? cause.message : String(cause)}), nothing ran. check your connection and try again`);
  }
  if (!response.ok) throw new Error(`update: GET ${SETUP_URL} answered HTTP ${response.status}, nothing ran. try again later`);
  if (!script.startsWith("#!")) throw new Error(`update: ${SETUP_URL} is not a shell script (no #! line), nothing ran. try again later`);
  const dir = mkdtempSync(join(tmpdir(), "t3-cardputer-update-"));
  try {
    const file = join(dir, "setup.sh");
    writeFileSync(file, script, { mode: 0o700 });
    ctx.stdout(`running setup.sh --update from ${SETUP_URL}`);
    return await runInheritingStdio("sh", [file, "--update"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function openMcp(config: RelayConfig, secrets: SecretsStore): T3Mcp {
  return new T3Mcp({ baseUrl: config.t3BaseUrl, secrets, limits: config.limits });
}

async function models(ctx: CliContext, args: string[]): Promise<number> {
  const { json } = parse(args, { json: { type: "boolean" } }, 0).values;
  const t3 = (ctx.openMcp ?? openMcp)(loadConfig(ctx.configPath), secretsOf(ctx));
  let catalog;
  try {
    catalog = await t3.listModels();
  } finally {
    await t3.close();
  }
  if (json === true) {
    ctx.stdout(JSON.stringify(catalog.map(({ id, label, providerInstanceId }) => ({ id, label, providerInstanceId }))));
    return 0;
  }
  if (catalog.length === 0) ctx.stdout("no usable models: every T3 provider instance has constraints, check T3's provider settings");
  for (const model of catalog) ctx.stdout(`${model.id}  ${model.label}  (${model.providerInstanceId})`);
  return 0;
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

async function canary(ctx: CliContext, args: string[]): Promise<number> {
  parse(args, {}, 0);
  const config = loadConfig(ctx.configPath);
  const watch = new VersionWatch(() => getEnvironment(config.t3BaseUrl), join(config.stateDir, VERSION_STATE_NAME));
  let check: VersionCheck | undefined;
  try {
    check = await watch.check();
  } catch (error) {
    ctx.stderr(`verdict not recorded, could not read T3's version: ${(error as Error).message}`);
  }
  const connection = (ctx.openCanary ?? connectT3)(config, secretsOf(ctx));
  let result;
  try {
    result = await runCanary(connection, { model: config.canary.model, providerInstanceId: config.canary.providerInstanceId, timeoutMs: config.limits.canaryTimeoutMs, pollIntervalMs: config.limits.pollIntervalMs });
  } finally {
    await connection.close();
  }
  const verdict = verdictOf(result);
  if (check !== undefined && verdict !== undefined) watch.record(check.current, verdict);
  if (result.ok) {
    ctx.stdout(`canary passed in ${result.ms} ms`);
    return 0;
  }
  ctx.stderr(`canary failed at ${result.stage} (${result.kind}): ${result.reason}`);
  return 1;
}

async function serve(ctx: CliContext, args: string[]): Promise<number> {
  parse(args, {}, 0);
  const relay = await startRelay(ctx);
  ctx.stdout(`relay ready on 127.0.0.1:${relay.port}`);
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
      case "--version":
        ctx.stdout(`t3-cardputer-relay ${RELAY_VERSION}`);
        return 0;
      case "serve":
        return await serve(ctx, args);
      case "pair":
        parse(args, {}, 0);
        return await pair(ctx);
      case "install-link":
        return await printInstallLink(ctx, args);
      case "devices":
        parse(args, {}, 0);
        return await devices(ctx);
      case "revoke":
        return await revoke(ctx, args);
      case "pair-t3":
        return await pairT3(ctx, args);
      case "renew":
        return await renew(ctx, args);
      case "update":
        return await update(ctx, args);
      case "models":
        return await models(ctx, args);
      case "secrets":
        return await secrets(ctx, args);
      case "canary":
        return await canary(ctx, args);
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
    ...relayPathsFrom(process.env),
    simConfigPath: DEFAULT_SIM_CONFIG_PATH,
    stdin: process.stdin,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    waitForShutdown: waitForSignal,
  }).then((code) => process.exit(code));
}
