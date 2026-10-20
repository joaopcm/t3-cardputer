import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/config.js";
import type { Secrets } from "../src/secrets.js";
import { getEnvironment } from "../src/t3/environment.js";
import { pairT3Mcp } from "../src/t3/mcp-oauth.js";
import { T3AuthError, T3Mcp, T3UnavailableError } from "../src/t3/mcp.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "t3", name), "utf8"));

type Call = { name: string; args: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => unknown;

function fakeMcp(handlers: Record<string, Handler>, overrides: Partial<typeof DEFAULT_LIMITS> = {}) {
  const calls: Call[] = [];
  const createTransport = async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "fake-t3", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
      const result = handler(args);
      if (result instanceof Error) return { isError: true, content: [{ type: "text", text: result.message }] };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
    });
    await server.connect(serverSide);
    return clientSide;
  };
  const secrets = { read: (): Secrets => ({ devices: [] }) };
  const mcp = new T3Mcp({ baseUrl: "http://127.0.0.1:1", secrets, limits: { ...DEFAULT_LIMITS, ...overrides }, createTransport });
  return { mcp, calls };
}

const thread = (id: string, updatedAt = "2026-10-20T13:00:00.000Z", status = "running") => ({
  threadId: id,
  title: `title ${id}`,
  status,
  updatedAt,
  createdAt: "2026-10-20T12:00:00.000Z",
  settled: false,
});

const servers: HttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function deadPort(): Promise<string> {
  const base = await listen(() => {});
  const server = servers.pop()!;
  await new Promise((resolve) => server.close(resolve));
  return base;
}

