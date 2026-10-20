import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEFAULT_LIMITS, type Limits } from "../config.js";
import type { SecretsStore } from "../secrets.js";

// receipt: t3_thread_list and t3_thread_read declare a maximum of 100 per page in their tool schemas
const PAGE_SIZE = 100;
// receipt: t3_thread_read declares maxCharsPerItem maximum 50000 in its tool schema
const MAX_CHARS_PER_ITEM = 50_000;
// receipt: docs/receipts/2026-10-20-approvals-spike.md (f), claudeAgent is the only usable provider instance
const PROVIDER_INSTANCE_ID = "claudeAgent";
const DEFAULT_BASE_REF = "main";

export class T3UnavailableError extends Error {
  override name = "T3UnavailableError";
  readonly httpStatus: number | undefined;
  constructor(message: string, options?: ErrorOptions & { httpStatus?: number | undefined }) {
    super(message, options);
    this.httpStatus = options?.httpStatus;
  }
}

export class T3AuthError extends Error {
  override name = "T3AuthError";
  constructor(
    readonly kind: "mcp" | "internal",
    message: string,
  ) {
    super(message);
  }
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code ?? ((error.cause as NodeJS.ErrnoException | undefined)?.code);
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
  return error instanceof TypeError && error.message === "fetch failed";
}

export type T3Project = { projectId: string; name: string; defaultModel?: string; defaultWorkspace?: "root" | "worktree" };
export type T3ThreadSummary = { threadId: string; projectId: string; title: string; status: string; updatedAt: string };
export type T3Question = {
  requestId: string;
  questionId: string;
  prompt: string;
  options: { label: string; value: string }[];
  multiSelect: boolean;
};
export type T3LaunchInput = {
  projectId?: string;
  scratch?: true;
  title: string;
  message: string;
  model?: string;
  options?: { id: string; value: string }[];
  workspace: "root" | "worktree";
  branch?: string;
  baseRef?: string;
  runtimeMode?: string;
};

export type T3McpOptions = {
  baseUrl: string;
  secrets: Pick<SecretsStore, "read">;
  limits?: Pick<Limits, "mcpRequestTimeoutMs" | "mcpWaitGraceMs" | "mcpMaxPages">;
  createTransport?: () => Promise<Transport>;
};

const projectListSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      defaultModelSelection: z.object({ model: z.string() }).nullish(),
      defaultThreadEnvMode: z.string().nullish(),
    }),
  ),
  nextCursor: z.number().nullish(),
});

const threadListSchema = z.object({
  projectId: z.string(),
  threads: z.array(z.object({ threadId: z.string(), title: z.string(), status: z.string(), updatedAt: z.string() })),
  nextCursor: z.number().nullish(),
});

const readItemSchema = z.object({
  itemId: z.string(),
  type: z.string(),
  text: z.string().nullish(),
  textTruncated: z.boolean().nullish(),
  nextTextOffset: z.number().nullish(),
  updatedAt: z.string(),
});

const threadReadSchema = z.object({
  thread: z.object({ model: z.string().nullish() }),
  items: z.array(readItemSchema),
  nextPosition: z.number().nullish(),
  hasMore: z.boolean().nullish(),
});

const launchSchema = z.union([z.object({ threadId: z.string() }), z.object({ thread: z.object({ threadId: z.string() }) })]);

const requestListSchema = z.object({ requestIds: z.array(z.string()) });

const requestReadSchema = z.object({
  requestId: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.object({ label: z.string() })).nullish(),
      multiSelect: z.boolean().nullish(),
    }),
  ),
});

const waitSchema = z.object({ status: z.string(), timedOut: z.boolean().nullish() });

function toProject(project: z.infer<typeof projectListSchema>["projects"][number]): T3Project {
  const out: T3Project = { projectId: project.id, name: project.title };
  if (project.defaultModelSelection) out.defaultModel = project.defaultModelSelection.model;
  if (project.defaultThreadEnvMode) out.defaultWorkspace = project.defaultThreadEnvMode === "worktree" ? "worktree" : "root";
  return out;
}

export class T3Mcp {
  private readonly limits: Pick<Limits, "mcpRequestTimeoutMs" | "mcpWaitGraceMs" | "mcpMaxPages">;
  private connection: Promise<Client> | undefined;

  constructor(private readonly options: T3McpOptions) {
    this.limits = options.limits ?? DEFAULT_LIMITS;
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await (await connection?.catch(() => undefined))?.close();
  }

  async listProjects(): Promise<T3Project[]> {
    const projects: T3Project[] = [];
    await this.paginate("t3_project_list", {}, projectListSchema, (page) => {
      projects.push(...page.projects.map(toProject));
      return page.nextCursor;
    });
    return projects;
  }

