import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.T3_BASE_URL ?? "http://127.0.0.1:3773";
const T3_BIN = process.env.T3_BIN ?? join(homedir(), ".t3/runtime/versions/0.1.0/t3");
const OUT = process.env.SPIKE_OUT ?? "/tmp/t3-spike/out";
const LABEL = "t3-cardputer-spike";
const SECRETS = join(OUT, "secrets.json");
const CREATED = join(OUT, "created-threads.jsonl");

const CANARY_MODEL = { instanceId: "claudeAgent", model: "claude-haiku-5-5", options: [{ id: "effort", value: "low" }] };
const REPAIR_MODEL = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

type Access = "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";
type Json = any;

mkdirSync(OUT, { recursive: true, mode: 0o700 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const writeOut = (name: string, data: unknown) =>
  writeFileSync(join(OUT, name), typeof data === "string" ? data : JSON.stringify(data, null, 2), { mode: 0o600 });

const mintPairingCode = (label: string): string =>
  JSON.parse(
    execFileSync(T3_BIN, ["auth", "pairing", "create", "--json", "--ttl", "5m", "--label", label], { encoding: "utf8" }),
  ).credential;

const exchangeInternalToken = async (): Promise<string> => {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: mintPairingCode(`${LABEL}-internal`),
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_device_type: "bot",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`/oauth/token ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
};

const mcpOAuth = async (access: Access): Promise<{ token: string; trace: Json[] }> => {
  const trace: Json[] = [];
  const redirectUri = "http://127.0.0.1:53682/callback";
  const reg = await fetch(`${BASE}/oauth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: `${LABEL}-mcp-${access}`, redirect_uris: [redirectUri] }),
  });
  const client = await reg.json();
  trace.push({ step: "POST /oauth/mcp/register", status: reg.status, responseKeys: Object.keys(client) });
  const verifier = randomBytes(32).toString("base64url");
  const authorization = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(8).toString("base64url"),
    resource: `${BASE}/mcp`,
  };
  const authorize = await fetch(`${BASE}/oauth/mcp/authorize?${new URLSearchParams(authorization)}`, { redirect: "manual" });
  trace.push({ step: "GET /oauth/mcp/authorize", status: authorize.status, location: authorize.headers.get("location")?.split("?")[0] });
  const decision = await fetch(`${BASE}/oauth/mcp/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorization, decision: { _tag: "pairing-code", access, code: mintPairingCode(`${LABEL}-mcp-${access}`) } }),
  });
  const decisionBody = await decision.json();
  if (!decisionBody.redirectTo) throw new Error(`/oauth/mcp/decision ${decision.status} ${JSON.stringify(decisionBody)}`);
  const redirect = new URL(decisionBody.redirectTo);
  trace.push({ step: "POST /oauth/mcp/decision", status: decision.status, redirectParams: [...redirect.searchParams.keys()] });
  const token = await fetch(`${BASE}/oauth/mcp/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code")!,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  const tokenBody = await token.json();
  if (!token.ok) throw new Error(`/oauth/mcp/token ${token.status} ${JSON.stringify(tokenBody)}`);
  trace.push({
    step: "POST /oauth/mcp/token",
    status: token.status,
    responseKeys: Object.keys(tokenBody),
    token_type: tokenBody.token_type,
    expires_in: tokenBody.expires_in,
    scope: tokenBody.scope,
  });
  return { token: tokenBody.access_token, trace };
};

const secrets = async (): Promise<{ internal: string; mcp: Partial<Record<Access, string>> }> => {
  if (existsSync(SECRETS)) return JSON.parse(readFileSync(SECRETS, "utf8"));
  const fresh = { internal: await exchangeInternalToken(), mcp: {} };
  writeFileSync(SECRETS, JSON.stringify(fresh), { mode: 0o600 });
  return fresh;
};