const validToken = { token: "tok", expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
const secretsWith = (t3McpToken?: { token: string; expiresAt: string }) => ({
  read: (): Secrets => (t3McpToken ? { devices: [], t3McpToken } : { devices: [] }),
});

describe("T3Mcp", () => {
  it("listProjects maps the project fixture", async () => {
    const { mcp } = fakeMcp({ t3_project_list: () => fixture("mcp-project-list.json").result });
    const projects = await mcp.listProjects();
    expect(projects).toHaveLength(8);
    expect(projects[0]).toEqual({ projectId: "<project-id-1>", name: "project-1", defaultModel: "claude-opus-5", defaultWorkspace: "worktree" });
  });

  it("listThreads follows nextCursor until null", async () => {
    const pages: Record<string, unknown> = {
      first: { projectId: "p1", threads: [thread("a"), thread("b")], nextCursor: 2 },
      second: { projectId: "p1", threads: [thread("c")], nextCursor: null },
    };
    const { mcp, calls } = fakeMcp({ t3_thread_list: (args) => (args.cursor === undefined ? pages.first : pages.second) });
    const threads = await mcp.listThreads("p1");
    expect(threads.map((t) => t.threadId)).toEqual(["a", "b", "c"]);
    expect(threads[0]).toEqual({ threadId: "a", projectId: "p1", title: "title a", status: "running", updatedAt: "2026-10-20T13:00:00.000Z" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toMatchObject({ projectId: "p1", settled: false, includeSubagents: false });
    expect(calls[1]?.args).toMatchObject({ projectId: "p1", settled: false, includeSubagents: false, cursor: 2 });
  });

  it("listThreads names the budget when the cursor never ends", async () => {
    const { mcp } = fakeMcp({ t3_thread_list: () => ({ projectId: "p1", threads: [thread("a")], nextCursor: 1 }) }, { mcpMaxPages: 3 });
    await expect(mcp.listThreads("p1")).rejects.toThrow(/mcpMaxPages=3/);
  });

  it("listRecentlyCompleted includes auto-settled completed threads and keeps those updated since", async () => {
    const since = Date.parse("2026-10-20T13:00:00.000Z");
    const { mcp, calls } = fakeMcp({
      t3_thread_list: (args) => ({
        projectId: "p1",
        threads: args.settled
          ? [thread("settled-new", "2026-10-20T13:02:00.000Z", "completed")]
          : [thread("new", "2026-10-20T13:05:00.000Z", "completed"), thread("old", "2026-10-20T12:00:00.000Z", "completed")],
        nextCursor: null,
      }),
    });
    const threads = await mcp.listRecentlyCompleted("p1", since);
    expect(threads.map((t) => t.threadId)).toEqual(["new", "settled-new"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toMatchObject({ projectId: "p1", statuses: ["completed"], settled: false, includeSubagents: false });
    expect(calls[1]?.args).toMatchObject({ projectId: "p1", statuses: ["completed"], settled: true, includeSubagents: false });
  });

  it("listRecentlyCompleted stops paging once a page ends before since", async () => {
    const since = Date.parse("2026-10-20T13:00:00.000Z");
    const { mcp, calls } = fakeMcp({
      t3_thread_list: (args) =>
        args.cursor === undefined
          ? { projectId: "p1", threads: [thread("new", "2026-10-20T13:05:00.000Z", "completed"), thread("old", "2026-10-20T12:00:00.000Z", "completed")], nextCursor: 2 }
          : { projectId: "p1", threads: [thread("older", "2026-10-19T12:00:00.000Z", "completed")], nextCursor: null },
    });
    const threads = await mcp.listRecentlyCompleted("p1", since);
    expect(threads.map((t) => t.threadId)).toEqual(["new"]);
    expect(calls.every((call) => call.args.cursor === undefined)).toBe(true);
  });

  it("send passes mode and clientRequestId through to t3_thread_send", async () => {
    const { mcp, calls } = fakeMcp({ t3_thread_send: () => ({ delivery: "queued" }) });
    await mcp.send("mcp:t1", "hello", "steer", "req-1");
    expect(calls).toEqual([{ name: "t3_thread_send", args: { threadId: "mcp:t1", message: "hello", mode: "steer", clientRequestId: "req-1" } }]);
  });

  it("latestAssistantMessage returns the last assistant message with the thread model", async () => {
    const { mcp, calls } = fakeMcp({ t3_thread_read: () => fixture("mcp-thread-read-messages.json").result });
    const message = await mcp.latestAssistantMessage("mcp:<thread-id-1>");
    expect(message).toEqual({
      text: "Created `t3-cardputer-canary.txt` in the working directory with `touch`. The command produced no output.",
      model: "claude-haiku-5-5",
      at: "2026-10-20T13:10:03.915Z",
    });
    expect(calls[0]?.args).toMatchObject({ threadId: "mcp:<thread-id-1>", view: "messages" });
  });

  it("latestAssistantMessage returns null for a thread with no assistant message", async () => {
    const read = fixture("mcp-thread-read-messages.json").result;
    read.items = read.items.filter((item: { type: string }) => item.type !== "assistant_message");
    const { mcp } = fakeMcp({ t3_thread_read: () => read });
    expect(await mcp.latestAssistantMessage("mcp:t1")).toBeNull();
  });

  it("latestAssistantMessage pages forward and reassembles truncated text", async () => {
    const base = fixture("mcp-thread-read-messages.json").result;
    const user = base.items[0];
    const assistant = { ...base.items[1], text: "part one, ", textTruncated: true, nextTextOffset: 10 };
    const { mcp, calls } = fakeMcp({
      t3_thread_read: (args) => {
        if (args.itemId) return { ...base, items: [{ ...assistant, text: "part two", textTruncated: false, nextTextOffset: null }], hasMore: false };
        if (args.afterPosition === undefined) return { ...base, items: [user], nextPosition: 1, hasMore: true };
        return { ...base, items: [assistant], nextPosition: 4, hasMore: false };
      },
    });
    const message = await mcp.latestAssistantMessage("mcp:t1");
    expect(message?.text).toBe("part one, part two");
    expect(calls.map((c) => c.args.afterPosition)).toEqual([undefined, 1, undefined]);
    expect(calls[2]?.args).toMatchObject({ itemId: assistant.itemId, textOffset: 10 });
  });

  it("launch builds a scratch thread with modelSelection and no workspaceStrategy", async () => {
    const { mcp, calls } = fakeMcp({ t3_thread_launch: () => ({ threadId: "mcp:new" }) });
    const result = await mcp.launch({ scratch: true, title: "t", message: "m", model: "claude-opus-5-5", workspace: "root", runtimeMode: "approval-required" });
    expect(result).toEqual({ threadId: "mcp:new" });
    expect(calls[0]?.args).toEqual({
      scratch: true,
      title: "t",
      message: "m",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "approval-required",
    });
  });

  it("launch maps worktree to workspaceStrategy with baseRef defaulting to main", async () => {
    const { mcp, calls } = fakeMcp({ t3_thread_launch: () => ({ threadId: "mcp:new" }) });
    await mcp.launch({ projectId: "p1", title: "t", message: "m", workspace: "worktree", branch: "feat/x" });
    await mcp.launch({ projectId: "p1", title: "t", message: "m", workspace: "worktree", branch: "feat/y", baseRef: "develop" });
    await mcp.launch({ projectId: "p1", title: "t", message: "m", workspace: "root" });
    expect(calls[0]?.args).toEqual({ projectId: "p1", title: "t", message: "m", workspaceStrategy: { type: "worktree", baseRef: "main", branch: "feat/x" } });
    expect(calls[1]?.args.workspaceStrategy).toEqual({ type: "worktree", baseRef: "develop", branch: "feat/y" });
    expect(calls[2]?.args.workspaceStrategy).toEqual({ type: "root" });
  });

  it("launch rejects input with neither or both of projectId and scratch", async () => {
    const { mcp } = fakeMcp({});
    await expect(mcp.launch({ title: "t", message: "m", workspace: "root" })).rejects.toThrow(/projectId or scratch/);
    await expect(mcp.launch({ projectId: "p", scratch: true, title: "t", message: "m", workspace: "root" })).rejects.toThrow(/projectId or scratch/);
  });

  it("settleThread settles then archives through t3_thread_organize", async () => {
    const { mcp, calls } = fakeMcp({ t3_thread_organize: () => ({ ok: true }) });
    await mcp.settleThread("mcp:t1");
    expect(calls).toEqual([
      { name: "t3_thread_organize", args: { threadId: "mcp:t1", action: "settle" } },
      { name: "t3_thread_organize", args: { threadId: "mcp:t1", action: "archive" } },
    ]);
  });

  it("listQuestions reads every pending request from the question fixture", async () => {
    const fx = fixture("mcp-pending-question.json");
    const { mcp, calls } = fakeMcp({ t3_pending_request_list: () => fx.list.result, t3_pending_request_read: () => fx.read.result });
    const questions = await mcp.listQuestions("mcp:<thread-id-1>");
    expect(questions).toEqual([
      {
        requestId: fx.read.result.requestId,
        questionId: "Red or blue?",
        prompt: "Red or blue?",
        multiSelect: false,
        options: [
          { label: "Red", value: "Red" },
          { label: "Blue", value: "Blue" },
        ],
      },
    ]);
    expect(calls.map((c) => c.name)).toEqual(["t3_pending_request_list", "t3_pending_request_read"]);
  });

  it("answerQuestion sends the answers map", async () => {
    const { mcp, calls } = fakeMcp({ t3_pending_request_respond: () => ({ sequence: 1 }) });
    await mcp.answerQuestion("mcp:t1", "rid", { "Red or blue?": "Blue" });
    expect(calls).toEqual([{ name: "t3_pending_request_respond", args: { threadId: "mcp:t1", requestId: "rid", answers: { "Red or blue?": "Blue" } } }]);
  });

  it("waitForRun returns status and timedOut", async () => {
    const { mcp, calls } = fakeMcp({ t3_thread_wait: () => ({ status: "completed", timedOut: false }) });
    expect(await mcp.waitForRun("mcp:t1", 5000)).toEqual({ status: "completed", timedOut: false });
    expect(calls[0]?.args).toEqual({ threadId: "mcp:t1", timeoutMs: 5000 });
  });

  it("surfaces a tool error with the tool name", async () => {
    const { mcp } = fakeMcp({ t3_thread_send: () => new Error("capability_denied: read-only") });
    await expect(mcp.send("mcp:t1", "x", "queue", "r")).rejects.toThrow(/t3_thread_send.*capability_denied/);
  });

  it("401 from MCP throws T3AuthError(\"mcp\")", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_token" }));
    });
    const mcp = new T3Mcp({ baseUrl: base, secrets: secretsWith(validToken), limits: DEFAULT_LIMITS });
    const error = await mcp.listProjects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(T3AuthError);
    expect((error as T3AuthError).kind).toBe("mcp");
  });

  it("sends the stored token as a bearer", async () => {
    let seen: string | undefined;
    const base = await listen((req, res) => {
      seen = req.headers.authorization;
      res.writeHead(401).end();
    });
    const mcp = new T3Mcp({ baseUrl: base, secrets: secretsWith(validToken), limits: DEFAULT_LIMITS });
    await mcp.listProjects().catch(() => {});
    expect(seen).toBe("Bearer tok");
  });

  it("missing or expired token throws T3AuthError(\"mcp\") without calling T3", async () => {
    const base = await listen((_req, res) => res.writeHead(500).end());
    const expired = { token: "tok", expiresAt: "2020-01-01T00:00:00.000Z" };
    for (const secrets of [secretsWith(), secretsWith(expired)]) {
      const mcp = new T3Mcp({ baseUrl: base, secrets, limits: DEFAULT_LIMITS });
      await expect(mcp.listProjects()).rejects.toBeInstanceOf(T3AuthError);
    }
  });

  it("ECONNREFUSED throws T3UnavailableError", async () => {
    const base = await deadPort();
    const mcp = new T3Mcp({ baseUrl: base, secrets: secretsWith(validToken), limits: DEFAULT_LIMITS });
    await expect(mcp.listProjects()).rejects.toBeInstanceOf(T3UnavailableError);
  });
});

describe("getEnvironment", () => {
  it("parses environment.json fixture", async () => {
    const fx = fixture("environment.json");
    let url: string | undefined;
    const base = await listen((req, res) => {
      url = req.url;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(fx));
    });
    const env = await getEnvironment(base);
    expect(url).toBe("/.well-known/t3/environment");
    expect(env.serverVersion).toBe("0.1.0");
    expect(env.orchestrationProtocolVersion).toBe(2);
    expect(env.capabilities.threadSettlement).toBe(true);
  });

  it("ECONNREFUSED throws T3UnavailableError", async () => {
    await expect(getEnvironment(await deadPort())).rejects.toBeInstanceOf(T3UnavailableError);
  });

  it("names the missing field when the body is not an environment", async () => {
    const base = await listen((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    await expect(getEnvironment(base)).rejects.toThrow(/serverVersion/);
  });
});

describe("pairT3Mcp", () => {
  it("runs register, decision, token and returns a token record", async () => {
    const seen: string[] = [];
    let decisionBody: { authorization: Record<string, string>; decision: Record<string, string> } | undefined;
    const base = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push(`${req.method} ${req.url}`);
        res.setHeader("content-type", "application/json");
        if (req.url === "/oauth/mcp/register") return void res.writeHead(201).end(JSON.stringify({ client_id: "cid" }));
        if (req.url === "/oauth/mcp/decision") {
          decisionBody = JSON.parse(body);
          const { redirect_uri, state } = decisionBody!.authorization;
          return void res.writeHead(200).end(JSON.stringify({ redirectTo: `${redirect_uri}?code=abc&state=${state}` }));
        }
        const form = new URLSearchParams(body);
        expect(form.get("code")).toBe("abc");
        expect(form.get("client_id")).toBe("cid");
        expect(form.get("code_verifier")).toBeTruthy();
        res.writeHead(200).end(JSON.stringify({ access_token: "mcp-token", token_type: "Bearer", expires_in: 2592000, scope: "x" }));
      });
    });
    const before = Date.now();
    const record = await pairT3Mcp(base, "CODE12345678");
    expect(seen).toEqual(["POST /oauth/mcp/register", "POST /oauth/mcp/decision", "POST /oauth/mcp/token"]);
    expect(decisionBody?.decision).toEqual({ _tag: "pairing-code", access: "full-access", code: "CODE12345678" });
    expect(decisionBody?.authorization).toMatchObject({ response_type: "code", client_id: "cid", code_challenge_method: "S256", resource: `${base}/mcp` });
    expect(record.token).toBe("mcp-token");
    expect(Date.parse(record.expiresAt) - before).toBeGreaterThan(2592000 * 1000 - 5000);
  });

  it("names the step and status when the pairing code is refused", async () => {
    const base = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/oauth/mcp/register") return void res.writeHead(201).end(JSON.stringify({ client_id: "cid" }));
      req.resume();
      res.writeHead(400).end(JSON.stringify({ error: "invalid_pairing_code" }));
    });
    await expect(pairT3Mcp(base, "bad")).rejects.toThrow(/oauth\/mcp\/decision.*400.*invalid_pairing_code/);
  });
});
