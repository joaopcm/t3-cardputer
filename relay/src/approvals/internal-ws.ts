import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_LIMITS, type Limits } from "../config.js";
import { RpcFailure, RpcSocket } from "./rpc.js";
import { AdapterBrokenError, ApprovalRejectedError, decode, type ApprovalDecision, type ApprovalsAdapter, type PendingApproval } from "./types.js";

const SUBSCRIBE = "orchestration.subscribeThread";
const DISPATCH = "orchestration.dispatchCommand";

const WIRE_DECISION = {
  allow_once: "accept",
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (b), Claude is told acceptAlways was declined, acceptForSession is the working "always"
  allow_always: "acceptForSession",
  deny: "decline",
  // receipt: docs/receipts/2026-10-20-approvals-spike.md (b), respond has no reason field, the session sends the reason as a thread message
  deny_with_reason: "decline",
} as const satisfies Record<ApprovalDecision["kind"], string>;

const OPTIONLESS_DECISIONS: ApprovalDecision["kind"][] = ["allow_once", "allow_always", "deny", "deny_with_reason"];

// receipt: docs/receipts/2026-10-20-approvals-spike.md (a), the runtime request kinds T3 raises; the second set are questions and flows answered elsewhere
const APPROVAL_KINDS = new Set(["command", "file-read", "file-change", "permission"]);
const NON_APPROVAL_KINDS = new Set(["mcp-elicitation", "user_input", "dynamic_tool_call", "auth_refresh"]);

const valueKindSchema = z.looseObject({ kind: z.enum(["snapshot", "event"]) });
const snapshotSchema = z.looseObject({
  projection: z.looseObject({
    thread: z.looseObject({ id: z.string(), worktreePath: z.string().nullable() }),
    runtimeRequests: z.array(z.unknown()),
    turnItems: z.array(z.unknown()),
  }),
});
const eventSchema = z.looseObject({ event: z.looseObject({ type: z.string(), payload: z.unknown() }) });
const requestSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  nativeRequestRef: z.looseObject({ nativeId: z.string() }),
  options: z.unknown().optional(),
});
const turnItemSchema = z.looseObject({ type: z.string() });
const commandItemSchema = z.looseObject({ nativeItemRef: z.looseObject({ nativeId: z.string() }).nullable(), input: z.string() });
const approvalItemSchema = z.looseObject({ requestId: z.string(), prompt: z.string() });

type RuntimeRequest = z.infer<typeof requestSchema>;

class ThreadView {
  #sawSnapshot = false;
  #worktreePath: string | null = null;
  readonly #requests = new Map<string, RuntimeRequest>();
  readonly #commandsByNativeId = new Map<string, string>();
  readonly #promptsByRequestId = new Map<string, string>();

  constructor(readonly threadId: string) {}

  apply(values: unknown[]): void {
    values.forEach((value, index) => {
      const where = `${SUBSCRIBE} values.${index}`;
      if (decode(valueKindSchema, value, where).kind === "snapshot") this.#applySnapshot(decode(snapshotSchema, value, where), where);
      else this.#applyEvent(decode(eventSchema, value, where), where);
    });
    if (!this.#sawSnapshot) throw new AdapterBrokenError(`${SUBSCRIBE} for ${this.threadId}: first chunk carried no snapshot`);
  }

  statusOf(requestId: string): string | undefined {
    return this.#requests.get(requestId)?.status;
  }

  pending(): PendingApproval[] {
    return [...this.#requests.values()].filter((request) => this.#isPendingApproval(request)).map((request) => this.#describe(request));
  }

  #applySnapshot({ projection }: z.infer<typeof snapshotSchema>, where: string): void {
    if (projection.thread.id !== this.threadId) {
      throw new AdapterBrokenError(`${where}.projection.thread.id is ${projection.thread.id}, subscribed to ${this.threadId}`);
    }
    this.#sawSnapshot = true;
    this.#worktreePath = projection.thread.worktreePath;
    this.#requests.clear();
    this.#commandsByNativeId.clear();
    this.#promptsByRequestId.clear();
    projection.runtimeRequests.forEach((request, i) => this.#upsertRequest(request, `${where}.projection.runtimeRequests.${i}`));
    projection.turnItems.forEach((item, i) => this.#upsertItem(item, `${where}.projection.turnItems.${i}`));
  }

  #applyEvent({ event }: z.infer<typeof eventSchema>, where: string): void {
    if (event.type === "runtime-request.updated") this.#upsertRequest(event.payload, `${where}.event.payload`);
    if (event.type === "turn-item.updated") this.#upsertItem(event.payload, `${where}.event.payload`);
  }

  #upsertRequest(raw: unknown, where: string): void {
    const request = decode(requestSchema, raw, where);
    this.#requests.set(request.id, request);
  }

  #upsertItem(raw: unknown, where: string): void {
    const { type } = decode(turnItemSchema, raw, where);
    if (type === "command_execution") {
      const item = decode(commandItemSchema, raw, where);
      if (item.nativeItemRef !== null) this.#commandsByNativeId.set(item.nativeItemRef.nativeId, item.input);
    }
    if (type === "approval_request") {
      const item = decode(approvalItemSchema, raw, where);
      this.#promptsByRequestId.set(item.requestId, item.prompt);
    }
  }

