import type { CanaryFailure } from "../canary.js";
import { REPAIR_FOLDER } from "./guardrails.js";

export type RepairPromptInput = {
  failure: Pick<CanaryFailure, "stage" | "reason">;
  versions: { from?: string; to: string };
  branch: string;
};

const serverVersionOf = (label: string) => label.split("+orch")[0];

export function repairPrompt({ failure, versions, branch }: RepairPromptInput): string {
  return [
    "The t3-cardputer relay's approvals adapter broke after a T3 update. Fix it.",
    "",
    "What the live canary saw (verbatim):",
    `- canary stage: ${failure.stage}`,
    `- reason: ${failure.reason}`,
    `- old T3 version: ${versions.from ?? "unknown"}`,
    `- new T3 version: ${versions.to}`,
    "",
    "Rules:",
    `- Change ONLY files under ${REPAIR_FOLDER} (code, tests, fixtures). The relay auto-merges only that folder; anything else blocks the merge, including package.json, the lockfile and CI.`,
    `- Read T3's source for the new version at https://github.com/pingdotgg/t3code (the release for server version ${serverVersionOf(versions.to)}), starting with packages/contracts, and update the adapter to match its internal protocol.`,
    "- Run the tests with `cd relay && pnpm test` and make them pass.",
    `- Commit, push the branch ${branch}, and open a PR against main.`,
    "",
    "After CI passes, the relay re-runs the live canary against your PR's build. If it fails, the failure comes back to this thread; push a fix to the same branch.",
  ].join("\n");
}
