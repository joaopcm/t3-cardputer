import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { WORKSPACES } from "./protocol/messages.js";

const projectDefaultsSchema = z.object({
  model: z.string().min(1),
  workspace: z.enum(WORKSPACES),
  runtimeMode: z.string().min(1),
});
const defaultsFileSchema = z.record(z.string(), projectDefaultsSchema);

export type ProjectDefaults = z.infer<typeof projectDefaultsSchema>;

export class DefaultsStore {
  private cache: Record<string, ProjectDefaults> | undefined;

  constructor(private readonly path: string) {}

  get(projectId: string): ProjectDefaults | undefined {
    return this.load()[projectId];
  }

  remember(projectId: string, defaults: ProjectDefaults): void {
    const next = { ...this.load(), [projectId]: projectDefaultsSchema.parse(defaults) };
    this.persist(next);
    this.cache = next;
  }

  private load(): Record<string, ProjectDefaults> {
    if (this.cache !== undefined) return this.cache;
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache = {};
      return this.cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid defaults file ${this.path}: not valid JSON (${(error as Error).message})`);
    }
    const result = defaultsFileSchema.safeParse(parsed);
    if (!result.success) throw new Error(`invalid defaults file ${this.path}: ${result.error.message}`);
    this.cache = result.data;
    return this.cache;
  }

  private persist(defaults: Record<string, ProjectDefaults>): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(defaults, null, 2));
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
}