  async listThreads(projectId: string): Promise<T3ThreadSummary[]> {
    return this.listThreadPages(projectId, {});
  }

  async listRecentlyCompleted(projectId: string, sinceMs: number): Promise<T3ThreadSummary[]> {
    const byId = new Map<string, T3ThreadSummary>();
    // receipt: t3_thread_list description, settled=true lists threads "the user or auto-settlement moved out of the active list"
    for (const settled of [false, true]) {
      for (const thread of await this.listThreadPages(projectId, { statuses: ["completed"], settled }, sinceMs)) {
        if (Date.parse(thread.updatedAt) >= sinceMs && !byId.has(thread.threadId)) byId.set(thread.threadId, thread);
      }
    }
    return [...byId.values()];
  }

  async latestAssistantMessage(threadId: string): Promise<{ text: string; model: string; at: string } | null> {
    let latest: z.infer<typeof readItemSchema> | undefined;
    let model = "";
    await this.paginate(
      "t3_thread_read",
      { threadId, view: "messages", limit: PAGE_SIZE, maxCharsPerItem: MAX_CHARS_PER_ITEM },
      threadReadSchema,
      (page) => {
        model = page.thread.model ?? model;
        latest = page.items.findLast((item) => item.type === "assistant_message") ?? latest;
        return page.hasMore ? page.nextPosition : null;
      },
      "afterPosition",
    );
    if (!latest) return null;

    let text = latest.text ?? "";
    let offset = latest.textTruncated ? latest.nextTextOffset : null;
    for (let page = 1; offset != null; page++) {
      this.assertWithinPages(page, "t3_thread_read text continuation");
      const part = threadReadSchema.parse(
        await this.call("t3_thread_read", { threadId, view: "messages", itemId: latest.itemId, textOffset: offset, maxCharsPerItem: MAX_CHARS_PER_ITEM }),
      );
      const item = part.items.find((candidate) => candidate.itemId === latest?.itemId);
      if (!item) throw new Error(`t3_thread_read returned no item ${latest.itemId} for textOffset=${offset}`);
      text += item.text ?? "";
      offset = item.textTruncated ? item.nextTextOffset : null;
    }
    return { text, model, at: latest.updatedAt };
  }

  async send(threadId: string, text: string, mode: "queue" | "steer", clientRequestId: string): Promise<void> {
    await this.call("t3_thread_send", { threadId, message: text, mode, clientRequestId });
  }

  async launch(input: T3LaunchInput): Promise<{ threadId: string }> {
    if ((input.projectId === undefined) === (input.scratch === undefined)) {
      throw new Error("t3 launch needs exactly one of projectId or scratch");
    }
    const args: Record<string, unknown> = { title: input.title, message: input.message };
    if (input.scratch) args.scratch = true;
    else args.projectId = input.projectId;
    if (input.model) args.modelSelection = { instanceId: PROVIDER_INSTANCE_ID, model: input.model, ...(input.options ? { options: input.options } : {}) };
    if (input.runtimeMode) args.runtimeMode = input.runtimeMode;
    if (!input.scratch) {
      args.workspaceStrategy =
        input.workspace === "worktree"
          ? { type: "worktree", baseRef: input.baseRef ?? DEFAULT_BASE_REF, ...(input.branch ? { branch: input.branch } : {}) }
          : { type: "root", ...(input.branch ? { branch: input.branch } : {}) };
    }
    const launched = launchSchema.parse(await this.call("t3_thread_launch", args));
    return { threadId: "threadId" in launched ? launched.threadId : launched.thread.threadId };
  }

  async settleThread(threadId: string): Promise<void> {
    await this.call("t3_thread_organize", { threadId, action: "settle" });
    await this.call("t3_thread_organize", { threadId, action: "archive" });
  }

  async listQuestions(threadId: string): Promise<T3Question[]> {
    const { requestIds } = requestListSchema.parse(await this.call("t3_pending_request_list", { threadId }));
    const questions: T3Question[] = [];
    for (const requestId of requestIds) {
      const request = requestReadSchema.parse(await this.call("t3_pending_request_read", { threadId, requestId }));
      for (const question of request.questions) {
        questions.push({
          requestId: request.requestId,
          questionId: question.id,
          prompt: question.question,
          options: (question.options ?? []).map((option) => ({ label: option.label, value: option.label })),
          multiSelect: question.multiSelect ?? false,
        });
      }
    }
    return questions;
  }

