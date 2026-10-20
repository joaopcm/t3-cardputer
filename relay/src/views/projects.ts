import { RUNTIME_MODES, type RelayMessage } from "../protocol/messages.js";
import type { T3Project } from "../t3/mcp.js";
import type { ProjectDefaults } from "../defaults-store.js";
import { oneLine } from "./one-line.js";

export type ProjectsMessage = Extract<RelayMessage, { type: "projects" }>;
export type ProjectsBudget = { maxRows: number; maxFrameBytes: number; activity: ReadonlyMap<string, number> };

type RuntimeMode = ProjectsMessage["items"][number]["defaults"]["runtimeMode"];
type Item = ProjectsMessage["items"][number];

export function buildProjects(
  projects: T3Project[],
  defaults: { get(projectId: string): ProjectDefaults | undefined },
  fallback: ProjectDefaults,
  budget: ProjectsBudget,
): ProjectsMessage {
  const lastActive = (project: T3Project) => Math.max(budget.activity.get(project.projectId) ?? 0, project.updatedAt === undefined ? 0 : Date.parse(project.updatedAt) || 0);
  const items = [...projects].sort((a, b) => lastActive(b) - lastActive(a)).map((project): Item => {
    const chosen = defaults.get(project.projectId) ?? fallback;
    const runtimeMode = RUNTIME_MODES.find((mode) => mode === chosen.runtimeMode) ?? knownMode(fallback.runtimeMode);
    return {
      projectId: project.projectId,
      name: oneLine(project.name),
      defaults: { model: oneLine(chosen.model), workspace: chosen.workspace, runtimeMode },
    };
  });

  const all: ProjectsMessage = { type: "projects", items };
  if (items.length <= budget.maxRows && bytes(all) <= budget.maxFrameBytes) return all;
  const byBytes = { budget: "maxFrameBytes", limit: budget.maxFrameBytes, actual: bytes(all) };
  let truncated = items.length > budget.maxRows ? { budget: "maxHomeRows", limit: budget.maxRows, actual: items.length } : byBytes;
  for (let kept = Math.min(items.length, budget.maxRows); ; kept--) {
    const candidate: ProjectsMessage = { type: "projects", items: items.slice(0, kept), truncated: { ...truncated, hidden: items.length - kept } };
    if (bytes(candidate) <= budget.maxFrameBytes) return candidate;
    if (kept === 0) throw new RangeError(`projects frame budget: maxFrameBytes=${budget.maxFrameBytes}, an empty project list needed ${bytes(candidate)}`);
    truncated = byBytes;
  }
}

function bytes(msg: ProjectsMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), "utf8");
}

function knownMode(mode: string): RuntimeMode {
  const known = RUNTIME_MODES.find((m) => m === mode);
  if (known === undefined) throw new RangeError(`fallback runtimeMode "${mode}" is not one of ${RUNTIME_MODES.join(", ")}`);
  return known;
}