  #isPendingApproval(request: RuntimeRequest): boolean {
    if (request.status !== "pending" || NON_APPROVAL_KINDS.has(request.kind)) return false;
    if (!APPROVAL_KINDS.has(request.kind)) throw new AdapterBrokenError(`thread ${this.threadId}: pending runtime request has unknown kind ${JSON.stringify(request.kind)}`);
    if (request.options !== undefined) {
      throw new AdapterBrokenError(`thread ${this.threadId}: pending ${request.kind} request carries options, the adapter only knows option-less Claude approvals`);
    }
    return true;
  }

  #describe(request: RuntimeRequest): PendingApproval {
    const prompt = this.#promptsByRequestId.get(request.id);
    const cwd = this.#worktreePath === null ? [] : [`cwd: ${this.#worktreePath}`];
    const base = { threadId: this.threadId, requestId: request.id, decisions: [...OPTIONLESS_DECISIONS] };
    if (request.kind === "command") {
      const nativeId = request.nativeRequestRef.nativeId;
      const command = this.#commandsByNativeId.get(nativeId);
      if (command === undefined) {
        throw new AdapterBrokenError(`thread ${this.threadId}: pending command request has no command_execution turn item with nativeItemRef.nativeId=${nativeId}`);
      }
      return { ...base, summary: command, detail: [...(prompt === undefined ? [] : [prompt]), ...cwd] };
    }
    if (prompt === undefined) {
      throw new AdapterBrokenError(`thread ${this.threadId}: pending ${request.kind} request has no approval_request turn item with its requestId`);
    }
    return { ...base, summary: prompt, detail: [`kind: ${request.kind}`, ...cwd] };
  }
}

async function readThread(rpc: RpcSocket, threadId: string): Promise<ThreadView> {
  const view = new ThreadView(threadId);
  await rpc.stream(SUBSCRIBE, { threadId }, (values) => {
    view.apply(values);
    return true;
  });
  return view;
}

export function createApprovalsAdapter(
  baseUrl: string,
  token: () => string,
  limits: Pick<Limits, "approvalsRpcTimeoutMs"> = DEFAULT_LIMITS,
): ApprovalsAdapter {
  const sockets = new Set<RpcSocket>();
  let closed = false;
  const closedError = () => new Error("approvals adapter closed");

  async function session<T>(work: (rpc: RpcSocket) => Promise<T>): Promise<T> {
    if (closed) throw closedError();
    const rpc = new RpcSocket(baseUrl, token(), limits.approvalsRpcTimeoutMs);
    sockets.add(rpc);
    try {
      await rpc.ready;
      return await work(rpc);
    } finally {
      sockets.delete(rpc);
      rpc.close();
    }
  }

  return {
    async listPending(threadIds) {
      if (threadIds.length === 0) return [];
      return session(async (rpc) => {
        const views = await Promise.all(threadIds.map((threadId) => readThread(rpc, threadId)));
        return views.flatMap((view) => view.pending());
      });
    },

    async respond(threadId, requestId, decision) {
      await session(async (rpc) => {
        try {
          await rpc.call(DISPATCH, { type: "runtime-request.respond", commandId: randomUUID(), threadId, requestId, decision: WIRE_DECISION[decision.kind] });
        } catch (error) {
          if (!(error instanceof RpcFailure)) throw error;
          const status = (await readThread(rpc, threadId)).statusOf(requestId);
          const cause = JSON.stringify(error.exitCause);
          if (status === "pending") throw new AdapterBrokenError(`T3 refused a decision for a pending request: ${cause}`, { cause: error });
          throw new ApprovalRejectedError(`request is no longer pending (status ${status ?? "absent"}): ${cause}`, { cause: error });
        }
      });
    },

    async close() {
      closed = true;
      for (const rpc of sockets) rpc.close(closedError());
      sockets.clear();
    },
  };
}
