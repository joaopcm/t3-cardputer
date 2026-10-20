import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminRequest, startAdminServer } from "../src/admin.js";
import { DeviceAuth } from "../src/auth/devices.js";
import { runCli, type CliContext } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { SecretsStore } from "../src/secrets.js";
import { relayEnvironment } from "./helpers/relay-env.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Env = Awaited<ReturnType<typeof relayEnvironment>>;

async function setup(extra: Partial<CliContext> = {}) {
  const env = await relayEnvironment();
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    configPath: env.configPath,
    secretsPath: env.secretsPath,
    simConfigPath: join(env.root, "sim.json"),
    stdin: new PassThrough(),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    waitForShutdown: () => new Promise(() => {}),
    ...extra,
  };
  const run = (...argv: string[]) => runCli(argv, ctx);
  return { env, ctx, run, out: () => out.join("\n"), err: () => err.join("\n") };
}

async function startAdmin(env: Env) {
  const auth = new DeviceAuth(new SecretsStore(env.secretsPath), loadConfig(env.configPath).limits);
  const admin = await startAdminServer({ socketPath: env.socketPath, auth });
  cleanups.push(() => admin.close());
  return auth;
}

function withConfig(env: Env, patch: Record<string, unknown>) {
  const current = JSON.parse(readFileSync(env.configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(env.configPath, JSON.stringify({ ...current, ...patch }));
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function t3Stub(opts: { mcpRefuses?: boolean } = {}) {
  return listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.setHeader("content-type", "application/json");
      if (req.url === "/oauth/mcp/register") return void res.writeHead(201).end(JSON.stringify({ client_id: "cid" }));
      if (req.url === "/oauth/mcp/decision") {
        if (opts.mcpRefuses) return void res.writeHead(400).end(JSON.stringify({ error: "invalid_pairing_code" }));
        const { authorization } = JSON.parse(body) as { authorization: { redirect_uri: string; state: string } };
        return void res.writeHead(200).end(JSON.stringify({ redirectTo: `${authorization.redirect_uri}?code=abc&state=${authorization.state}` }));
      }
      if (req.url === "/oauth/mcp/token") return void res.writeHead(200).end(JSON.stringify({ access_token: "mcp-secret-token", expires_in: 2592000 }));
      if (req.url === "/oauth/token") return void res.writeHead(200).end(JSON.stringify({ access_token: "internal-secret-token", expires_in: 604800 }));
      res.writeHead(404).end("{}");
    });
  });
}

describe("usage", () => {
  it("--help lists the commands and exits 0", async () => {
    const { run, out } = await setup();
    expect(await run("--help")).toBe(0);
    for (const command of ["serve", "pair", "devices", "revoke", "pair-t3", "secrets set github", "sim"]) expect(out()).toContain(command);
  });

  it("no command exits 2", async () => {
    const { run, err } = await setup();
    expect(await run()).toBe(2);
    expect(err()).toContain("usage:");
  });

  it("unknown command exits 2 naming it", async () => {
    const { run, err } = await setup();
    expect(await run("frobnicate")).toBe(2);
    expect(err()).toContain("frobnicate");
  });

  it("unknown option exits 2 naming it", async () => {
    const { run, err } = await setup();
    expect(await run("pair", "--bogus")).toBe(2);
    expect(err()).toContain("--bogus");
  });
});

describe("pair and devices", () => {
  it("pair prints an 8-char code", async () => {
    const { env, run, out } = await setup();
    const auth = await startAdmin(env);
    expect(await run("pair")).toBe(0);
    const code = out().match(/\b([2-9A-HJKMNP-Z]{8})\b/)?.[1];
    expect(code).toBeDefined();
    expect(out()).toMatch(/expires/);
    expect(auth.redeem(code!, "adv", "1.2.3.4").token).toBeTruthy();
  });

  it("pair and devices say the relay is not running when the socket is absent", async () => {
    const { run, err } = await setup();
    for (const command of ["pair", "devices"]) {
      expect(await run(command)).toBe(1);
    }
    expect(err().split("\n").filter((line) => line.includes("relay not running: start it with `t3-cardputer-relay serve`"))).toHaveLength(2);
  });

  it("devices lists id, name, last seen and lockouts", async () => {
    const { env, run, out } = await setup();
    const auth = await startAdmin(env);
    const { deviceId, token } = auth.redeem(auth.createPairingCode().code, "adv", "1.1.1.1");
    auth.verify(token, "1.1.1.1");
    const { authFailuresPerWindow } = loadConfig(env.configPath).limits;
    for (let i = 0; i < authFailuresPerWindow; i++) auth.verify("bad", "9.9.9.9");
    expect(await run("devices")).toBe(0);
    expect(out()).toContain(deviceId);
    expect(out()).toContain("adv");
    expect(out()).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(out()).toMatch(/9\.9\.9\.9.*retry in \d+s/);
    expect(out()).not.toContain(token);
  });

  it("devices with nothing paired and nobody locked out says so", async () => {
    const { env, run, out } = await setup();
    await startAdmin(env);
    expect(await run("devices")).toBe(0);
    expect(out()).toContain("no devices");
    expect(out()).toContain("lockouts: none");
  });
});

