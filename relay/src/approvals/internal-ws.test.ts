import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { DEFAULT_LIMITS } from "../config.js";
import { T3AuthError } from "../t3/mcp.js";
import { AdapterBrokenError, ApprovalRejectedError, createApprovalsAdapter, pairT3Internal, type ApprovalDecision } from "./index.js";
import { RpcSocket } from "./rpc.js";

type Msg = Record<string, any>;
type Peer = { send(msg: Msg): void };
type Handler = (msg: Msg, peer: Peer) => void;
type Frame = { at: number; dir: "in" | "out"; msg: Msg };

const frames: Frame[] = readFileSync(join(import.meta.dirname, "__fixtures__", "ws-approval-frames.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const THREAD = "mcp:<thread-id-1>";
const respondFrame = frames.find((f) => f.dir === "out" && f.msg.tag === "orchestration.dispatchCommand")!.msg;
const REQUEST_ID: string = respondFrame.payload.requestId;
const subscriptionChunks = frames.filter((f) => f.dir === "in" && f.msg._tag === "Chunk" && f.msg.requestId === "1").map((f) => f.msg);

const APPROVAL_LINE = 8;
const RESOLUTION_LINE = 14;

function valuesThrough(lastLine: number): Msg[] {
  return frames.flatMap((f, i) => (i + 1 <= lastLine && f.dir === "in" && f.msg._tag === "Chunk" ? structuredClone(f.msg.values) : []));
}

function serve(values: Msg[]): Handler {
  return (msg, peer) => {
    if (msg._tag !== "Request") return;
    if (msg.tag === "orchestration.subscribeThread") peer.send({ _tag: "Chunk", requestId: msg.id, values });
    if (msg.tag === "orchestration.dispatchCommand") peer.send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { sequence: 367259 } } });
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fakeT3(handler: Handler = serve(valuesThrough(APPROVAL_LINE)), upgradeStatus?: number) {
  const received: Msg[] = [];
  const upgrades: { url: string; authorization: string | undefined }[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  http.on("upgrade", (req, socket, head) => {
    upgrades.push({ url: req.url ?? "", authorization: req.headers.authorization });
    if (upgradeStatus) {
      socket.end(`HTTP/1.1 ${upgradeStatus} Refused\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as Msg;
        received.push(msg);
        handler(msg, { send: (m) => ws.send(JSON.stringify(m)) });
      });
    });
  });
  await listen(http);
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise((resolve) => http.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    received,
    upgrades,
    outbound: () => received.map((m) => JSON.stringify(m)),
    connected: () => wss.clients.size,
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

function adapterFor(baseUrl: string, timeoutMs = DEFAULT_LIMITS.approvalsRpcTimeoutMs) {
  const adapter = createApprovalsAdapter(baseUrl, () => "internal-token", { approvalsRpcTimeoutMs: timeoutMs });
  cleanups.push(() => adapter.close());
  return adapter;
}

async function brokenReason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdapterBrokenError);
  return (error as AdapterBrokenError).reason;
}

describe("approvals adapter, listPending", () => {
  it("listPending returns the approval from the fixture with summary equal to the command", async () => {
    const t3 = await fakeT3();
    const pending = await adapterFor(t3.baseUrl).listPending([THREAD]);
    expect(pending).toEqual([
      {
        threadId: THREAD,
        requestId: REQUEST_ID,
        summary: "touch t3-cardputer-canary.txt",
        detail: ["Create empty canary file in working directory", "cwd: <home>/.t3/scratch/2026-10-20-run-the-shell-command-touch-<thread-suffix>"],
        decisions: ["allow_once", "allow_always", "deny", "deny_with_reason"],
      },
    ]);
  });

  it("reads a pending approval held in the snapshot's projection rows", async () => {
    const [snapshot, ...events] = valuesThrough(APPROVAL_LINE);
    for (const { event } of events) {
      if (event.type === "runtime-request.updated") snapshot!.projection.runtimeRequests.push(event.payload);
      if (event.type === "turn-item.updated") snapshot!.projection.turnItems.push(event.payload);
    }
    const t3 = await fakeT3(serve([snapshot!]));
    const pending = await adapterFor(t3.baseUrl).listPending([THREAD]);
    expect(pending.map((p) => [p.requestId, p.summary])).toEqual([[REQUEST_ID, "touch t3-cardputer-canary.txt"]]);
  });

  it("returns nothing once the fixture's resolution is folded in", async () => {
    const t3 = await fakeT3(serve(valuesThrough(RESOLUTION_LINE)));
    expect(await adapterFor(t3.baseUrl).listPending([THREAD])).toEqual([]);
  });

  it("connects with the bearer on the upgrade, subscribes, then interrupts and closes", async () => {
    const t3 = await fakeT3();
    await adapterFor(t3.baseUrl).listPending([THREAD]);
    expect(t3.upgrades).toEqual([{ url: "/ws?orchestrationProtocol=2", authorization: "Bearer internal-token" }]);
    expect(t3.received[0]).toEqual({ _tag: "Request", id: "1", tag: "orchestration.subscribeThread", payload: { threadId: THREAD }, headers: [] });
    await vi.waitFor(() => expect(t3.received.at(-1)).toEqual({ _tag: "Interrupt", requestId: "1" }));
    await vi.waitFor(() => expect(t3.connected()).toBe(0));
  });

  it("does not connect for an empty thread list", async () => {
    const t3 = await fakeT3();
    expect(await adapterFor(t3.baseUrl).listPending([])).toEqual([]);
    expect(t3.upgrades).toEqual([]);
  });

  it("tolerates new optional fields", async () => {
    const values = valuesThrough(APPROVAL_LINE);
    for (const value of values) {
      value.newTopLevelField = 1;
      if (value.event) value.event.payload.brandNewField = { nested: true };
    }
    const t3 = await fakeT3(serve(values));
    expect(await adapterFor(t3.baseUrl).listPending([THREAD])).toHaveLength(1);
  });

  it("unknown field shape throws AdapterBrokenError naming the zod path", async () => {
    const values = valuesThrough(APPROVAL_LINE);
    const request = values.find((v) => v.event?.type === "runtime-request.updated")!.event.payload;
    request.nativeRequestReference = request.nativeRequestRef;
    delete request.nativeRequestRef;
    const t3 = await fakeT3(serve(values));
    const reason = await brokenReason(adapterFor(t3.baseUrl).listPending([THREAD]));
    expect(reason).toContain("event.payload.nativeRequestRef");
    expect(reason).toContain("orchestration.subscribeThread");
  });

  it("throws AdapterBrokenError when a pending command has no matching command item", async () => {
    const values = valuesThrough(APPROVAL_LINE).filter((v) => v.event?.payload?.type !== "command_execution");
    const t3 = await fakeT3(serve(values));
    expect(await brokenReason(adapterFor(t3.baseUrl).listPending([THREAD]))).toMatch(/command_execution/);
  });

  it("throws AdapterBrokenError for a pending request that carries options", async () => {
    const values = valuesThrough(APPROVAL_LINE);
    values.find((v) => v.event?.type === "runtime-request.updated")!.event.payload.options = [{ id: "x" }];
    const t3 = await fakeT3(serve(values));
    expect(await brokenReason(adapterFor(t3.baseUrl).listPending([THREAD]))).toMatch(/options/);
  });

  it("throws AdapterBrokenError when the first chunk has no snapshot", async () => {
    const t3 = await fakeT3(serve(valuesThrough(APPROVAL_LINE).slice(1)));
    expect(await brokenReason(adapterFor(t3.baseUrl).listPending([THREAD]))).toMatch(/snapshot/);
  });
});

describe("approvals adapter, respond", () => {
  it("respond allow_once sends the exact payload recorded in the receipt", async () => {
    const t3 = await fakeT3();
    await adapterFor(t3.baseUrl).respond(THREAD, REQUEST_ID, { kind: "allow_once" });
    const sent = t3.received.find((m) => m._tag === "Request")!;
    const { id: _sentId, ...sentRest } = sent;
    const { id: _fixtureId, ...fixtureRest } = respondFrame;
    expect(sent.payload.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sentRest).toEqual({ ...fixtureRest, payload: { ...fixtureRest.payload, commandId: sent.payload.commandId } });
  });

  it("allow_always sends acceptForSession and acceptAlways never goes out", async () => {
    const t3 = await fakeT3();
    const adapter = adapterFor(t3.baseUrl);
    const decisions: ApprovalDecision[] = [{ kind: "allow_once" }, { kind: "allow_always" }, { kind: "deny" }, { kind: "deny_with_reason", reason: "use the scratch dir" }];
    for (const decision of decisions) await adapter.respond(THREAD, REQUEST_ID, decision);
    const sentDecisions = t3.received.filter((m) => m._tag === "Request").map((m) => m.payload.decision);
    expect(sentDecisions).toEqual(["accept", "acceptForSession", "decline", "decline"]);
    expect(t3.outbound().filter((frame) => frame.includes("acceptAlways"))).toEqual([]);
  });

  it("deny_with_reason sends a plain decline with no reason field", async () => {
    const t3 = await fakeT3();
    await adapterFor(t3.baseUrl).respond(THREAD, REQUEST_ID, { kind: "deny_with_reason", reason: "no" });
    const payload = t3.received.find((m) => m._tag === "Request")!.payload;
    expect(Object.keys(payload).sort()).toEqual(["commandId", "decision", "requestId", "threadId", "type"]);
  });

  it("rejects with ApprovalRejectedError when T3 answers with a Failure exit", async () => {
    const t3 = await fakeT3((msg, peer) => {
      if (msg._tag === "Request") peer.send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Failure", cause: { _tag: "Fail", error: "request is not pending" } } });
    });
    await expect(adapterFor(t3.baseUrl).respond(THREAD, REQUEST_ID, { kind: "deny" })).rejects.toThrow(ApprovalRejectedError);
  });
});

describe("approvals adapter, wire protocol", () => {
  it("every stream chunk is Acked", async () => {
    const t3 = await fakeT3((msg, peer) => {
      if (msg._tag === "Request") for (const chunk of subscriptionChunks) peer.send({ ...chunk, requestId: msg.id });
    });
    const rpc = new RpcSocket(t3.baseUrl, "internal-token", DEFAULT_LIMITS.approvalsRpcTimeoutMs);
    cleanups.push(async () => rpc.close());
    await rpc.ready;
    let seen = 0;
    await rpc.stream("orchestration.subscribeThread", { threadId: THREAD }, () => ++seen === subscriptionChunks.length);
    await vi.waitFor(() => expect(t3.received.filter((m) => m._tag === "Ack")).toHaveLength(subscriptionChunks.length));
    expect(subscriptionChunks.length).toBeGreaterThan(5);
    expect(t3.received.filter((m) => m._tag === "Ack").every((m) => m.requestId === "1")).toBe(true);
  });

  it("HTTP 426 throws AdapterBrokenError with reason containing orchestrationProtocol", async () => {
    const t3 = await fakeT3(undefined, 426);
    expect(await brokenReason(adapterFor(t3.baseUrl).listPending([THREAD]))).toContain("orchestrationProtocol");
  });

  it("HTTP 401 throws an internal T3AuthError", async () => {
    const t3 = await fakeT3(undefined, 401);
    const error = await adapterFor(t3.baseUrl).respond(THREAD, REQUEST_ID, { kind: "deny" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(T3AuthError);
    expect((error as T3AuthError).kind).toBe("internal");
  });

  it("unknown RPC tag throws AdapterBrokenError", async () => {
    const t3 = await fakeT3((msg, peer) => {
      if (msg._tag === "Request") peer.send({ _tag: "Stream", requestId: msg.id });
    });
    expect(await brokenReason(adapterFor(t3.baseUrl).listPending([THREAD]))).toContain('"Stream"');
  });

  it("an Exit before the snapshot throws AdapterBrokenError", async () => {
    const t3 = await fakeT3((msg, peer) => {
      if (msg._tag === "Request") peer.send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: null } });
    });
    expect(await brokenReason(adapterFor(t3.baseUrl).listPending([THREAD]))).toMatch(/Exit/);
  });

  it("no reply within approvalsRpcTimeoutMs throws AdapterBrokenError naming the budget", async () => {
    const t3 = await fakeT3(() => {});
    expect(await brokenReason(adapterFor(t3.baseUrl, 50).listPending([THREAD]))).toContain("approvalsRpcTimeoutMs=50");
  });

  it("close() leaves no open sockets or timers", async () => {
    const t3 = await fakeT3(() => {});
    const before = timeouts();
    const adapter = createApprovalsAdapter(t3.baseUrl, () => "internal-token");
    const pending = adapter.listPending([THREAD]);
    await vi.waitFor(() => expect(t3.received).toHaveLength(1));
    await adapter.close();
    await expect(pending).rejects.toThrow(/closed/);
    await vi.waitFor(() => expect(t3.connected()).toBe(0));
    await vi.waitFor(() => expect(timeouts()).toBe(before));
    await expect(adapter.listPending([THREAD])).rejects.toThrow(/closed/);
  });
});

describe("pairT3Internal", () => {
  it("exchanges a pairing code for an internal bearer", async () => {
    const forms: URLSearchParams[] = [];
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        expect(`${req.method} ${req.url}`).toBe("POST /oauth/token");
        forms.push(new URLSearchParams(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "bearer-1", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 2592000, scope: "x" }));
      });
    });
    await listen(http);
    cleanups.push(() => new Promise((resolve) => http.close(() => resolve())));
    const before = Date.now();
    const record = await pairT3Internal(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, "PAIRCODE1234");
    expect(record.token).toBe("bearer-1");
    expect(Date.parse(record.expiresAt) - before).toBeGreaterThanOrEqual(2592000 * 1000);
    expect(Object.fromEntries(forms[0]!)).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "PAIRCODE1234",
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
  });
});
