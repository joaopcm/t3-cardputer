import { join } from "node:path";
import { startAdminServer } from "./admin.js";
import { createApprovalsAdapter } from "./approvals/index.js";
import { DeviceAuth } from "./auth/devices.js";
import { loadConfig } from "./config.js";
import { DefaultsStore } from "./defaults-store.js";
import { SecretsStore } from "./secrets.js";
import { startServer, type ApprovalsState } from "./server.js";
import { createWhisperStt } from "./stt/whisper.js";
import { clearWhisperPid, reapOrphanWhisper, recordWhisperPid } from "./stt/whisper-pid.js";
import { T3AuthError, T3Mcp } from "./t3/mcp.js";

export type RelayPaths = { configPath: string; secretsPath: string };

export const ADMIN_SOCKET_NAME = "admin.sock";
const PAIR_T3_HINT = "run `t3-cardputer-relay pair-t3`";

export async function startRelay(paths: RelayPaths): Promise<{ port: number; close(): Promise<void> }> {
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

    const t3 = new T3Mcp({ baseUrl: config.t3BaseUrl, secrets, limits });
    closers.push(() => t3.close());

    const approvals = createApprovalsAdapter(
      config.t3BaseUrl,
      () => {
        const record = secrets.read().t3InternalToken;
        if (record === undefined) throw new T3AuthError("internal", `no T3 internal token: ${PAIR_T3_HINT}`);
        return record.token;
      },
      limits,
    );
    closers.push(() => approvals.close());

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
    return { port: server.port, close };
  } catch (error) {
    await close();
    throw error;
  }
}
