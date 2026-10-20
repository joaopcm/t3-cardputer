export const REPAIR_FOLDER = "relay/src/approvals/";
export const REPAIR_BRANCH_PREFIX = "repair/";
export const STATUS_CHECK_PREFIX = "status:";

export type PullRequestFacts = {
  headRepo: string;
  baseRepo: string;
  headRef: string;
  files: string[];
  checks: { name: string; conclusion: string }[];
};
export type Mergeable = { ok: true } | { ok: false; reasons: string[] };

const PRINTABLE_PATH = /^[\x20-\x7e]+$/;

export function insideRepairFolder(path: string): boolean {
  if (!PRINTABLE_PATH.test(path) || path.includes("\\") || !path.startsWith(REPAIR_FOLDER)) return false;
  return path
    .slice(REPAIR_FOLDER.length)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const shown = (path: string) => (PRINTABLE_PATH.test(path) && !path.includes("\\") ? path : JSON.stringify(path));

export function missingChecks(checks: PullRequestFacts["checks"], required: string[]): string[] {
  return required.filter((name) => !checks.some((check) => check.name === name));
}

export function checkMergeable(pr: PullRequestFacts, expected: { repo: string; branch: string; requiredChecks: string[] }): Mergeable {
  const reasons: string[] = [];
  if (pr.headRepo !== expected.repo || pr.baseRepo !== expected.repo) {
    reasons.push(`no forks: head repo ${JSON.stringify(pr.headRepo)} and base repo ${JSON.stringify(pr.baseRepo)} must both be ${JSON.stringify(expected.repo)}`);
  }
  if (!expected.branch.startsWith(REPAIR_BRANCH_PREFIX)) {
    reasons.push(`branch: the relay only merges its own ${REPAIR_BRANCH_PREFIX} branches, not ${JSON.stringify(expected.branch)}`);
  } else if (pr.headRef !== expected.branch) {
    reasons.push(`branch: head ${JSON.stringify(pr.headRef)} is not the branch the relay created, ${JSON.stringify(expected.branch)}`);
  }
  if (pr.files.length === 0) {
    reasons.push("files: none changed, nothing to merge");
  } else {
    const outside = pr.files.filter((file) => !insideRepairFolder(file));
    if (outside.length > 0) reasons.push(`files outside ${REPAIR_FOLDER}: ${outside.map(shown).join(", ")}`);
  }
  if (pr.checks.length === 0) {
    reasons.push("checks: none reported, CI must run and pass");
  } else {
    const failing = pr.checks.filter((check) => check.conclusion !== "success");
    if (failing.length > 0) reasons.push(`checks not successful: ${failing.map((check) => `${check.name} (${check.conclusion})`).join(", ")}`);
  }
  if (expected.requiredChecks.length === 0) {
    reasons.push("required checks: none configured, set repair.requiredChecks to the CI job names");
  } else if (pr.checks.length > 0) {
    const missing = missingChecks(pr.checks, expected.requiredChecks);
    if (missing.length > 0) reasons.push(`required checks missing: ${missing.join(", ")}`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
