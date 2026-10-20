import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayConfig } from "./config.js";
import { execRunner, type Exec } from "./exec.js";

export const DEPLOYED_STATE_NAME = "deployed.json";
export const RELAY_UNIT = "t3-cardputer-relay";

export async function deploy(cfg: RelayConfig, exec: Exec = execRunner): Promise<void> {
  const { deployDir } = cfg.repair;
  const relayDir = join(deployDir, "relay");
  const step = (file: string, args: string[], cwd?: string) =>
    exec(file, args, { ...(cwd === undefined ? {} : { cwd }), timeoutMs: cfg.limits.repairStepTimeoutMs, timeoutName: "repairStepTimeoutMs" });

  await step("git", ["pull", "--ff-only", "origin", "main"], deployDir);
  await step("pnpm", ["install", "--frozen-lockfile"], relayDir);
  await step("pnpm", ["build"], relayDir);
  const sha = (await step("git", ["rev-parse", "HEAD"], deployDir)).trim();

  const statePath = join(cfg.stateDir, DEPLOYED_STATE_NAME);
  const tmp = `${statePath}.${process.pid}.tmp`;
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(tmp, JSON.stringify({ sha, deployedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, statePath);

  // the restart stops this process, so waiting on the job would kill the waiter mid-restart
  await step("systemctl", ["--user", "restart", "--no-block", RELAY_UNIT]);
}