const mcpToken = async (access: Access): Promise<string> => {
  const s = await secrets();
  if (s.mcp[access]) return s.mcp[access]!;
  const { token, trace } = await mcpOAuth(access);
  writeOut(`oauth-trace-${access}.json`, trace);
  s.mcp[access] = token;
  writeFileSync(SECRETS, JSON.stringify(s), { mode: 0o600 });
  return token;
};

type McpCall = { status: number; ms: number; bytes: number; isError: boolean; result: Json; error?: Json };

const mcpClient = async (token: string) => {
  let sessionId: string | undefined;
  let nextId = 1;
  const post = async (body: Json) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const started = performance.now();
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    const text = await res.text();
    const ms = performance.now() - started;
    let json: Json;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      json = data.length ? JSON.parse(data.at(-1)!) : undefined;
    } else json = text ? JSON.parse(text) : undefined;
    return { status: res.status, ms, bytes: Buffer.byteLength(text), json };
  };
  await post({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: LABEL, version: "0.0.0" } },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const call = async (name: string, args: Json): Promise<McpCall> => {
    const r = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
    const result = r.json?.result;
    const text = result?.content?.find((c: Json) => c.type === "text")?.text;
    let parsed: Json = result?.structuredContent;
    if (parsed === undefined && text !== undefined) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: r.status, ms: r.ms, bytes: r.bytes, isError: !!(result?.isError || r.json?.error), result: parsed, error: r.json?.error };
  };
  return { call };
};

type Frame = { at: number; dir: "in" | "out"; msg: Json };

