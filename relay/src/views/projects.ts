import { RUNTIME_MODES, type RelayMessage } from "../protocol/messages.js";
import type { T3Project } from "../t3/mcp.js";
import type { ProjectDefaults } from "../defaults-store.js";
import { oneLine } from "./one-line.js";

export type ProjectsMessage = Extract<RelayMessage, { type: "projects" }>;

type RuntimeMode = ProjectsMessage["items"][number]["defaults"]["runtimeMode"];

export function buildProjects(
  projects: T3Project[],
  defaults: { get(projectId: string): ProjectDefaults | undefined },
  fallback: ProjectDefaults,
): ProjectsMessage {
  return {
    type: "projects",
    items: projects.map((project) => {
      const chosen = defaults.get(project.projectId) ?? fallback;
      const runtimeMode = RUNTIME_MODES.find((mode) => mode === chosen.runtimeMode) ?? knownMode(fallback.runtimeMode);
      return {
        projectId: project.projectId,
        name: oneLine(project.name),
        defaults: { model: oneLine(chosen.model), workspace: chosen.workspace, runtimeMode },
      };
    }),
  };
}

function knownMode(mode: string): RuntimeMode {
  const known = RUNTIME_MODES.find((m) => m === mode);
  if (known === undefined) throw new RangeError(`fallback runtimeMode "${mode}" is not one of ${RUNTIME_MODES.join(", ")}`);
  return known;
}
