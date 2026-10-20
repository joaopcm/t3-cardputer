import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const tokenRecordSchema = z.object({ token: z.string(), expiresAt: z.string() });

const deviceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenSha256: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().optional(),
});

const secretsSchema = z.object({
  t3McpToken: tokenRecordSchema.optional(),
  t3InternalToken: tokenRecordSchema.optional(),
  githubToken: z.string().optional(),
  devices: z.array(deviceRecordSchema),
});

export type TokenRecord = z.infer<typeof tokenRecordSchema>;
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;
export type Secrets = z.infer<typeof secretsSchema>;

export class SecretsStore {
  constructor(private readonly path: string) {}

  read(): Secrets {
    if (!this.assertPrivate()) return { devices: [] };
    const text = readFileSync(this.path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid secrets file ${this.path}: not valid JSON (${(error as Error).message})`);
    }
    const result = secretsSchema.safeParse(parsed);
    if (!result.success) throw new Error(`invalid secrets file ${this.path}: ${result.error.message}`);
    return result.data;
  }

  write(secrets: Secrets): void {
    this.assertPrivate();
    const json = JSON.stringify(secretsSchema.parse(secrets), null, 2);
    const tmp = `${this.path}.${process.pid}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openPrivate(tmp);
    try {
      writeSync(fd, json);
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      unlinkSync(tmp);
      throw error;
    }
    closeSync(fd);
    try {
      renameSync(tmp, this.path);
    } catch (error) {
      unlinkSync(tmp);
      throw error;
    }
  }

  private assertPrivate(): boolean {
    let mode: number;
    try {
      mode = statSync(this.path).mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if ((mode & 0o077) !== 0) {
      const octal = (mode & 0o777).toString(8).padStart(3, "0");
      throw new Error(`secrets file ${this.path} is mode ${octal}, readable by group or others. run: chmod 600 ${this.path}`);
    }
    return true;
  }
}

function openPrivate(path: string): number {
  try {
    return openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // the temp name carries this pid, so an existing file is left over from a dead process that had the same pid
  console.error(`removing stale secrets temp file ${path}`);
  unlinkSync(path);
  return openSync(path, "wx", 0o600);
}
