import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { ApprovalsAdapter } from "./approvals/index.js";
import { LockedOutError, PairingError, type DeviceAuth } from "./auth/devices.js";
import { lockoutSourceKey } from "./auth/lockout.js";
import type { RelayConfig } from "./config.js";
import type { DefaultsStore } from "./defaults-store.js";
import { DEVICE_FRAME_BYTES_MAX, DEVICE_NAME_MAX, DEVICE_PATH, PAIR_BODY_BYTES_MAX } from "./protocol/messages.js";
import { Hub, type ApprovalsDownPhase, type ApprovalsState, type T3Client } from "./session.js";
import type { Stt } from "./stt/types.js";
import { Watcher } from "./watcher.js";

export type { ApprovalsState, T3Client } from "./session.js";

export type ServerDeps = {
  config: RelayConfig;
  t3: T3Client;
  approvals: ApprovalsAdapter;
  auth: DeviceAuth;
  defaults: Pick<DefaultsStore, "get" | "remember">;
  stt: Stt;
  approvalsState: () => ApprovalsState;
  onAdapterBroken?: (reason: string) => void;
};

export const PAIR_PATH = "/v1/pair";
// the relay sits behind the local tailscaled proxy (Funnel), so it never listens beyond loopback
const LISTEN_HOST = "127.0.0.1";

const RELAY_VERSION = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;

const pairBodySchema = z.strictObject({ code: z.string().min(1), name: z.string().trim().min(1).max(DEVICE_NAME_MAX) });

export async function startServer(deps: ServerDeps): Promise<{
  port: number;
  disconnect(deviceId: string, reason: string): boolean;
  markApprovalsDown(reason: string, phase: ApprovalsDownPhase): void;
  markApprovalsUp(): void;
  setRepairWarning(text: string | undefined): void;
  close(): Promise<void>;
}> {
  const { limits } = deps.config;
  const watcher = new Watcher(deps.t3, deps.approvals, limits.pollIntervalMs);
  const hub = new Hub({ ...deps, limits, relayVersion: RELAY_VERSION }, watcher);

  const http = createServer((req, res) => {
    handleHttp(req, res, deps.auth).catch((error: unknown) => {
      console.error("http request failed", error);
      if (!res.headersSent) json(res, 500, { error: "internal" });
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: DEVICE_FRAME_BYTES_MAX });
  http.on("upgrade", (req, socket, head) => {
    if (pathOf(req) !== DEVICE_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws, sourceOf(req)));
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(deps.config.port, LISTEN_HOST, () => resolve());
  });

  return {
    port: (http.address() as AddressInfo).port,
    disconnect: (deviceId, reason) => hub.disconnect(deviceId, reason),
    markApprovalsDown: (reason, phase) => hub.markApprovalsDown(reason, phase),
    markApprovalsUp: () => hub.markApprovalsUp(),
    setRepairWarning: (text) => hub.setRepairWarning(text),
    async close() {
      hub.closeAll();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, auth: DeviceAuth): Promise<void> {
  if (req.method !== "POST" || pathOf(req) !== PAIR_PATH) {
    json(res, 404, { error: "not found" });
    return;
  }
  const body = await readBody(req, PAIR_BODY_BYTES_MAX);
  if (body === undefined) {
    json(res, 413, { error: `pair body too large: pair_body_bytes_max=${PAIR_BODY_BYTES_MAX}` });
    return;
  }
  const parsed = pairBodySchema.safeParse(tryJson(body));
  if (!parsed.success) {
    json(res, 401, { error: "pairing failed" });
    return;
  }
  try {
    const { token } = auth.redeem(parsed.data.code, parsed.data.name, sourceOf(req));
    json(res, 200, { token });
  } catch (error) {
    if (error instanceof PairingError) json(res, 401, { error: "pairing failed" });
    else if (error instanceof LockedOutError) json(res, 429, { error: error.message });
    else throw error;
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://relay").pathname;
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function sourceOf(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "";
  const forwarded = req.headers["x-forwarded-for"];
  // the local proxy appends the address it saw; earlier hops are whatever the client claimed
  const lastHop = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)?.split(",").at(-1)?.trim();
  return lockoutSourceKey(isLoopback(peer) && lastHop ? lastHop : peer);
}
