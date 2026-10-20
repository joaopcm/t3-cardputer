import { join } from "node:path";
import { startAdminServer } from "./admin.js";
import { createApprovalsAdapter, type ApprovalsAdapter } from "./approvals/index.js";
import { DeviceAuth } from "./auth/devices.js";
import { runCanary, type CanaryFailure } from "./canary.js";
import { loadConfig, type RelayConfig } from "./config.js";
import { DefaultsStore } from "./defaults-store.js";
import { SecretsStore } from "./secrets.js";
import { startServer, type ApprovalsState } from "./server.js";
import { createWhisperStt } from "./stt/whisper.js";
import { clearWhisperPid, reapOrphanWhisper, recordWhisperPid } from "./stt/whisper-pid.js";
import { getEnvironment } from "./t3/environment.js";
import { T3AuthError, T3Mcp } from "./t3/mcp.js";
import { VersionWatch, startVersionLoop } from "./version-watch.js";

export type RelayPaths = { configPath: string; secretsPath: string };

export const ADMIN_SOCKET_NAME = "admin.sock";
export const VERSION_STATE_NAME = "t3-version.json";
const PAIR_T3_HINT = "run `t3-cardputer-relay pair-t3`";
// receipt: docs/receipts/2026-10-20-canary.md, one version check is a single GET of the environment document that took 2.3-21.4 ms over 10 calls, so every pollIntervalMs x 10 (20 s) is negligible
const VERSION_CHECK_EVERY_POLLS = 10;

export type RelayHooks = {
  onCanaryFailed?: (failure: CanaryFailure, versions: { from?: string; to: string }) => void;
};

export function connectT3(config: RelayConfig, secrets: SecretsStore): { t3: T3Mcp; approvals: ApprovalsAdapter; close(): Promise<void> } {
  const t3 = new T3Mcp({ baseUrl: config.t3BaseUrl, secrets, limits: config.limits });
  const approvals = createApprovalsAdapter(
    config.t3BaseUrl,
    () => {
      const record = secrets.read().t3InternalToken;
      if (record === undefined) throw new T3AuthError("internal", `no T3 internal token: ${PAIR_T3_HINT}`);
      return record.token;
    },
    config.limits,
  );
  return {
    t3,
    approvals,
    async close() {
      await approvals.close();
      await t3.close();
    },
  };
}

export async function startRelay(paths: RelayPaths, hooks: RelayHooks = {}): Promise<{ port: number; close(): Promise<void> }> {
  const config = loadConfig(paths.configPath);
  const { limits, stateDir } = config;
  const secrets = new SecretsStore(paths.secretsPath);
  const auth = new DeviceAuth(secrets, limits);
  const pidFile = join(stateDir, "whisper.pid");

  const closers: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const closer of closers.splice(0).reverse()) await closer();
  };

  try {
    let disconnect: (deviceId: string, reason: string) => boolean = () => false;
    const admin = await startAdminServer({ socketPath: join(stateDir, ADMIN_SOCKET_NAME), auth, disconnect: (id, reason) => disconnect(id, reason) });
    closers.push(admin.close);

    await reapOrphanWhisper(pidFile);
    const stt = createWhisperStt({ whisper: config.whisper, limits, onSpawn: (pid) => recordWhisperPid(pidFile, pid) });
    closers.push(async () => {
      await stt.close();
      clearWhisperPid(pidFile);
    });

    const { t3, approvals, close: closeT3 } = connectT3(config, secrets);
    closers.push(closeT3);

    const approvalsState = (): ApprovalsState => {
      const record = secrets.read().t3InternalToken;
      if (record === undefined) return { available: false, reason: `no T3 internal token: ${PAIR_T3_HINT}` };
      if (Date.parse(record.expiresAt) <= Date.now()) return { available: false, reason: `T3 internal token expired: ${PAIR_T3_HINT}` };
      return { available: true };
    };

    const server = await startServer({
      config,
      t3,
      approvals,
      auth,
      defaults: new DefaultsStore(join(stateDir, "defaults.json")),
      stt,
      approvalsState,
    });
    closers.push(server.close);
    disconnect = server.disconnect;

    const canaryBlocked = (): string | undefined => {
      const mcp = secrets.read().t3McpToken;
      if (mcp === undefined) return `no T3 MCP token: ${PAIR_T3_HINT}`;
      if (Date.parse(mcp.expiresAt) <= Date.now()) return `T3 MCP token expired: ${PAIR_T3_HINT}`;
      const state = approvalsState();
      return state.available ? undefined : state.reason;
    };
    const versionLoop = startVersionLoop({
      watch: new VersionWatch(() => getEnvironment(config.t3BaseUrl), join(stateDir, VERSION_STATE_NAME)),
      intervalMs: limits.pollIntervalMs * VERSION_CHECK_EVERY_POLLS,
      blocked: canaryBlocked,
      retryMaxMs: limits.canaryRetryMaxMs,
      canary: () => runCanary({ t3, approvals }, { model: config.canary.model, timeoutMs: limits.canaryTimeoutMs, pollIntervalMs: limits.pollIntervalMs }),
      markApprovalsUp: server.markApprovalsUp,
      markApprovalsDown: server.markApprovalsDown,
      ...(hooks.onCanaryFailed ? { onCanaryFailed: hooks.onCanaryFailed } : {}),
    });
    closers.push(versionLoop.stop);
    return { port: server.port, close };
  } catch (error) {
    await close();
    throw error;
  }
}
