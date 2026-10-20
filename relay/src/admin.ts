import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { DeviceAuth } from "./auth/devices.js";

// receipt: the largest honest request is {"op":"revoke","id":"<36-char uuid>"}, 50 bytes, so 4096 is ~80x and only trips a wrong client
export const ADMIN_REQUEST_BYTES_MAX = 4096;

export type AdminRequest = { op: "pair" } | { op: "devices" } | { op: "revoke"; id: string };

export type AdminReply =
  | { ok: true; code: string; expiresAt: string }
  | { ok: true; devices: { id: string; name: string; createdAt: string; lastSeenAt?: string }[]; lockouts: { source: string; retryAfterMs: number }[] }
  | { ok: true; revoked: boolean; disconnected: boolean }
  | { ok: false; error: string };

export class AdminUnavailableError extends Error {
  override name = "AdminUnavailableError";
  constructor(readonly socketPath: string) {
    super(`relay not running: start it with \`t3-cardputer-relay serve\` (no admin socket answers at ${socketPath})`);
  }
}

type Disconnect = (deviceId: string, reason: string) => boolean;
type AdminAuth = Pick<DeviceAuth, "createPairingCode" | "list" | "revoke" | "lockout">;

const REVOKED_REASON = "device revoked, re-pair this device";

function handle(auth: AdminAuth, disconnect: Disconnect, line: string): AdminReply {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { ok: false, error: "admin request is not valid JSON" };
  }
  const { op, id } = (typeof request === "object" && request !== null ? request : {}) as { op?: unknown; id?: unknown };
  if (op === "pair") {
    const { code, expiresAt } = auth.createPairingCode();
    return { ok: true, code, expiresAt: expiresAt.toISOString() };
  }
  if (op === "devices") {
    const devices = auth.list().map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, ...(lastSeenAt === undefined ? {} : { lastSeenAt }) }));
    return { ok: true, devices, lockouts: auth.lockout.lockedOut() };
  }
  if (op === "revoke") {
    if (typeof id !== "string" || id === "") return { ok: false, error: "revoke needs a device id" };
    const revoked = auth.revoke(id);
    return { ok: true, revoked, disconnected: revoked && disconnect(id, REVOKED_REASON) };
  }
  return { ok: false, error: `unknown admin op ${JSON.stringify(op)}` };
}

async function assertNoLiveRelay(socketPath: string): Promise<void> {
  let kind;
  try {
    kind = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!kind.isSocket()) throw new Error(`${socketPath} exists and is not a socket, move it away`);
  const answered = await new Promise<boolean>((resolve, reject) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNREFUSED" ? resolve(false) : reject(error)));
  });
  if (answered) throw new Error(`relay already running: admin socket ${socketPath} answers`);
  rmSync(socketPath);
}

export async function startAdminServer(opts: { socketPath: string; auth: AdminAuth; disconnect?: Disconnect }): Promise<{ close(): Promise<void> }> {
  const { socketPath, auth, disconnect = () => false } = opts;
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  await assertNoLiveRelay(socketPath);

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      const length = newline === -1 ? buffered.length : newline;
      let reply: AdminReply | undefined;
      if (Buffer.byteLength(buffered.slice(0, length)) > ADMIN_REQUEST_BYTES_MAX) {
        reply = { ok: false, error: `admin request too large: admin_request_bytes_max=${ADMIN_REQUEST_BYTES_MAX}` };
      } else if (newline !== -1) {
        try {
          reply = handle(auth, disconnect, buffered.slice(0, newline));
        } catch (error) {
          reply = { ok: false, error: (error as Error).message };
        }
      }
      if (reply !== undefined) socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);

  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(socketPath, { force: true });
    },
  };
}

export async function adminRequest(socketPath: string, request: AdminRequest, timeoutMs: number): Promise<AdminReply> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffered = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`admin request timed out: adminRequestTimeoutMs=${timeoutMs}`))),
      timeoutMs,
    );
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      const line = buffered.slice(0, newline);
      finish(() => {
        try {
          resolve(JSON.parse(line) as AdminReply);
        } catch {
          reject(new Error("admin reply is not valid JSON"));
        }
      });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const down = error.code === "ENOENT" || error.code === "ECONNREFUSED";
      finish(() => reject(down ? new AdminUnavailableError(socketPath) : error));
    });
    socket.once("close", () => finish(() => reject(new Error("admin socket closed without a reply"))));
  });
}