describe("revoke", () => {
  it("revoke unknown id exits 2 naming the id", async () => {
    const { run, err } = await setup();
    expect(await run("revoke", "no-such-device")).toBe(2);
    expect(err()).toContain("no-such-device");
  });

  it("revoke without an id exits 2 naming the argument", async () => {
    const { run, err } = await setup();
    expect(await run("revoke")).toBe(2);
    expect(err()).toContain("<deviceId>");
  });

  it("revokes through the running relay and confirms it is gone", async () => {
    const { env, run, out } = await setup();
    const auth = await startAdmin(env);
    const { deviceId } = auth.redeem(auth.createPairingCode().code, "adv", "1.1.1.1");
    expect(await run("revoke", deviceId)).toBe(0);
    expect(out()).toContain(deviceId);
    expect(new SecretsStore(env.secretsPath).read().devices).toEqual([]);
  });

  it("revokes straight from the secrets file when the relay is down", async () => {
    const { env, run } = await setup();
    const store = new SecretsStore(env.secretsPath);
    const auth = new DeviceAuth(store, loadConfig(env.configPath).limits);
    const keep = auth.redeem(auth.createPairingCode().code, "keep", "1.1.1.1").deviceId;
    const drop = auth.redeem(auth.createPairingCode().code, "drop", "1.1.1.1").deviceId;
    expect(await run("revoke", drop)).toBe(0);
    expect(store.read().devices.map((d) => d.id)).toEqual([keep]);
  });

  it("exits 1 when a concurrent write put the device back", async () => {
    const { env, run, err } = await setup();
    const store = new SecretsStore(env.secretsPath);
    const auth = new DeviceAuth(store, loadConfig(env.configPath).limits);
    const { deviceId } = auth.redeem(auth.createPairingCode().code, "adv", "1.1.1.1");
    const write = SecretsStore.prototype.write;
    vi.spyOn(SecretsStore.prototype, "write").mockImplementation(function (this: SecretsStore, secrets) {
      write.call(this, { ...secrets, devices: store.read().devices });
    });
    expect(await run("revoke", deviceId)).toBe(1);
    expect(err()).toContain(deviceId);
    expect(err()).toContain("still");
  });
});

describe("pair-t3", () => {
  it("pair-t3 stores tokens in secrets with 0600", async () => {
    const { env, run, out } = await setup();
    withConfig(env, { t3BaseUrl: await t3Stub() });
    const auth = new DeviceAuth(new SecretsStore(env.secretsPath), loadConfig(env.configPath).limits);
    const { deviceId } = auth.redeem(auth.createPairingCode().code, "adv", "1.1.1.1");
    expect(await run("pair-t3", "--mcp", "MCPCODE", "--internal", "bootstrap-token")).toBe(0);
    expect(statSync(env.secretsPath).mode & 0o777).toBe(0o600);
    const secrets = new SecretsStore(env.secretsPath).read();
    expect(secrets.t3McpToken?.token).toBe("mcp-secret-token");
    expect(secrets.t3InternalToken?.token).toBe("internal-secret-token");
    expect(secrets.devices.map((d) => d.id)).toEqual([deviceId]);
    expect(out()).toContain(secrets.t3McpToken!.expiresAt);
    expect(out()).toContain(secrets.t3InternalToken!.expiresAt);
    expect(out()).not.toContain("secret-token");
    expect(out()).not.toContain("bootstrap-token");
  });

  it("names the missing argument and exits 2", async () => {
    const { run, err } = await setup();
    expect(await run("pair-t3", "--mcp", "X")).toBe(2);
    expect(err()).toContain("--internal");
    expect(await run("pair-t3", "--internal", "X")).toBe(2);
    expect(err()).toContain("--mcp");
  });

  it("keeps the token that worked and exits 1 naming the one that failed", async () => {
    const { env, run, err } = await setup();
    withConfig(env, { t3BaseUrl: await t3Stub({ mcpRefuses: true }) });
    expect(await run("pair-t3", "--mcp", "BAD", "--internal", "bootstrap-token")).toBe(1);
    expect(err()).toMatch(/mcp.*invalid_pairing_code/);
    const secrets = new SecretsStore(env.secretsPath).read();
    expect(secrets.t3McpToken).toBeUndefined();
    expect(secrets.t3InternalToken?.token).toBe("internal-secret-token");
  });

  it("exits 1 saying T3 is unreachable when nothing listens", async () => {
    const { run, err } = await setup();
    expect(await run("pair-t3", "--mcp", "X", "--internal", "Y")).toBe(1);
    expect(err()).toContain("T3 unreachable");
  });
});

