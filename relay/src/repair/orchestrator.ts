import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CanaryFailure } from "../canary.js";
import { CONFIG_PATH_ENV, SECRETS_PATH_ENV, type RelayConfig } from "../config.js";
import type { Exec } from "../exec.js";
import { SecretsStore } from "../secrets.js";
import type { T3Mcp } from "../t3/mcp.js";
import { canaryDownReason, type DownPhase } from "../version-watch.js";
import { REPAIR_BRANCH_PREFIX, REPAIR_FOLDER, STATUS_CHECK_PREFIX, checkMergeable, missingChecks, type PullRequestFacts } from "./guardrails.js";
import { repairPrompt } from "./prompt.js";

export const REPAIR_STATE_NAME = "repair.json";
const STAGING_PREFIX = "staging-";
const BASE_BRANCH = "main";
const GITHUB_HINT = "run `t3-cardputer-relay secrets set github`";
const PR_JSON_FIELDS = "number,url,headRefName,headRefOid,headRepository,headRepositoryOwner,statusCheckRollup";
const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/;
const PENDING = "pending";

type Failure = Pick<CanaryFailure, "stage" | "reason">;
type Versions = { from?: string; to: string };
type Broken = { failure: Failure; versions: Versions };

const attemptSchema = z.object({ attempt: z.number().int().positive(), branch: z.string(), startedAt: z.number(), threadId: z.string().optional() });
const versionStateSchema = z.object({
  attempts: z.number().int().nonnegative(),
  active: attemptSchema.optional(),
  merged: z.object({ pr: z.number().int(), sha: z.string() }).optional(),
});
const stateSchema = z.record(z.string(), versionStateSchema);

type Attempt = z.infer<typeof attemptSchema>;
type VersionState = z.infer<typeof versionStateSchema>;
type RepairState = z.infer<typeof stateSchema>;

const ghPrSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  headRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/, "expected a 40-hex commit sha"),
  headRepository: z.object({ name: z.string() }).nullish(),
  headRepositoryOwner: z.object({ login: z.string() }).nullish(),
  statusCheckRollup: z
    .array(
      z.discriminatedUnion("__typename", [
        z.object({ __typename: z.literal("CheckRun"), name: z.string(), status: z.string(), conclusion: z.string().nullish() }),
        z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string() }),
      ]),
    )
    .nullish(),
});

type OpenPr = { number: number; sha: string; facts: Omit<PullRequestFacts, "files">; ciDone: boolean };
type TrackOutcome = { kind: "merged" } | { kind: "closed" } | { kind: "timed_out"; status: string };

export type RepairDeps = {
  config: RelayConfig;
  secrets: Pick<SecretsStore, "read">;
  exec: Exec;
  t3: Pick<T3Mcp, "launch" | "send">;
  markApprovalsDown(reason: string, phase: DownPhase): void;
  setWarning(text: string | undefined): void;
  deploy(): Promise<void>;
};

export class RepairNotStartedError extends Error {
  override name = "RepairNotStartedError";
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const gaveUp = (attempts: number, to: string) => `approvals repair gave up after ${attempts} attempts for T3 ${to}`;
const refSafe = (label: string) => label.replace(/[^A-Za-z0-9._+-]+/g, "-").replace(/\.{2,}/g, ".");

function toOpenPr(raw: z.infer<typeof ghPrSchema>, requiredChecks: string[]): OpenPr {
  const checks = (raw.statusCheckRollup ?? []).map((item) =>
    item.__typename === "CheckRun"
      ? { name: item.name, conclusion: item.status === "COMPLETED" ? (item.conclusion ?? "").toLowerCase() : PENDING }
      : { name: `${STATUS_CHECK_PREFIX}${item.context}`, conclusion: item.state === "PENDING" || item.state === "EXPECTED" ? PENDING : item.state.toLowerCase() },
  );
  return {
    number: raw.number,
    sha: raw.headRefOid,
    facts: {
      headRepo: raw.headRepositoryOwner && raw.headRepository ? `${raw.headRepositoryOwner.login}/${raw.headRepository.name}` : "",
      baseRepo: PULL_URL.exec(raw.url)?.[1] ?? "",
      headRef: raw.headRefName,
      checks,
    },
    ciDone: checks.every((check) => check.conclusion !== PENDING) && missingChecks(checks, requiredChecks).length === 0,
  };
}

export class RepairOrchestrator {
  private readonly running = new Map<string, Promise<void>>();
  private readonly sleepers = new Set<() => void>();
  private closed = false;

  constructor(private readonly deps: RepairDeps) {
    this.removeStaleStaging();
  }

