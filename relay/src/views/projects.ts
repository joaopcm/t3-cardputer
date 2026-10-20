import { MODEL_LABEL_MAX, RUNTIME_MODES, type RelayMessage } from "../protocol/messages.js";
import type { T3Model, T3Project } from "../t3/mcp.js";
import type { ProjectDefaults } from "../defaults-store.js";
import { oneLine } from "./one-line.js";

export type ProjectsMessage = Extract<RelayMessage, { type: "projects" }>;
export type ProjectsBudget = { maxRows: number; maxFrameBytes: number; activity: ReadonlyMap<string, number> };

type RuntimeMode = ProjectsMessage["items"][number]["defaults"]["runtimeMode"];
type Item = ProjectsMessage["items"][number];
type Model = NonNullable<ProjectsMessage["models"]>[number];

export function buildProjects(
  projects: T3Project[],
  defaults: { get(projectId: string): ProjectDefaults | undefined },
  fallback: ProjectDefaults,
  budget: ProjectsBudget,
  catalog: readonly T3Model[] = [],
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

  const models = catalog.map(toModel);
  for (let kept = models.length; kept > 0; kept--) {
    const fitted = fit(items, models.slice(0, kept), budget, Math.min(items.length, 1));
    if (fitted) return fitted;
  }
  const fitted = fit(items, [], budget, 0);
  if (fitted) return fitted;
  const empty: ProjectsMessage = { type: "projects", items: [], truncated: { budget: "maxFrameBytes", limit: budget.maxFrameBytes, actual: budget.maxFrameBytes, hidden: items.length } };
  throw new RangeError(`projects frame budget: maxFrameBytes=${budget.maxFrameBytes}, an empty project list needed ${bytes(empty)}`);
}

function fit(items: Item[], models: Model[], budget: ProjectsBudget, minKept: number): ProjectsMessage | undefined {
  const all = withModels({ type: "projects", items }, models);
  if (items.length <= budget.maxRows && bytes(all) <= budget.maxFrameBytes) return all;
  const byBytes = { budget: "maxFrameBytes", limit: budget.maxFrameBytes, actual: bytes(all) };
  let truncated = items.length > budget.maxRows ? { budget: "maxHomeRows", limit: budget.maxRows, actual: items.length } : byBytes;
  for (let kept = Math.min(items.length, budget.maxRows); kept >= minKept; kept--) {
    const candidate = withModels({ type: "projects", items: items.slice(0, kept), truncated: { ...truncated, hidden: items.length - kept } }, models);
    if (bytes(candidate) <= budget.maxFrameBytes) return candidate;
    truncated = byBytes;
  }
  return undefined;
}

function toModel(model: T3Model): Model {
  const label = oneLine(model.label) || oneLine(model.id) || "?";
  return { id: model.id, label: label.length <= MODEL_LABEL_MAX ? label : `${label.slice(0, MODEL_LABEL_MAX - 1).trimEnd()}~` };
}

function withModels(msg: ProjectsMessage, models: Model[]): ProjectsMessage {
  return models.length === 0 ? msg : { ...msg, models };
}

function bytes(msg: ProjectsMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), "utf8");
}

function knownMode(mode: string): RuntimeMode {
  const known = RUNTIME_MODES.find((m) => m === mode);
  if (known === undefined) throw new RangeError(`fallback runtimeMode "${mode}" is not one of ${RUNTIME_MODES.join(", ")}`);
  return known;
}