  async answerQuestion(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void> {
    await this.call("t3_pending_request_respond", { threadId, requestId, answers });
  }

  async waitForRun(threadId: string, timeoutMs: number): Promise<{ status: string; timedOut: boolean }> {
    const result = waitSchema.parse(await this.call("t3_thread_wait", { threadId, timeoutMs }, timeoutMs + this.limits.mcpWaitGraceMs));
    return { status: result.status, timedOut: result.timedOut ?? false };
  }

  private async listThreadPages(projectId: string, extra: Record<string, unknown>, stopBeforeMs?: number): Promise<T3ThreadSummary[]> {
    const threads: T3ThreadSummary[] = [];
    await this.paginate(
      "t3_thread_list",
      { projectId, settled: false, includeSubagents: false, limit: PAGE_SIZE, ...extra },
      threadListSchema,
      (page) => {
        threads.push(...page.threads.map((t) => ({ threadId: t.threadId, projectId: page.projectId, title: t.title, status: t.status, updatedAt: t.updatedAt })));
        const oldest = page.threads.at(-1);
        // receipt: t3_thread_list description says it lists "newest first", so a page ending before the cutoff ends the search
        if (stopBeforeMs !== undefined && oldest !== undefined && Date.parse(oldest.updatedAt) < stopBeforeMs) return null;
        return page.nextCursor;
      },
    );
    return threads;
  }

  private async paginate<S extends z.ZodType>(
    tool: string,
    args: Record<string, unknown>,
    schema: S,
    onPage: (page: z.infer<S>) => number | null | undefined,
    cursorKey = "cursor",
  ): Promise<void> {
    let cursor: number | undefined;
    for (let page = 1; ; page++) {
      this.assertWithinPages(page, tool);
      const result = schema.parse(await this.call(tool, cursor === undefined ? args : { ...args, [cursorKey]: cursor }));
      const next = onPage(result);
      if (next == null) return;
      cursor = next;
    }
  }

  private assertWithinPages(page: number, what: string): void {
    if (page > this.limits.mcpMaxPages) {
      throw new Error(`${what} did not finish: mcpMaxPages=${this.limits.mcpMaxPages}, needed more than ${this.limits.mcpMaxPages} pages`);
    }
  }

  private async call(name: string, args: Record<string, unknown>, timeoutMs = this.limits.mcpRequestTimeoutMs): Promise<unknown> {
    const client = await this.connect();
    let result;
    try {
      result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (error) {
      throw await this.translate(error, name, timeoutMs);
    }
    const text = (result.content as { type: string; text?: string }[] | undefined)?.find((part) => part.type === "text")?.text;
    if (result.isError) throw new Error(`T3 tool ${name} failed: ${text ?? JSON.stringify(result.content)}`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (text === undefined) throw new Error(`T3 tool ${name} returned no content`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`T3 tool ${name} returned non-JSON text: ${text.slice(0, 200)}`);
    }
  }

  private connect(): Promise<Client> {
    this.connection ??= this.open().catch(async (error: unknown) => {
      this.connection = undefined;
      throw await this.translate(error, "connect");
    });
    return this.connection;
  }

  private async open(): Promise<Client> {
    const transport = await (this.options.createTransport ?? (() => this.httpTransport()))();
    const client = new Client({ name: "t3-cardputer-relay", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  private async httpTransport(): Promise<Transport> {
    const record = this.options.secrets.read().t3McpToken;
    if (!record) throw new T3AuthError("mcp", "no T3 MCP token stored. pair with a fresh pairing code from `t3 auth pairing create`");
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new T3AuthError("mcp", `T3 MCP token expired at ${record.expiresAt}. pair with a fresh pairing code from \`t3 auth pairing create\``);
    }
    const url = new URL("/mcp", this.options.baseUrl);
    // the SDK's transport class declares sessionId as string | undefined, which Transport rejects under exactOptionalPropertyTypes
    return new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${record.token}` } } }) as Transport;
  }

  private async translate(error: unknown, what: string, timeoutMs?: number): Promise<unknown> {
    if (error instanceof T3AuthError || error instanceof T3UnavailableError) return error;
    if (error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401)) {
      await this.close();
      return new T3AuthError("mcp", "T3 rejected the MCP token (401). pair with a fresh pairing code from `t3 auth pairing create`");
    }
    if (isConnectionError(error)) {
      await this.close();
      return new T3UnavailableError(`T3 unreachable at ${this.options.baseUrl} (${what})`, { cause: error });
    }
    if (error instanceof StreamableHTTPError) {
      // a restarted T3 answers the old mcp-session-id with 404 and the SDK does not re-initialize, so drop the session and reconnect on the next call
      await this.close();
      return new T3UnavailableError(`T3 at ${this.options.baseUrl} answered HTTP ${error.code} (${what}), reconnecting`, { cause: error, httpStatus: error.code });
    }
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      return new Error(`T3 tool ${what} timed out: timeout=${timeoutMs}ms (mcpRequestTimeoutMs=${this.limits.mcpRequestTimeoutMs})`);
    }
    return error;
  }
}