  onBroken(failure: Failure, versions: Versions): void {
    const { to } = versions;
    if (this.running.has(to)) return;
    const { repair } = this.deps.config;
    if (repair.projectId === undefined) this.refuse("approvals repair needs config key repair.projectId (the T3 project id of this repo) in relay.json");
    if (this.githubToken() === undefined) this.refuse(`approvals repair needs a GitHub token: ${GITHUB_HINT}`);

    let state: RepairState;
    try {
      state = this.load();
    } catch (error) {
      this.refuse(`approvals repair not started: ${messageOf(error)}`);
    }
    const broken: Broken = { failure, versions };
    const record = state[to];
    if (record?.active !== undefined) {
      this.spawn(broken, this.repairVersion(broken, record.active, false));
      return;
    }
    const attempts = record?.attempts ?? 0;
    if (attempts >= repair.maxAttemptsPerVersion) this.refuse(gaveUp(attempts, to));
    let attempt: Attempt;
    try {
      attempt = this.startAttempt(state, to);
    } catch (error) {
      this.refuse(`approvals repair not started: ${messageOf(error)}`);
    }
    this.spawn(broken, this.repairVersion(broken, attempt, true));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const wake of [...this.sleepers]) wake();
    await Promise.all(this.running.values());
  }

  private refuse(text: string): never {
    this.deps.setWarning(text);
    throw new RepairNotStartedError(text);
  }

  private downWithoutFix(failure: Failure, warning: string): void {
    console.error(warning);
    this.deps.setWarning(warning);
    this.deps.markApprovalsDown(canaryDownReason(failure), "none");
  }

  private spawn({ failure, versions: { to } }: Broken, work: Promise<void>): void {
    const run = work
      .catch((error: unknown) => this.downWithoutFix(failure, `approvals repair for T3 ${to} stopped: ${messageOf(error)}`))
      .finally(() => this.running.delete(to));
    this.running.set(to, run);
  }

  private startAttempt(state: RepairState, to: string): Attempt {
    const attempts = (state[to]?.attempts ?? 0) + 1;
    const attempt: Attempt = { attempt: attempts, branch: `${REPAIR_BRANCH_PREFIX}t3-${refSafe(to)}-${attempts}`, startedAt: Date.now() };
    this.save({ ...state, [to]: { ...state[to], attempts, active: attempt } });
    this.deps.setWarning(undefined);
    return attempt;
  }

  private async repairVersion(broken: Broken, first: Attempt, launchFirst: boolean): Promise<void> {
    const { to } = broken.versions;
    let attempt: Attempt | undefined = first;
    let launch = launchFirst;
    while (attempt !== undefined && !this.closed) {
      if (launch) attempt = await this.launch(broken, attempt);
      if (attempt === undefined) return;
      const outcome = await this.track(broken, attempt);
      if (outcome.kind !== "timed_out") return;
      console.error(
        `approvals repair for T3 ${to}, attempt ${attempt.attempt} timed out: repairAttemptTimeoutMs=${this.deps.config.limits.repairAttemptTimeoutMs}, last status: ${outcome.status}`,
      );
      attempt = this.nextAttempt(broken);
      launch = true;
    }
  }

  private nextAttempt({ failure, versions: { to } }: Broken): Attempt | undefined {
    const state = this.load();
    const record = state[to];
    const attempts = record?.attempts ?? 0;
    const { active: _ended, ...rest } = record ?? { attempts };
    const ended: RepairState = { ...state, [to]: rest };
    if (attempts >= this.deps.config.repair.maxAttemptsPerVersion) {
      this.save(ended);
      this.downWithoutFix(failure, gaveUp(attempts, to));
      return undefined;
    }
    return this.startAttempt(ended, to);
  }

  private async launch({ failure, versions }: Broken, attempt: Attempt): Promise<Attempt | undefined> {
    const { to } = versions;
    const { repair } = this.deps.config;
    let threadId: string;
    try {
      ({ threadId } = await this.deps.t3.launch({
        projectId: repair.projectId!,
        title: `repair approvals for T3 ${to}`,
        message: repairPrompt({ failure, versions, branch: attempt.branch }),
        model: repair.model,
        workspace: "worktree",
        baseRef: BASE_BRANCH,
        branch: attempt.branch,
        runtimeMode: "full-access",
      }));
    } catch (error) {
      this.update(to, (record) => {
        const { active: _failed, ...rest } = record;
        return { ...rest, attempts: record.attempts - 1 };
      });
      this.downWithoutFix(failure, `approvals repair could not launch for T3 ${to}: ${messageOf(error)}`);
      return undefined;
    }
    const launched = { ...attempt, threadId };
    console.log(`approvals repair for T3 ${to}: attempt ${attempt.attempt} launched thread ${threadId} on ${attempt.branch}`);
    this.update(to, (record) => ({ ...record, active: launched }));
    return launched;
  }