describe("secrets set github", () => {
  it("reads the token from stdin and stores it 0600 without printing it", async () => {
    const stdin = new PassThrough();
    const { env, run, out, err } = await setup({ stdin });
    stdin.end("ghp_example_token\n");
    expect(await run("secrets", "set", "github")).toBe(0);
    expect(statSync(env.secretsPath).mode & 0o777).toBe(0o600);
    expect(new SecretsStore(env.secretsPath).read().githubToken).toBe("ghp_example_token");
    expect(out() + err()).not.toContain("ghp_example_token");
  });

  it("keeps existing devices and tokens", async () => {
    const stdin = new PassThrough();
    const { env, run } = await setup({ stdin });
    const store = new SecretsStore(env.secretsPath);
    store.write({ devices: [{ id: "d", name: "n", tokenSha256: "00", createdAt: "x" }], t3McpToken: { token: "t", expiresAt: "e" } });
    stdin.end("tok\n");
    expect(await run("secrets", "set", "github")).toBe(0);
    expect(store.read()).toMatchObject({ githubToken: "tok", t3McpToken: { token: "t" }, devices: [{ id: "d" }] });
  });

  it("exits 2 when stdin is empty", async () => {
    const stdin = new PassThrough();
    const { run, err } = await setup({ stdin });
    stdin.end("  \n");
    expect(await run("secrets", "set", "github")).toBe(2);
    expect(err()).toContain("stdin");
  });

  it("does not echo keystrokes on a terminal and reads until enter", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const { env, run, out, err } = await setup({ stdin });
    const done = run("secrets", "set", "github");
    await vi.waitFor(() => expect(stdin.setRawMode).toHaveBeenCalledWith(true));
    stdin.write("ghp_ab");
    stdin.write("\u007fc");
    stdin.write("\r");
    expect(await done).toBe(0);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(new SecretsStore(env.secretsPath).read().githubToken).toBe("ghp_ac");
    expect(out() + err()).not.toContain("ghp_a");
  });

  it("only knows `set github`", async () => {
    const { run, err } = await setup();
    expect(await run("secrets", "set", "gitlab")).toBe(2);
    expect(err()).toContain("gitlab");
    expect(await run("secrets")).toBe(2);
  });
});

describe("serve", () => {
  it("starts the relay, prints the port, and stops it when told to shut down", async () => {
    let shutdown!: () => void;
    const { env, run, out } = await setup({ waitForShutdown: () => new Promise<void>((resolve) => (shutdown = resolve)) });
    const done = run("serve");
    await vi.waitFor(() => expect(out()).toContain(String(env.port)));
    expect(statSync(env.socketPath).isSocket()).toBe(true);
    shutdown();
    expect(await done).toBe(0);
    expect(() => statSync(env.socketPath)).toThrow();
  });

  it("exits 1 naming the config problem", async () => {
    const { env, run, err } = await setup();
    writeFileSync(env.configPath, JSON.stringify({ port: 0 }));
    expect(await run("serve")).toBe(1);
    expect(err()).toContain("invalid config");
  });
});

describe("sim", () => {
  it("pairs the sim against the relay and saves its config 0600", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let shutdown!: () => void;
    const { env, run, ctx } = await setup({ waitForShutdown: () => new Promise<void>((resolve) => (shutdown = resolve)) });
    const serving = run("serve");
    cleanups.push(async () => {
      shutdown();
      await serving;
    });
    await vi.waitFor(() => expect(statSync(env.socketPath).isSocket()).toBe(true));
    const reply = await adminRequest(env.socketPath, { op: "pair" }, 2000);
    if (!("code" in reply)) throw new Error(JSON.stringify(reply));
    expect(await run("sim", "pair", `http://127.0.0.1:${env.port}`, reply.code)).toBe(0);
    expect(statSync(ctx.simConfigPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(ctx.simConfigPath, "utf8"))).toMatchObject({ url: `http://127.0.0.1:${env.port}` });
  });

  it("exits 1 telling the user to pair when there is no sim config", async () => {
    const { run, err, ctx } = await setup();
    expect(await run("sim")).toBe(1);
    expect(err()).toContain(ctx.simConfigPath);
    expect(err()).toContain("pair");
  });

  it("exits 2 when --wav or --url has no value", async () => {
    const { run } = await setup();
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run("sim", "--wav")).toBe(2);
    expect(await run("sim", "--url")).toBe(2);
    expect(printed.mock.calls.map(([text]) => String(text).split("\n")[0])).toEqual(["--wav needs a value", "--url needs a value"]);
  });
});