const internalWs = async (bearer: string, framesFile: string) => {
  const ticketRes = await fetch(`${BASE}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
  const { ticket } = await ticketRes.json();
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e: Json) => reject(new Error(`ws error ${e?.message ?? ""}`));
  });
  const t0 = Date.now();
  const record = (dir: "in" | "out", msg: Json) => {
    const frame: Frame = { at: Date.now() - t0, dir, msg };
    appendFileSync(framesFile, `${JSON.stringify(frame)}\n`, { mode: 0o600 });
  };
  const send = (msg: Json) => {
    record("out", msg);
    ws.send(JSON.stringify(msg));
  };
  let nextId = 1;
  const exits = new Map<string, (exit: Json) => void>();
  const chunkListeners = new Map<string, (values: Json[]) => void>();
  ws.onmessage = (e: MessageEvent) => {
    const decoded = JSON.parse(String(e.data));
    for (const msg of Array.isArray(decoded) ? decoded : [decoded]) {
      record("in", msg);
      if (msg._tag === "Chunk") {
        send({ _tag: "Ack", requestId: msg.requestId });
        chunkListeners.get(String(msg.requestId))?.(msg.values);
      } else if (msg._tag === "Exit") {
        exits.get(String(msg.requestId))?.(msg.exit);
      }
    }
  };
  const request = (tag: string, payload: Json, onChunk?: (values: Json[]) => void) => {
    const id = String(nextId++);
    if (onChunk) chunkListeners.set(id, onChunk);
    const exit = new Promise<Json>((resolve) => exits.set(id, resolve));
    send({ _tag: "Request", id, tag, payload, headers: [] });
    return { id, exit };
  };
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && send({ _tag: "Ping" }), 10_000);
  const close = () => {
    clearInterval(ping);
    ws.close();
  };
  const interrupt = (requestId: string) => send({ _tag: "Interrupt", requestId });
  return { request, interrupt, close };
};

const findPendingRequests = (values: Json[]): Json[] => {
  const found: Json[] = [];
  const walk = (v: Json) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      if (typeof v.id === "string" && v.responseCapability && v.status === "pending" && v.kind) found.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(values);
  return found;
};

const recordCreated = (threadId: string, purpose: string) =>
  appendFileSync(CREATED, `${JSON.stringify({ threadId, purpose, at: new Date().toISOString() })}\n`, { mode: 0o600 });

const launchScratch = async (mcp: Awaited<ReturnType<typeof mcpClient>>, args: Json, purpose: string) => {
  const launched = await mcp.call("t3_thread_launch", { scratch: true, ...args });
  const threadId = launched.result?.threadId ?? launched.result?.thread?.threadId ?? JSON.stringify(launched.result ?? "").match(/"threadId":"([^"]+)"/)?.[1];
  writeOut(`launch-${purpose.replace(/\W+/g, "-")}.json`, launched);
  if (threadId) recordCreated(threadId, purpose);
  return { launched, threadId: threadId as string | undefined };
};

const settleAndArchive = async (mcp: Awaited<ReturnType<typeof mcpClient>>, threadId: string) => ({
  settle: await mcp.call("t3_thread_organize", { threadId, action: "settle" }),
  archive: await mcp.call("t3_thread_organize", { threadId, action: "archive" }),
});

type Scenario = { name: string; message: string; decision: string; extra?: Json; followUp?: string };

const SCENARIOS: Scenario[] = [
  { name: "approve", message: "Run the shell command `touch t3-cardputer-canary.txt` and nothing else.", decision: "accept" },
  { name: "deny", message: "Run the shell command `touch t3-cardputer-canary.txt` and nothing else.", decision: "decline" },
  {
    name: "deny-reason",
    message: "Run the shell command `touch t3-cardputer-canary.txt` and nothing else.",
    decision: "decline",
    extra: { reason: "spike: denied on purpose, do not retry" },
    followUp: "I denied that on purpose: do not retry it. Reply with the single word OK.",
  },
  {
    name: "always",
    message: "Run the shell command `touch t3-cardputer-canary.txt`, then run that exact same command a second time. Nothing else.",
    decision: "acceptForSession",
  },
  { name: "accept-always", message: "Run the shell command `touch t3-cardputer-canary.txt` and nothing else.", decision: "acceptAlways" },
];

const approvals = async (only?: string) => {
  const s = await secrets();
  const mcp = await mcpClient(await mcpToken("approval-required"));
  const summary: Json[] = [];
  for (const scenario of SCENARIOS.filter((x) => !only || x.name === only)) {
    const title = `t3-cardputer canary (${scenario.name})`;
    const framesFile = join(OUT, `ws-${scenario.name}.jsonl`);
    rmSync(framesFile, { force: true });
    const result: Json = { scenario: scenario.name, title, mcp: {}, responses: [] };
    const { launched, threadId } = await launchScratch(
      mcp,
      { title, message: scenario.message, runtimeMode: "approval-required", modelSelection: CANARY_MODEL },
      `approval ${scenario.name}`,
    );
    result.launch = launched;
    const projectId = launched.result?.projectId;
    if (!threadId) {
      summary.push(result);
      continue;
    }
    const ws = await internalWs(s.internal, framesFile);
    const answered = new Set<string>();
    const pending: Json[] = [];
    let notify: () => void = () => {};
    const sub = ws.request("orchestration.subscribeThread", { threadId }, (values) => {
      for (const req of findPendingRequests(values)) {
        if (!answered.has(req.id) && !pending.some((p) => p.id === req.id)) pending.push(req);
      }
      notify();
    });
    const statusTimeline: Json[] = [];
    const deadline = Date.now() + 180_000;
    let completed = false;
    while (Date.now() < deadline && !completed) {
      if (pending.length === 0) {
        await Promise.race([new Promise<void>((r) => (notify = r)), sleep(1000)]);
        const list = await mcp.call("t3_thread_list", { projectId, titleContains: title, limit: 5 });
        const mine = list.result?.threads?.find((t: Json) => t.threadId === threadId) ?? list.result;
        statusTimeline.push({ at: Date.now(), status: mine?.status ?? mine?.state ?? null });
        if (["completed", "failed", "cancelled", "interrupted"].includes(mine?.status)) completed = true;
        continue;
      }
      const req = pending.shift()!;
      answered.add(req.id);
      const index = answered.size;
      const seenAt = Date.now();
      let mcpStatus: string | undefined;
      while (Date.now() - seenAt < 15_000) {
        const list = await mcp.call("t3_thread_list", { projectId, titleContains: title, limit: 5 });
        mcpStatus = list.result?.threads?.find((t: Json) => t.threadId === threadId)?.status;
        statusTimeline.push({ at: Date.now(), status: mcpStatus, whilePending: req.id });
        result.mcp[`threadListWhilePending${index}`] = list;
        if (mcpStatus === "waiting") {
          result.mcp[`threadListUnfilteredWaiting${index}`] = list;
          break;
        }
        await sleep(250);
      }
      result[`mcpSawWaitingAfterMs${index}`] = mcpStatus === "waiting" ? Date.now() - seenAt : null;
      result.mcp[`threadListWaiting${index}`] = await mcp.call("t3_thread_list", { projectId, titleContains: title, statuses: ["waiting"], limit: 5 });
      result.mcp[`threadReadMessagesWaiting${index}`] = await mcp.call("t3_thread_read", { threadId, view: "messages", limit: 50 });
      result.mcp[`pendingRequestList${index}`] = await mcp.call("t3_pending_request_list", { threadId });
      result.mcp[`threadReadActivity${index}`] = await mcp.call("t3_thread_read", { threadId, view: "activity", limit: 50 });
      const command = {
        type: "runtime-request.respond",
        commandId: randomUUID(),
        threadId,
        requestId: req.id,
        decision: index === 1 ? scenario.decision : "accept",
        ...(index === 1 ? scenario.extra ?? {} : {}),
      };
      const started = performance.now();
      const dispatched = ws.request("orchestration.dispatchCommand", command);
      const exit = await dispatched.exit;
      result.responses.push({ request: req, command, exit, ms: performance.now() - started });
      if (index === 1 && scenario.followUp) {
        result.followUp = await mcp.call("t3_thread_send", { threadId, message: scenario.followUp, mode: "auto" });
      }
    }
    result.wait = await mcp.call("t3_thread_wait", { threadId, timeoutMs: 120_000 });
    result.mcp.threadReadMessages = await mcp.call("t3_thread_read", { threadId, view: "messages", limit: 50 });
    result.mcp.threadReadActivityFinal = await mcp.call("t3_thread_read", { threadId, view: "activity", limit: 50 });
    result.mcp.threadListFinal = await mcp.call("t3_thread_list", { projectId, titleContains: title, limit: 5 });
    result.statusTimeline = statusTimeline;
    ws.interrupt(sub.id);
    ws.close();
    result.cleanup = await settleAndArchive(mcp, threadId);
    writeOut(`approval-${scenario.name}.json`, result);
    summary.push({
      scenario: scenario.name,
      threadId,
      approvalsSeen: result.responses.length,
      decisions: result.responses.map((r: Json) => [r.command.decision, r.exit?._tag]),
      wait: result.wait.result,
      cleanup: [result.cleanup.settle.isError, result.cleanup.archive.isError],
    });
  }
  console.log(JSON.stringify(summary, null, 2));
};

const question = async (resumeThreadId?: string) => {
  const mcp = await mcpClient(await mcpToken("approval-required"));
  const title = "t3-cardputer canary (question)";
  const result: Json = {};
  let threadId = resumeThreadId;
  if (!threadId) {
    const launch = await launchScratch(
      mcp,
      {
        title,
        message:
          "Use your AskUserQuestion tool to ask me one multiple-choice question: 'Red or blue?' with options Red and Blue. Then reply with only my choice.",
        runtimeMode: "approval-required",
        modelSelection: CANARY_MODEL,
      },
      "pending question",
    );
    result.launch = launch.launched;
    threadId = launch.threadId;
  }
  if (!threadId) return console.log(JSON.stringify(result, null, 2));
  for (let i = 0; i < 90; i++) {
    const list = await mcp.call("t3_pending_request_list", { threadId });
    const requestId = list.result?.requestIds?.[0];
    if (requestId) {
      const read = await mcp.call("t3_thread_read", { threadId, view: "activity", limit: 50 });
      result.list = list;
      result.read = await mcp.call("t3_pending_request_read", { threadId, requestId });
      result.threadRead = read;
      result.threadListUnfiltered = await mcp.call("t3_thread_list", { projectId: read.result?.thread?.projectId, titleContains: title, limit: 5 });
      result.threadListWaiting = await mcp.call("t3_thread_list", { projectId: read.result?.thread?.projectId, titleContains: title, statuses: ["waiting"], limit: 5 });
      break;
    }
    await sleep(1000);
  }
  writeOut("question.json", result);
  console.log(JSON.stringify(result, null, 2).slice(0, 8000));
};

const answerQuestion = async (requestId: string, answersJson: string) => {
  const mcp = await mcpClient(await mcpToken("approval-required"));
  const threadId = readFileSync(CREATED, "utf8").trim().split("\n").map((l) => JSON.parse(l)).findLast((x) => x.purpose === "pending question").threadId;
  const result: Json = {};
  result.respond = await mcp.call("t3_pending_request_respond", { threadId, requestId, answers: JSON.parse(answersJson) });
  result.wait = await mcp.call("t3_thread_wait", { threadId, timeoutMs: 120_000 });
  result.messages = await mcp.call("t3_thread_read", { threadId, view: "messages", limit: 50 });
  result.cleanup = await settleAndArchive(mcp, threadId);
  writeOut("question-answer.json", result);
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
};

const accessLevels = async () => {
  const levels: Access[] = ["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"];
  const results: Json[] = [];
  for (const access of levels) {
    const mcp = await mcpClient(await mcpToken(access));
    const { launched, threadId } = await launchScratch(
      mcp,
      {
        title: `t3-cardputer canary (access ${access})`,
        message: "Reply with the single word OK.",
        runtimeMode: "full-access",
        modelSelection: CANARY_MODEL,
      },
      `access ${access}`,
    );
    const entry: Json = { access, launched: !!threadId, isError: launched.isError, result: launched.result, error: launched.error };
    if (threadId) {
      entry.wait = (await mcp.call("t3_thread_wait", { threadId, timeoutMs: 120_000 })).result;
      entry.configuration = (await mcp.call("t3_thread_configuration", { threadId })).result;
      const owner = await mcpClient(await mcpToken("full-access"));
      entry.cleanup = await settleAndArchive(owner, threadId);
    }
    results.push(entry);
  }
  writeOut("access-levels.json", results);
  console.log(JSON.stringify(results, null, 2).slice(0, 8000));
};

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = (samples: { ms: number; bytes: number }[]) => {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const bytes = samples.map((s) => s.bytes).sort((a, b) => a - b);
  return {
    n: samples.length,
    ms: { median: +percentile(ms, 50).toFixed(1), p95: +percentile(ms, 95).toFixed(1), min: +ms[0].toFixed(1), max: +ms.at(-1)!.toFixed(1) },
    bytes: { median: percentile(bytes, 50), p95: percentile(bytes, 95) },
  };
};

const MEASURE_RECEIPT = "docs/receipts/2026-10-20-approvals-spike.measure.json";

const measure = async () => {
  const mcp = await mcpClient(await mcpToken("read-only"));
  const sample = (c: McpCall) => ({ ms: +c.ms.toFixed(2), bytes: c.bytes });
  const projectSamples: McpCall[] = [];
  for (let i = 0; i < 10; i++) projectSamples.push(await mcp.call("t3_project_list", {}));
  writeOut("mcp-project-list.raw.json", projectSamples[0].result);
  const projects: Json[] = projectSamples[0].result?.projects ?? [];
  const perProject: Json[] = [];
  for (const [index, project] of projects.entries()) {
    const samples: McpCall[] = [];
    for (let i = 0; i < 10; i++) samples.push(await mcp.call("t3_thread_list", { projectId: project.projectId ?? project.id }));
    perProject.push({
      project: `<project-${index + 1}>`,
      threadsReturned: samples[0].result?.threads?.length ?? 0,
      total: samples[0].result?.total,
      hasMore: samples[0].result?.nextCursor != null,
      ...stats(samples),
      samples: samples.map(sample),
    });
  }
  const result = {
    measuredAt: new Date().toISOString(),
    method: "10 sequential MCP tools/call over loopback, read-only token, default arguments; p95 is nearest-rank over 10 samples (= max)",
    projectList: { projects: projects.length, ...stats(projectSamples), samples: projectSamples.map(sample) },
    threadListPerProject: perProject,
  };
  writeOut("measure.json", result);
  writeFileSync(join(process.cwd(), MEASURE_RECEIPT), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
};

const models = async () => {
  const mcp = await mcpClient(await mcpToken("approval-required"));
  const capabilities = await mcp.call("orchestrator_capabilities", {});
  const catalog = (capabilities.result?.providers ?? []).map((p: Json) => ({
    providerInstanceId: p.providerInstanceId,
    usable: (p.constraints ?? []).length === 0,
    models: p.models.map((m: Json) => m.id),
  }));
  const results: Json[] = [];
  for (const [name, modelSelection] of [
    ["repair", REPAIR_MODEL],
    ["canary", CANARY_MODEL],
  ] as const) {
    const { launched, threadId } = await launchScratch(
      mcp,
      { title: `t3-cardputer canary (model ${name})`, message: "Reply with the single word ok.", runtimeMode: "approval-required", modelSelection },
      `model ${name}`,
    );
    const entry: Json = { name, modelSelection, launchError: launched.isError ? launched.result ?? launched.error : undefined };
    if (threadId) {
      entry.wait = (await mcp.call("t3_thread_wait", { threadId, timeoutMs: 180_000 })).result;
      entry.configuration = (await mcp.call("t3_thread_configuration", { threadId })).result;
      const activity = (await mcp.call("t3_thread_read", { threadId, view: "activity", limit: 50 })).result;
      entry.runs = activity?.recentRuns?.map((r: Json) => ({ status: r.status, providerInstanceId: r.providerInstanceId, model: r.model }));
      entry.items = activity?.items?.map((i: Json) => ({ type: i.type, status: i.status, text: i.text }));
      entry.cleanup = await settleAndArchive(mcp, threadId);
    }
    results.push(entry);
  }
  writeOut("models.json", { catalog, results });
  console.log(JSON.stringify({ catalog, results }, null, 2));
};

const verifyCleanup = async () => {
  const mcp = await mcpClient(await mcpToken("approval-required"));
  const created = existsSync(CREATED) ? readFileSync(CREATED, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const rows: Json[] = [];
  for (const { threadId, purpose } of created) {
    const read = await mcp.call("t3_thread_read", { threadId, limit: 1 });
    const t = read.result?.thread ?? read.result;
    rows.push({ purpose, status: t?.status, settled: t?.settled ?? t?.settledAt ?? null, archived: t?.archived ?? t?.archivedAt ?? null, isError: read.isError });
  }
  writeOut("cleanup-verify.json", rows);
  console.log(JSON.stringify(rows, null, 2));
};

const rawUpgrade = (path: string, bearer?: string) =>
  new Promise<number | string>((resolve) => {
    const req = request({
      host: new URL(BASE).hostname,
      port: Number(new URL(BASE).port),
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? "?");
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? "?");
    });
    req.on("error", (e: Json) => resolve(`error ${e.code}`));
    req.end();
  });

const probe = async () => {
  const s = await secrets();
  const mcp = await mcpToken("approval-required");
  const refresh = await fetch(`${BASE}/oauth/mcp/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x", client_id: "x" }),
  });
  const metadata = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  const result = {
    wsUpgrade: {
      internalBearerProtocol2: await rawUpgrade("/ws?orchestrationProtocol=2", s.internal),
      mcpBearerProtocol2: await rawUpgrade("/ws?orchestrationProtocol=2", mcp),
      noAuthProtocol2: await rawUpgrade("/ws?orchestrationProtocol=2"),
      internalBearerProtocol99: await rawUpgrade("/ws?orchestrationProtocol=99", s.internal),
      internalBearerNoProtocol: await rawUpgrade("/ws", s.internal),
    },
    mcpRefreshGrant: { status: refresh.status, body: await refresh.json() },
    mcpAuthorizationServerGrantTypes: metadata.grant_types_supported,
    mcpBearerOnHttpApi: (await fetch(`${BASE}/api/orchestration/shell`, { headers: { authorization: `Bearer ${mcp}` } })).status,
  };
  writeOut("probe.json", result);
  console.log(JSON.stringify(result, null, 2));
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const makeRedactor = (known: { threadIds: string[]; projectIds: string[]; environmentId?: string }) => {
  const labels = new Map<string, string>();
  const counters = new Map<string, number>();
  const label = (value: string, kind: string) => {
    if (!labels.has(value)) {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      labels.set(value, `<${kind}-${n}>`);
    }
    return labels.get(value)!;
  };
  const kindOf = (uuid: string) =>
    known.threadIds.some((t) => t.endsWith(uuid))
      ? "thread-id"
      : known.projectIds.includes(uuid)
        ? "project-id"
        : uuid === known.environmentId
          ? "environment-id"
          : "uuid";
  const home = homedir();
  const user = home.split("/").at(-1)!;
  return (text: string) =>
    text
      .replace(UUID, (uuid) => label(uuid, kindOf(uuid)))
      .replace(/toolu_[A-Za-z0-9]+/g, (id) => label(id, "tool-use-id"))
      .replace(/msg_[A-Za-z0-9]+/g, (id) => label(id, "message-id"))
      .replace(/(\.t3\/scratch\/[^"/\\]*?)-[0-9a-f]{8}\b/g, "$1-<thread-suffix>")
      .replaceAll(home, "<home>")
      .replaceAll(`${user}-server`, "<host-label>")
      .replaceAll(user, "<user>");
};

const fixtures = async () => {
  const dir = join(process.cwd(), "relay/test/fixtures/t3");
  mkdirSync(dir, { recursive: true });
  const read = (name: string) => JSON.parse(readFileSync(join(OUT, name), "utf8"));
  const created = readFileSync(CREATED, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const environment = await (await fetch(`${BASE}/.well-known/t3/environment`)).json();
  const projectList = read("mcp-project-list.raw.json");
  const known = {
    threadIds: created.map((c: Json) => c.threadId),
    projectIds: projectList.projects.map((p: Json) => p.id),
    environmentId: environment.environmentId,
  };
  const write = (name: string, data: unknown) => {
    const redact = makeRedactor(known);
    const text = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(join(dir, name), redact(text));
  };
  const call = (tool: string, args: Json, captured: McpCall) => ({ tool, arguments: args, result: captured.result });

  write("environment.json", environment);

  const approve = read("approval-approve.json");
  const threadId = approve.launch.result.threadId;
  const projectId = approve.launch.result.projectId;
  const title = approve.title;
  write("mcp-thread-list-waiting.json", {
    capturedWhile: "a command approval was pending for this thread (runtime request status=pending)",
    unfiltered: call("t3_thread_list", { projectId, titleContains: title, limit: 5 }, approve.mcp.threadListWhilePending1),
    statusesWaiting: call("t3_thread_list", { projectId, titleContains: title, statuses: ["waiting"], limit: 5 }, approve.mcp.threadListWaiting1),
    threadReadActivity: call("t3_thread_read", { threadId, view: "activity", limit: 50 }, approve.mcp.threadReadActivity1),
    pendingRequestList: call("t3_pending_request_list", { threadId }, approve.mcp.pendingRequestList1),
  });
  write("mcp-thread-read-messages.json", call("t3_thread_read", { threadId, view: "messages", limit: 50 }, approve.mcp.threadReadMessages));

  const projects = projectList.projects.map((p: Json, i: number) => {
    const name = `project-${i + 1}`;
    const workspaceRoot = `/<repos>/${name}`;
    const identity = p.repositoryIdentity;
    const repositoryIdentity =
      identity === null
        ? null
        : JSON.parse(
            JSON.stringify({ ...identity, rootPath: workspaceRoot })
              .replaceAll(identity.name, name)
              .replaceAll(identity.owner, "<owner>"),
          );
    return { ...p, title: name, workspaceRoot, repositoryIdentity, faviconPath: p.faviconPath === null ? null : "<favicon-path>" };
  });
  write("mcp-project-list.json", call("t3_project_list", {}, { result: { ...projectList, projects } } as McpCall));

  const q = read("question.json");
  const qa = read("question-answer.json");
  const qThreadId = created.findLast((c: Json) => c.purpose === "pending question").threadId;
  const requestId = q.list.result.requestIds[0];
  write("mcp-pending-question.json", {
    list: call("t3_pending_request_list", { threadId: qThreadId }, q.list),
    read: call("t3_pending_request_read", { threadId: qThreadId, requestId }, q.read),
    respond: call("t3_pending_request_respond", { threadId: qThreadId, requestId, answers: { "Red or blue?": "Blue" } }, qa.respond),
    threadListWhilePending: call("t3_thread_list", { projectId, titleContains: "t3-cardputer canary (question)", limit: 5 }, q.threadListUnfiltered),
  });

  write("ws-approval-frames.jsonl", readFileSync(join(OUT, "ws-approve.jsonl"), "utf8"));

  const s = await secrets();
  const tokens = [s.internal, ...Object.values(s.mcp)].filter(Boolean) as string[];
  for (const name of ["environment.json", "mcp-thread-list-waiting.json", "mcp-thread-read-messages.json", "mcp-project-list.json", "mcp-pending-question.json", "ws-approval-frames.jsonl"]) {
    const text = readFileSync(join(dir, name), "utf8");
    if (tokens.some((t) => text.includes(t)) || text.match(UUID) || text.includes(homedir())) throw new Error(`redaction leak in ${name}`);
  }
  console.log(`wrote fixtures to ${dir}`);
};

const revokeSessions = () => {
  const sessions = JSON.parse(execFileSync(T3_BIN, ["auth", "session", "list", "--json"], { encoding: "utf8" }));
  const mine = sessions.filter((x: Json) => (x.client?.label ?? "").startsWith(LABEL));
  for (const session of mine) execFileSync(T3_BIN, ["auth", "session", "revoke", session.sessionId], { encoding: "utf8" });
  rmSync(SECRETS, { force: true });
  console.log(`revoked ${mine.length} ${LABEL} sessions; deleted ${SECRETS}`);
};

const phases: Record<string, (...args: string[]) => Promise<void> | void> = {
  approvals,
  question,
  "answer-question": answerQuestion,
  access: accessLevels,
  measure,
  probe,
  models,
  fixtures,
  "verify-cleanup": verifyCleanup,
  revoke: revokeSessions,
};

const [phase, ...rest] = process.argv.slice(2);
if (!phase || !phases[phase]) {
  console.error(`usage: approvals-spike.ts <${Object.keys(phases).join("|")}> [args]`);
  process.exit(2);
}
Promise.resolve(phases[phase](...rest)).catch((error) => {
  console.error(error);
  process.exit(1);
});