  private async track(broken: Broken, attempt: Attempt): Promise<TrackOutcome> {
    const { to } = broken.versions;
    const { limits } = this.deps.config;
    const deadline = attempt.startedAt + limits.repairAttemptTimeoutMs;
    let status = `waiting for a PR from ${attempt.branch}`;
    let evaluatedSha: string | undefined;
    let pollFailing = false;
    while (!this.closed) {
      if (Date.now() >= deadline) return { kind: "timed_out", status };
      let next = status;
      let failing = false;
      try {
        const { own, forks } = await this.findPr(attempt.branch);
        if (own === undefined) {
          next = forks.length === 0 ? `no open PR from ${attempt.branch} yet` : `ignoring fork PR ${forks.map((n) => `#${n}`).join(", ")} on ${attempt.branch}`;
        } else if (own.sha !== evaluatedSha) {
          if (!own.ciDone) {
            next = `PR #${own.number} waiting on CI (${own.facts.checks.length} checks reported)`;
          } else {
            const result = await this.evaluate(broken, attempt, own);
            evaluatedSha = own.sha;
            if (result === "merged") return { kind: "merged" };
            next = result;
          }
        }
      } catch (error) {
        next = `PR poll failed: ${messageOf(error)}`;
        failing = true;
      }
      if (failing || pollFailing) this.deps.setWarning(failing ? `approvals repair for T3 ${to}: ${next}` : undefined);
      pollFailing = failing;
      if (next !== status) {
        console.log(`approvals repair for T3 ${to}, attempt ${attempt.attempt}: ${next}`);
        status = next;
      }
      await this.sleep(limits.repairPollIntervalMs);
    }
    return { kind: "closed" };
  }

  private async findPr(branch: string): Promise<{ own?: OpenPr; forks: number[] }> {
    const { githubRepo } = this.deps.config.repair;
    const out = await this.gh(["pr", "list", "--repo", githubRepo, "--head", branch, "--base", BASE_BRANCH, "--state", "open", "--json", PR_JSON_FIELDS]);
    const { requiredChecks } = this.deps.config.repair;
    const prs = z
      .array(ghPrSchema)
      .parse(JSON.parse(out))
      .map((raw) => toOpenPr(raw, requiredChecks));
    const own = prs.find((pr) => pr.facts.headRepo === githubRepo);
    const forks = prs.filter((pr) => pr !== own).map((pr) => pr.number);
    return own === undefined ? { forks } : { own, forks };
  }

  private async evaluate({ failure, versions: { to } }: Broken, attempt: Attempt, pr: OpenPr): Promise<"merged" | string> {
    const { githubRepo, requiredChecks } = this.deps.config.repair;
    const files = await this.changedFiles(pr.sha);
    const verdict = checkMergeable({ ...pr.facts, files }, { repo: githubRepo, branch: attempt.branch, requiredChecks });
    if (!verdict.ok) {
      await this.tell(
        attempt,
        [
          `The relay will not merge PR #${pr.number} at ${pr.sha}:`,
          ...verdict.reasons.map((reason) => `- ${reason}`),
          `Only ${REPAIR_FOLDER} may change and every CI check must pass. Push a fix to ${attempt.branch}.`,
        ].join("\n"),
      );
      return `PR #${pr.number} blocked by guardrails: ${verdict.reasons.join("; ")}`;
    }

    const staging = await this.stagingCanary(pr.sha);
    if (!staging.ok) {
      await this.tell(
        attempt,
        `The staging canary failed on PR #${pr.number} at ${pr.sha}, so the relay did not merge it:\n${staging.failure}\nPush a fix to ${attempt.branch}; the canary re-runs on the new commit.`,
      );
      return `PR #${pr.number} staging canary failed: ${staging.failure}`;
    }

    try {
      await this.gh(["pr", "merge", String(pr.number), "--repo", githubRepo, "--squash", "--match-head-commit", pr.sha]);
    } catch (error) {
      const why = `PR #${pr.number} passed every guardrail but the merge failed: ${messageOf(error)}`;
      console.error(`approvals repair for T3 ${to}: ${why}`, error);
      this.deps.setWarning(`approvals repair for T3 ${to}: ${why}`);
      return why;
    }
    console.log(`approvals repair for T3 ${to}: merged PR #${pr.number} at ${pr.sha}, deploying`);
    this.update(to, (record) => {
      const { active: _merged, ...rest } = record;
      return { ...rest, merged: { pr: pr.number, sha: pr.sha } };
    });
    try {
      await this.deps.deploy();
    } catch (error) {
      this.downWithoutFix(failure, `approvals repair merged PR #${pr.number} for T3 ${to} but the deploy failed: ${messageOf(error)}`);
    }
    return "merged";
  }

