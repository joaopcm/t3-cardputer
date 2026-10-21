import { join } from "node:path";
import { startAdminServer } from "./admin.js";
import { createApprovalsAdapter, type ApprovalsAdapter } from "./approvals/index.js";
import { DeviceAuth } from "./auth/devices.js";
import { runCanary, type CanaryFailure, type CanaryResult } from "./canary.js";
import { loadConfig, type RelayConfig } from "./config.js";
import { DefaultsStore } from "./defaults-store.js";
import { deploy } from "./deploy.js";
import { execRunner } from "./exec.js";
import { RepairOrchestrator } from "./repair/orchestrator.js";
import { SecretsStore } from "./secrets.js";
import { startServer, type ApprovalsState, type T3Client } from "./server.js";
import { createWhisperStt } from "./stt/whisper.js";
import { clearWhisperPid, reapOrphanWhisper, recordWhisperPid } from "./stt/whisper-pid.js";
import { getEnvironment } from "./t3/environment.js";
import { T3AuthError, T3Mcp } from "./t3/mcp.js";
import { tokenExpiryWarnings } from "./t3/token-expiry.js";
import { VersionWatch, startVersionLoop, type VersionLoop } from "./version-watch.js";

export type RelayPaths = { configPath: string; secretsPath: string };

export const ADMIN_SOCKET_NAME = "admin.sock";
export const VERSION_STATE_NAME = "t3-version.json";
const RENEW_HINT = "run t3-cardputer-relay renew";
export const REPAIR_NEEDS_CANARY_WARNING = "self-repair needs canary.enabled=true in relay.json, repair is off";
// receipt: docs/receipts/2026-10-20-canary.md, one version check is a single GET of the environment document that took 2.3-21.4 ms over 10 calls, so every pollIntervalMs x 10 (20 s) is negligible
const VERSION_CHECK_EVERY_POLLS = 10;

export type T3Connection = { t3: T3Client & Pick<T3Mcp, "waitForRun" | "settleThread">; approvals: ApprovalsAdapter; close(): Promise<void> };

export type RelayHooks = {
  onCanaryFailed?: (failure: CanaryFailure, versions: { from?: string; to: string }) => void;
  connect?: (config: RelayConfig, secrets: SecretsStore) => T3Connection;
  canary?: () => Promise<CanaryResult>;
};

export function connectT3(config: RelayConfig, secrets: SecretsStore): { t3: T3Mcp; approvals: ApprovalsAdapter; close(): Promise<void> } {
  const t3 = new T3Mcp({ baseUrl: config.t3BaseUrl, secrets, limits: config.limits });
  const approvals = createApprovalsAdapter(
    config.t3BaseUrl,
    () => {
      const record = secrets.read().t3InternalToken;
      if (record === undefined) throw new T3AuthError("internal", `no T3 internal token: ${RENEW_HINT}`);
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
    let versionLoop: VersionLoop | undefined;
    const admin = await startAdminServer({ socketPath: join(stateDir, ADMIN_SOCKET_NAME), auth, disconnect: (id, reason) => disconnect(id, reason) });
    closers.push(admin.close);

    await reapOrphanWhisper(pidFile);
    const stt = createWhisperStt({ whisper: config.whisper, limits, onSpawn: (pid) => recordWhisperPid(pidFile, pid) });
    closers.push(async () => {
      await stt.close();
      clearWhisperPid(pidFile);
    });

    const { t3, approvals, close: closeT3 } = (hooks.connect ?? connectT3)(config, secrets);
    closers.push(closeT3);

    const repairWithoutCanary = config.repair.projectId !== undefined && !config.canary.enabled;
    if (repairWithoutCanary) console.error(REPAIR_NEEDS_CANARY_WARNING);

    const approvalsState = (): ApprovalsState => {
      const record = secrets.read().t3InternalToken;
      if (record === undefined) return { available: false, reason: `no T3 internal token: ${RENEW_HINT}` };
      if (Date.parse(record.expiresAt) <= Date.now()) return { available: false, reason: `T3 internal token expired: ${RENEW_HINT}` };
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
      warnings: () => [...tokenExpiryWarnings(secrets.read(), new Date()), ...(repairWithoutCanary ? [REPAIR_NEEDS_CANARY_WARNING] : [])],
      onAdapterBroken: () => versionLoop?.recheck() ?? "none",
    });
    closers.push(server.close);
    disconnect = server.disconnect;

    const canaryBlocked = (): string | undefined => {
      const mcp = secrets.read().t3McpToken;
      if (mcp === undefined) return `no T3 MCP token: ${RENEW_HINT}`;
      if (Date.parse(mcp.expiresAt) <= Date.now()) return `T3 MCP token expired: ${RENEW_HINT}`;
      const state = approvalsState();
      return state.available ? undefined : state.reason;
    };
    const repair = new RepairOrchestrator({
      config,
      secrets,
      exec: execRunner,
      t3,
      markApprovalsDown: server.markApprovalsDown,
      setWarning: server.setRepairWarning,
      deploy: () => deploy(config),
    });
    closers.push(() => repair.close());
    if (config.canary.enabled) {
      const canaryOptions = { model: config.canary.model, providerInstanceId: config.canary.providerInstanceId, timeoutMs: limits.canaryTimeoutMs, pollIntervalMs: limits.pollIntervalMs };
      const loop = startVersionLoop({
        watch: new VersionWatch(() => getEnvironment(config.t3BaseUrl), join(stateDir, VERSION_STATE_NAME)),
        intervalMs: limits.pollIntervalMs * VERSION_CHECK_EVERY_POLLS,
        blocked: canaryBlocked,
        retryMaxMs: limits.canaryRetryMaxMs,
        canary: hooks.canary ?? (() => runCanary({ t3, approvals }, canaryOptions)),
        markApprovalsUp: server.markApprovalsUp,
        markApprovalsDown: server.markApprovalsDown,
        onCanaryFailed: hooks.onCanaryFailed ?? ((failure, versions) => repair.onBroken(failure, versions)),
      });
      versionLoop = loop;
      closers.push(loop.stop);
    }
    return { port: server.port, close };
  } catch (error) {
    await close();
    throw error;
  }
}
