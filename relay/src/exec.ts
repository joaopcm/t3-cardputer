import { execFile } from "node:child_process";

export type ExecOptions = { cwd?: string; env?: Record<string, string>; timeoutMs: number; timeoutName: string };
export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<string>;

// receipt: the canary CLI fails with one ~120-char line and a tsc error line is ~150 chars, so 2000 keeps the canary line or the last ~13 compiler errors
const STDERR_TAIL_CHARS = 2000;

export const execRunner: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        const command = `${file} ${args.join(" ")}`;
        const why = error.killed ? `timed out: ${options.timeoutName}=${options.timeoutMs}, killed after ${options.timeoutMs} ms` : `exit ${error.code ?? error.signal}`;
        reject(new Error(`${command} failed: ${why}: ${(stderr || stdout).trim().slice(-STDERR_TAIL_CHARS)}`, { cause: error }));
      },
    );
  });
