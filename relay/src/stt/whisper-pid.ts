import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const WHISPER_PROCESS_NAME = "whisper-server";
const EXIT_POLL_MS = 10;
// receipt: SIGKILL to the process gone took 1.3 ms p50 and 1.5 ms worst over 30 kills of a whisper-server stand-in on Linux, so 5 s only trips an uninterruptible process
const EXIT_WAIT_MS = 5000;

export function recordWhisperPid(pidFile: string, pid: number): void {
  writeFileSync(pidFile, `${pid}\n`);
}

export function clearWhisperPid(pidFile: string): void {
  rmSync(pidFile, { force: true });
}

function processName(pid: number): string | undefined {
  try {
    const name = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return name === "" ? undefined : basename(name);
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function reapOrphanWhisper(pidFile: string): Promise<number | undefined> {
  let text: string;
  try {
    text = readFileSync(pidFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  clearWhisperPid(pidFile);
  const pid = Number.parseInt(text, 10);
  if (!Number.isInteger(pid) || pid <= 0 || processName(pid) !== WHISPER_PROCESS_NAME) return undefined;
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new Error(`orphan ${WHISPER_PROCESS_NAME} pid ${pid} did not exit: whisper_orphan_exit_wait_ms=${EXIT_WAIT_MS}`);
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
  return pid;
}