  private async changedFiles(sha: string): Promise<string[]> {
    const { deployDir } = this.deps.config.repair;
    await this.step("git", ["fetch", "--no-tags", "origin", BASE_BRANCH, sha], deployDir);
    const out = await this.step("git", ["diff", "--name-only", "--no-renames", "-z", `origin/${BASE_BRANCH}...${sha}`], deployDir);
    return out.split("\0").filter((file) => file !== "");
  }

  private async stagingCanary(sha: string): Promise<{ ok: true } | { ok: false; failure: string }> {
    const { config } = this.deps;
    const { deployDir } = config.repair;
    mkdirSync(config.stateDir, { recursive: true });
    const dir = mkdtempSync(join(config.stateDir, STAGING_PREFIX));
    const worktree = join(dir, "worktree");
    const relayDir = join(worktree, "relay");
    let added = false;
    try {
      const configPath = join(dir, "relay.json");
      writeFileSync(configPath, JSON.stringify({ ...config, stateDir: join(dir, "state") }, null, 2));
      const secretsPath = join(dir, "secrets.json");
      this.writeStagingSecrets(secretsPath);
      await this.step("git", ["worktree", "add", "--detach", worktree, sha], deployDir);
      added = true;
      try {
        await this.step("pnpm", ["install", "--frozen-lockfile"], relayDir);
        await this.step("pnpm", ["build"], relayDir);
        await this.deps.exec(process.execPath, ["dist/cli.js", "canary"], {
          cwd: relayDir,
          env: { [CONFIG_PATH_ENV]: configPath, [SECRETS_PATH_ENV]: secretsPath },
          timeoutMs: config.limits.canaryTimeoutMs + config.limits.repairStepTimeoutMs,
          timeoutName: "canaryTimeoutMs+repairStepTimeoutMs",
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: messageOf(error) };
      }
    } finally {
      if (added) {
        await this.step("git", ["worktree", "remove", "--force", worktree], deployDir).catch((error: unknown) => {
          console.error(`could not remove staging worktree ${worktree}`, error);
        });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private writeStagingSecrets(path: string): void {
    const { t3McpToken, t3InternalToken } = this.deps.secrets.read();
    new SecretsStore(path).write({ ...(t3McpToken ? { t3McpToken } : {}), ...(t3InternalToken ? { t3InternalToken } : {}), devices: [] });
  }

  private githubToken(): string | undefined {
    return this.deps.secrets.read().githubToken;
  }

  private async tell(attempt: Attempt, text: string): Promise<void> {
    if (attempt.threadId === undefined) {
      console.error(`approvals repair on ${attempt.branch} has no known thread id, could not send: ${text}`);
      return;
    }
    try {
      await this.deps.t3.send(attempt.threadId, text, "queue", randomUUID());
    } catch (error) {
      console.error(`could not send to repair thread ${attempt.threadId}: ${text}`, error);
    }
  }

  private gh(args: string[]): Promise<string> {
    const token = this.githubToken();
    if (token === undefined) return Promise.reject(new Error(`no GitHub token: ${GITHUB_HINT}`));
    return this.deps.exec("gh", args, { env: { GH_TOKEN: token }, timeoutMs: this.deps.config.limits.repairStepTimeoutMs, timeoutName: "repairStepTimeoutMs" });
  }

  private step(file: string, args: string[], cwd: string): Promise<string> {
    return this.deps.exec(file, args, { cwd, timeoutMs: this.deps.config.limits.repairStepTimeoutMs, timeoutName: "repairStepTimeoutMs" });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  private get statePath(): string {
    return join(this.deps.config.stateDir, REPAIR_STATE_NAME);
  }

  private load(): RepairState {
    let text: string;
    try {
      text = readFileSync(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const result = stateSchema.safeParse(JSON.parse(text));
    if (!result.success) throw new Error(`invalid repair state ${this.statePath}: ${result.error.message}`);
    return result.data;
  }

  private save(state: RepairState): void {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    try {
      mkdirSync(this.deps.config.stateDir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, this.statePath);
    } catch (error) {
      throw new Error(`could not save repair state ${this.statePath}: ${messageOf(error)}`, { cause: error });
    }
  }

  private update(to: string, change: (record: VersionState) => VersionState): void {
    try {
      const state = this.load();
      const record = state[to];
      if (record !== undefined) this.save({ ...state, [to]: change(record) });
    } catch (error) {
      console.error(`approvals repair for T3 ${to}: ${messageOf(error)}`, error);
    }
  }

  private removeStaleStaging(): void {
    let names: string[];
    try {
      names = readdirSync(this.deps.config.stateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`could not list ${this.deps.config.stateDir} for stale staging copies`, error);
      return;
    }
    for (const name of names) {
      if (name.startsWith(STAGING_PREFIX)) rmSync(join(this.deps.config.stateDir, name), { recursive: true, force: true });
    }
  }
}
