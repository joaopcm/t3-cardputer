import WebSocket from "ws";
import { z } from "zod";
import { T3AuthError, T3UnavailableError, isConnectionError } from "../t3/mcp.js";
import { AdapterBrokenError, decode } from "./types.js";

// receipt: docs/receipts/2026-10-20-approvals-spike.md (c), any other version is refused with HTTP 426
const ORCHESTRATION_PROTOCOL = 2;

const exitSchema = z.discriminatedUnion("_tag", [
  z.looseObject({ _tag: z.literal("Success"), value: z.unknown() }),
  z.looseObject({ _tag: z.literal("Failure"), cause: z.unknown() }),
]);
const chunkSchema = z.looseObject({ requestId: z.string(), values: z.array(z.unknown()) });
const exitMessageSchema = z.looseObject({ requestId: z.string(), exit: exitSchema });

type Exit = z.infer<typeof exitSchema>;
type Pending = { onChunk(values: unknown[]): void; onExit(exit: Exit): void };
type Settle<T> = { resolve(value: T): void; reject(error: Error): void };

function upgradeError(status: number): Error {
  if (status === 426) return new AdapterBrokenError(`T3 refused orchestrationProtocol=${ORCHESTRATION_PROTOCOL} with HTTP 426, the internal protocol version moved`);
  if (status === 401 || status === 403) {
    return new T3AuthError("internal", `T3 rejected the internal token (${status}). pair again with a fresh code from \`t3 auth pairing create\``);
  }
  if (status >= 500) return new T3UnavailableError(`T3 /ws upgrade returned HTTP ${status}`);
  return new AdapterBrokenError(`T3 /ws upgrade returned HTTP ${status}`);
}

export class RpcFailure extends Error {
  override name = "RpcFailure";
  constructor(
    readonly tag: string,
    readonly exitCause: unknown,
  ) {
    super(`T3 answered ${tag} with Exit Failure: ${JSON.stringify(exitCause)}`);
  }
}

export class RpcSocket {
  readonly ready: Promise<void>;
  readonly #ws: WebSocket;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();
  readonly #interrupted = new Set<string>();
  readonly #rejecters = new Set<(error: Error) => void>();
  #nextId = 1;
  #failure: Error | undefined;

  constructor(baseUrl: string, token: string, timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
    const url = new URL(`/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL}`, baseUrl.replace(/^http/, "ws"));
    this.#ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.#ws.on("unexpected-response", (request, response) => {
      request.destroy();
      this.#fail(upgradeError(response.statusCode ?? 0));
    });
    this.#ws.on("error", (error) => {
      this.#fail(
        isConnectionError(error)
          ? new T3UnavailableError(`T3 unreachable at ${baseUrl}`, { cause: error })
          : new AdapterBrokenError(`internal WebSocket error: ${error.message}`, { cause: error }),
      );
    });
    this.#ws.on("close", (code) => this.#fail(new T3UnavailableError(`T3 closed the internal WebSocket (code ${code})`)));
    this.#ws.on("message", (data) => this.#onMessage(data.toString()));
    this.ready = this.#wait<void>("WebSocket upgrade", ({ resolve }) => this.#ws.once("open", () => resolve()));
  }

  stream(tag: string, payload: unknown, onValues: (values: unknown[]) => boolean): Promise<void> {
    return this.#wait<void>(tag, ({ resolve, reject }) => {
      const id = this.#request(tag, payload, {
        onChunk: (values) => {
          let done: boolean;
          try {
            done = onValues(values);
          } catch (error) {
            this.#interrupt(id);
            reject(error as Error);
            return;
          }
          if (!done) return;
          this.#interrupt(id);
          resolve();
        },
        onExit: (exit) => reject(new AdapterBrokenError(`${tag} ended with Exit ${exit._tag} before its stream was read`)),
      });
    });
  }

  call(tag: string, payload: unknown): Promise<unknown> {
    return this.#wait<unknown>(tag, ({ resolve, reject }) => {
      this.#request(tag, payload, {
        onChunk: () => reject(new AdapterBrokenError(`${tag} streamed a Chunk, expected a single Exit`)),
        onExit: (exit) => {
          if (exit._tag === "Success") resolve(exit.value);
          else reject(new RpcFailure(tag, exit.cause));
        },
      });
    });
  }

  close(reason: Error = new Error("internal WebSocket closed")): void {
    this.#fail(reason);
    this.#ws.close();
  }

  #wait<T>(what: string, start: (settle: Settle<T>) => void): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.#rejecters.delete(fail);
      };
      const fail = (error: Error) => {
        finish();
        reject(error);
      };
      const timer = setTimeout(() => fail(new AdapterBrokenError(`${what}: no reply within approvalsRpcTimeoutMs=${this.#timeoutMs}`)), this.#timeoutMs);
      this.#rejecters.add(fail);
      start({
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: fail,
      });
    });
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const reject of [...this.#rejecters]) reject(error);
    this.#pending.clear();
  }

  #send(message: Record<string, unknown>): void {
    if (this.#failure) return;
    this.#ws.send(JSON.stringify(message));
  }

  #request(tag: string, payload: unknown, pending: Pending): string {
    const id = String(this.#nextId++);
    this.#pending.set(id, pending);
    this.#send({ _tag: "Request", id, tag, payload, headers: [] });
    return id;
  }

  #interrupt(id: string): void {
    this.#pending.delete(id);
    this.#interrupted.add(id);
    this.#send({ _tag: "Interrupt", requestId: id });
  }

  #onMessage(text: string): void {
    if (this.#failure) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      this.#fail(new AdapterBrokenError("T3 sent a non-JSON frame on /ws"));
      return;
    }
    try {
      for (const message of Array.isArray(decoded) ? decoded : [decoded]) this.#dispatch(message);
    } catch (error) {
      this.#fail(error as Error);
    }
  }

  #dispatch(message: unknown): void {
    const tag = typeof message === "object" && message !== null ? (message as { _tag?: unknown })._tag : undefined;
    switch (tag) {
      case "Chunk": {
        const chunk = decode(chunkSchema, message, "Chunk");
        this.#send({ _tag: "Ack", requestId: chunk.requestId });
        const pending = this.#pending.get(chunk.requestId);
        if (pending) pending.onChunk(chunk.values);
        else if (!this.#interrupted.has(chunk.requestId)) throw new AdapterBrokenError(`Chunk for unknown request ${chunk.requestId}`);
        return;
      }
      case "Exit": {
        const { requestId, exit } = decode(exitMessageSchema, message, "Exit");
        if (this.#interrupted.delete(requestId)) return;
        const pending = this.#pending.get(requestId);
        if (!pending) throw new AdapterBrokenError(`Exit for unknown request ${requestId}`);
        this.#pending.delete(requestId);
        pending.onExit(exit);
        return;
      }
      case "Pong":
        return;
      case "Defect":
        throw new AdapterBrokenError(`T3 sent a Defect: ${JSON.stringify((message as { defect?: unknown }).defect)}`);
      case "ClientProtocolError":
        throw new AdapterBrokenError(`T3 rejected a frame with ClientProtocolError: ${JSON.stringify((message as { error?: unknown }).error)}`);
      default:
        throw new AdapterBrokenError(`unknown RPC tag ${JSON.stringify(tag)} on /ws`);
    }
  }
}
