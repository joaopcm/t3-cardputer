import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_LIMITS, type RelayConfig } from "../src/config.js";
import { DEPLOYED_STATE_NAME, deploy } from "../src/deploy.js";
import { execRunner, type Exec, type ExecOptions } from "../src/exec.js";
import { REPAIR_STATE_NAME, RepairOrchestrator, type RepairDeps } from "../src/repair/orchestrator.js";
import { repairPrompt } from "../src/repair/prompt.js";
import type { T3LaunchInput } from "../src/t3/mcp.js";

const TO = "0.0.27+orch3";
const FROM = "0.0.26+orch3";
const FAILURE = { stage: "approval_seen" as const, reason: "no approval appeared for thread t-9: canaryTimeoutMs=32165, waited 32170 ms" };
const BRANCH = `repair/t3-${TO}-1`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "github_pat_fake_for_tests";
const MCP_TOKEN = { token: "mcp-fake", expiresAt: "2099-01-01T00:00:00.000Z" };
const INTERNAL_TOKEN = { token: "internal-fake", expiresAt: "2099-01-01T00:00:00.000Z" };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Call = { file: string; args: string[]; options: ExecOptions };

function ghPr(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    url: "https://github.com/joaopcm/t3-cardputer/pull/7",
    headRefName: BRANCH,
    headRefOid: SHA,
    headRepository: { name: "t3-cardputer" },
    headRepositoryOwner: { login: "joaopcm" },
    statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  };
}

type Script = {
  prs?: () => unknown[];
  files?: () => string[];
  canary?: (call: Call) => void;
  merge?: () => void;
};

function fakeExec(script: Script = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    const verb = `${file === process.execPath ? "node" : file} ${args[0] ?? ""}`;
    switch (verb) {
      case "gh pr":
        if (args[1] === "list") return JSON.stringify(script.prs?.() ?? []);
        if (args[1] === "merge") {
          script.merge?.();
          return "";
        }
        break;
      case "git fetch":
      case "git worktree":
        return "";
      case "git diff":
        return (script.files?.() ?? ["relay/src/approvals/internal-ws.ts"]).map((f) => `${f}\0`).join("");
      case "pnpm install":
      case "pnpm build":
        return "";
      case "node dist/cli.js":
        script.canary?.(call);
        return "canary passed in 5900 ms\n";
    }
    throw new Error(`unexpected exec ${file} ${args.join(" ")}`);
  };
  return { exec, calls, verbs: () => calls.map((c) => `${c.file === process.execPath ? "node" : c.file} ${c.args.join(" ")}`) };
}

function harness(opts: { config?: (config: RelayConfig) => RelayConfig; script?: Script; token?: string | undefined; root?: string } = {}) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "relay-repair-"));
  const base: RelayConfig = {
    ...DEFAULT_CONFIG,
    stateDir: join(root, "state"),
    repair: { ...DEFAULT_CONFIG.repair, projectId: "project-t3-cardputer", maxAttemptsPerVersion: 2, deployDir: join(root, "deploy") },
    limits: { ...DEFAULT_LIMITS, repairPollIntervalMs: 1, repairAttemptTimeoutMs: 60_000, repairStepTimeoutMs: 1000 },
  };
  const config = opts.config ? opts.config(base) : base;
  const fake = fakeExec(opts.script);
  const launches: T3LaunchInput[] = [];
  const sends: { threadId: string; text: string; mode: string }[] = [];
  const warnings: (string | undefined)[] = [];
  const downs: { reason: string; phase: string }[] = [];
  const deploys: number[] = [];
  let launchError: Error | undefined;
  const deps: RepairDeps = {
    config,
    exec: fake.exec,
    secrets: {
      read: () => {
        const githubToken = "token" in opts ? opts.token : TOKEN;
        return {
          t3McpToken: MCP_TOKEN,
          t3InternalToken: INTERNAL_TOKEN,
          ...(githubToken === undefined ? {} : { githubToken }),
          devices: [{ id: "d1", name: "adv", tokenSha256: "ab".repeat(32), createdAt: "2026-10-20T00:00:00.000Z" }],
        };
      },
    },
    t3: {
      async launch(input) {
        if (launchError) throw launchError;
        launches.push(input);
        return { threadId: `thread-${launches.length}` };
      },
      async send(threadId, text, mode) {
        sends.push({ threadId, text, mode });
      },
    },
    markApprovalsDown: (reason, phase) => downs.push({ reason, phase }),
    setWarning: (text) => warnings.push(text),
    deploy: async () => {
      deploys.push(Date.now());
    },
  };
  const orchestrator = new RepairOrchestrator(deps);
  orchestrators.push(orchestrator);
  return {
    root,
    config,
    orchestrator,
    ...fake,
    launches,
    sends,
    warnings,
    downs,
    deploys,
    failLaunch: (error: Error | undefined) => (launchError = error),
  };
}

const orchestrators: RepairOrchestrator[] = [];
afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) await orchestrator.close();
});

describe("repairPrompt", () => {
  it("carries the failure verbatim, both versions, the boundary, the source, the test command and the PR instructions", () => {
    const prompt = repairPrompt({ failure: FAILURE, versions: { from: FROM, to: TO }, branch: BRANCH });
    expect(prompt).toContain(`canary stage: approval_seen`);
    expect(prompt).toContain(FAILURE.reason);
    expect(prompt).toContain(`old T3 version: ${FROM}`);
    expect(prompt).toContain(`new T3 version: ${TO}`);
    expect(prompt).toContain("relay/src/approvals/");
    expect(prompt).toMatch(/anything else blocks the merge/);
    expect(prompt).toContain("github.com/pingdotgg/t3code");
    expect(prompt).toContain("packages/contracts");
    expect(prompt).toContain("cd relay && pnpm test");
    expect(prompt).toContain(`push the branch ${BRANCH}`);
    expect(prompt).toContain("open a PR against main");
    expect(prompt).toContain("re-runs the live canary against your PR's build");
  });

  it("says the old version is unknown on a first run", () => {
    expect(repairPrompt({ failure: FAILURE, versions: { to: TO }, branch: BRANCH })).toContain("old T3 version: unknown");
  });
});

describe("RepairOrchestrator", () => {
  it("orchestrator launches one repair thread per T3 version", async () => {
    const h = harness();
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.launches).toHaveLength(1));
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await pause(20);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toEqual({
      projectId: "project-t3-cardputer",
      title: `repair approvals for T3 ${TO}`,
      message: repairPrompt({ failure: FAILURE, versions: { from: FROM, to: TO }, branch: BRANCH }),
      model: "claude-opus-5-5",
      workspace: "worktree",
      baseRef: "main",
      branch: BRANCH,
      runtimeMode: "full-access",
    });

    h.orchestrator.onBroken(FAILURE, { from: TO, to: "0.0.28+orch3" });
    await vi.waitFor(() => expect(h.launches).toHaveLength(2));
    expect(h.launches[1]!.branch).toBe("repair/t3-0.0.28+orch3-1");
  });

  it("dedupes across a relay restart through the state file", async () => {
    const first = harness();
    first.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(first.launches).toHaveLength(1));
    await first.orchestrator.close();
    const state = JSON.parse(readFileSync(join(first.config.stateDir, REPAIR_STATE_NAME), "utf8"));
    expect(state[TO]).toMatchObject({ attempts: 1, active: { attempt: 1, branch: BRANCH, threadId: "thread-1" } });

    const second = harness({ root: first.root });
    second.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(second.verbs().some((v) => v.startsWith("gh pr list"))).toBe(true));
    expect(second.launches).toHaveLength(0);
  });

  it("orchestrator stops after maxAttemptsPerVersion and adds the warning", async () => {
    const h = harness({ config: (c) => ({ ...c, limits: { ...c.limits, repairAttemptTimeoutMs: 15 } }) });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    const gaveUp = `approvals repair gave up after 2 attempts for T3 ${TO}`;
    await vi.waitFor(() => expect(h.warnings).toContain(gaveUp));
    expect(h.launches.map((l) => l.branch)).toEqual([`repair/t3-${TO}-1`, `repair/t3-${TO}-2`]);
    expect(h.downs).toContainEqual({ reason: `canary approval_seen: ${FAILURE.reason}`, phase: "none" });

    expect(() => h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO })).toThrow(gaveUp);
    await pause(20);
    expect(h.launches).toHaveLength(2);
  });

  it("failed staging canary sends the failure to the repair thread instead of merging", async () => {
    const h = harness({
      script: {
        prs: () => [ghPr()],
        canary: () => {
          throw new Error("node dist/cli.js canary failed: exit 1: canary failed at respond (broken): decision not accepted");
        },
      },
    });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    expect(h.sends[0]).toMatchObject({ threadId: "thread-1", mode: "queue" });
    expect(h.sends[0]!.text).toContain("staging canary failed");
    expect(h.sends[0]!.text).toContain("decision not accepted");
    expect(h.sends[0]!.text).toContain(SHA);
    await pause(30);
    expect(h.sends).toHaveLength(1);
    expect(h.verbs().filter((v) => v.startsWith("node dist/cli.js"))).toHaveLength(1);
    expect(h.verbs().some((v) => v.startsWith("gh pr merge"))).toBe(false);
    expect(h.deploys).toHaveLength(0);
    expect(h.verbs()).toContainEqual(expect.stringMatching(/^git worktree remove --force .*staging-.*\/worktree$/));
    expect(readdirSync(h.config.stateDir).filter((name) => name.startsWith("staging-"))).toEqual([]);
  });

  it("merges a guarded, CI-green, canary-passing PR at the checked commit, then deploys", async () => {
    let staged: { config: RelayConfig; env: Record<string, string>; secrets: unknown; secretsMode: number } | undefined;
    const h = harness({
      script: {
        prs: () => [ghPr()],
        files: () => ["relay/src/approvals/internal-ws.ts", "relay/src/approvals/internal-ws.test.ts"],
        canary: (call) => {
          const env = call.options.env!;
          staged = {
            config: JSON.parse(readFileSync(env.T3_CARDPUTER_RELAY_CONFIG!, "utf8")),
            env,
            secrets: JSON.parse(readFileSync(env.T3_CARDPUTER_RELAY_SECRETS!, "utf8")),
            secretsMode: statSync(env.T3_CARDPUTER_RELAY_SECRETS!).mode & 0o777,
          };
        },
      },
    });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.deploys).toHaveLength(1));

    const deployDir = h.config.repair.deployDir;
    const verbs = h.verbs();
    expect(verbs).toEqual([
      `gh pr list --repo joaopcm/t3-cardputer --head ${BRANCH} --base main --state open --json number,url,headRefName,headRefOid,headRepository,headRepositoryOwner,statusCheckRollup`,
      `git fetch --no-tags origin main ${SHA}`,
      `git diff --name-only --no-renames -z origin/main...${SHA}`,
      expect.stringMatching(new RegExp(`^git worktree add --detach .*/staging-[^/]+/worktree ${SHA}$`)),
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "node dist/cli.js canary",
      expect.stringMatching(/^git worktree remove --force .*\/worktree$/),
      `gh pr merge 7 --repo joaopcm/t3-cardputer --squash --match-head-commit ${SHA}`,
    ]);
    const byVerb = (prefix: string) => h.calls.find((c) => `${c.file === process.execPath ? "node" : c.file} ${c.args.join(" ")}`.startsWith(prefix))!;
    expect(byVerb("git fetch").options.cwd).toBe(deployDir);
    expect(byVerb("pnpm install").options.cwd).toMatch(/\/staging-[^/]+\/worktree\/relay$/);
    expect(byVerb("node dist/cli.js").options.cwd).toMatch(/\/staging-[^/]+\/worktree\/relay$/);

    for (const call of h.calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
      if (call.file === "gh") expect(call.options.env).toEqual({ GH_TOKEN: TOKEN });
      else expect(call.options.env?.GH_TOKEN).toBeUndefined();
    }

    expect(staged!.config.stateDir).not.toBe(h.config.stateDir);
    expect(staged!.config.stateDir).toMatch(/\/staging-[^/]+\/state$/);
    expect({ ...staged!.config, stateDir: h.config.stateDir }).toEqual(h.config);
    expect(staged!.env.T3_CARDPUTER_RELAY_SECRETS).toMatch(/\/staging-[^/]+\/secrets\.json$/);
    expect(staged!.secrets).toEqual({ t3McpToken: MCP_TOKEN, t3InternalToken: INTERNAL_TOKEN, devices: [] });
    expect(JSON.stringify(staged!.secrets)).not.toContain(TOKEN);
    expect(staged!.secretsMode).toBe(0o600);
    expect(existsSync(staged!.env.T3_CARDPUTER_RELAY_SECRETS!)).toBe(false);

    const state = JSON.parse(readFileSync(join(h.config.stateDir, REPAIR_STATE_NAME), "utf8"));
    expect(state[TO].active).toBeUndefined();
    expect(state[TO].merged).toEqual({ pr: 7, sha: SHA });
  });

  it("a PR touching files outside the folder is reported to the repair thread and never built", async () => {
    const h = harness({ script: { prs: () => [ghPr()], files: () => ["relay/src/approvals/rpc.ts", "relay/src/server.ts", ".github/workflows/ci.yml"] } });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    expect(h.sends[0]!.text).toContain("relay/src/server.ts");
    expect(h.sends[0]!.text).toContain(".github/workflows/ci.yml");
    expect(h.sends[0]!.text).toContain("PR #7");
    await pause(20);
    expect(h.sends).toHaveLength(1);
    expect(h.verbs().some((v) => v.startsWith("git worktree") || v.startsWith("pnpm") || v.startsWith("gh pr merge"))).toBe(false);
  });

  it("a red CI check is reported to the repair thread by name", async () => {
    const h = harness({
      script: {
        prs: () => [ghPr({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }] })],
      },
    });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    expect(h.sends[0]!.text).toContain("test (failure)");
    expect(h.verbs().some((v) => v.startsWith("pnpm") || v.startsWith("gh pr merge"))).toBe(false);
  });

  it("ignores a fork PR on the relay's branch name and keeps waiting for its own", async () => {
    const fork = ghPr({ number: 9, url: "https://github.com/joaopcm/t3-cardputer/pull/9", headRepositoryOwner: { login: "stranger" } });
    const h = harness({ script: { prs: () => [fork] } });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.verbs().filter((v) => v.startsWith("gh pr list")).length).toBeGreaterThan(3));
    expect(h.verbs().every((v) => v.startsWith("gh pr list"))).toBe(true);
    expect(h.sends).toHaveLength(0);
  });

  it("waits while a required check has not been created yet, even when every reported check is green", async () => {
    let rollup: unknown[] = [
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "test", state: "SUCCESS" },
    ];
    const h = harness({ script: { prs: () => [ghPr({ statusCheckRollup: rollup })] } });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.verbs().filter((v) => v.startsWith("gh pr list")).length).toBeGreaterThan(3));
    expect(h.verbs().every((v) => v.startsWith("gh pr list"))).toBe(true);
    rollup = [...rollup, { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
    await vi.waitFor(() => expect(h.deploys).toHaveLength(1));
  });

  it("waits while CI is pending or has not reported any check", async () => {
    let rollup: unknown[] = [];
    const h = harness({ script: { prs: () => [ghPr({ statusCheckRollup: rollup })] } });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.verbs().filter((v) => v.startsWith("gh pr list")).length).toBeGreaterThan(2));
    rollup = [
      { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", context: "leak-grep", state: "SUCCESS" },
    ];
    const listed = h.verbs().filter((v) => v.startsWith("gh pr list")).length;
    await vi.waitFor(() => expect(h.verbs().filter((v) => v.startsWith("gh pr list")).length).toBeGreaterThan(listed + 2));
    expect(h.verbs().every((v) => v.startsWith("gh pr list"))).toBe(true);
    rollup = [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "leak-grep", state: "SUCCESS" },
    ];
    await vi.waitFor(() => expect(h.deploys).toHaveLength(1));
  });

  it("a failing PR poll is shown on devices and cleared once polling works again", async () => {
    let broken = true;
    const h = harness({
      script: {
        prs: () => {
          if (broken) throw new Error("gh: HTTP 401: Bad credentials");
          return [];
        },
      },
    });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.warnings.at(-1)).toMatch(/approvals repair for T3 0\.0\.27\+orch3: PR poll failed: .*Bad credentials/));
    broken = false;
    await vi.waitFor(() => expect(h.warnings.at(-1)).toBeUndefined());
  });

  it("a merge GitHub refuses is shown on devices and not retried on the same commit", async () => {
    const h = harness({
      script: {
        prs: () => [ghPr()],
        merge: () => {
          throw new Error("gh pr merge failed: exit 1: Pull request is not mergeable: the base branch policy prohibits the merge");
        },
      },
    });
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.warnings.at(-1)).toMatch(/PR #7 passed every guardrail but the merge failed: .*base branch policy/));
    await pause(20);
    expect(h.verbs().filter((v) => v.startsWith("gh pr merge"))).toHaveLength(1);
    expect(h.verbs().filter((v) => v.startsWith("node dist/cli.js"))).toHaveLength(1);
    expect(h.deploys).toHaveLength(0);
  });

  it("does not launch and names the missing config key when repair.projectId is unset", () => {
    const h = harness({
      config: (c) => {
        const { projectId: _unset, ...repair } = c.repair;
        return { ...c, repair };
      },
    });
    expect(() => h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO })).toThrow(/repair\.projectId/);
    expect(h.warnings.at(-1)).toMatch(/repair\.projectId/);
    expect(h.launches).toHaveLength(0);
  });

  it("does not launch without a GitHub token and says how to store one", () => {
    const h = harness({ token: undefined });
    expect(() => h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO })).toThrow(/secrets set github/);
    expect(h.warnings.at(-1)).toMatch(/secrets set github/);
    expect(h.launches).toHaveLength(0);
  });

  it("a failed launch is not counted, says so on devices, and the next failure launches attempt 1 again", async () => {
    const h = harness();
    h.failLaunch(new Error("T3 unreachable"));
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.warnings.at(-1)).toMatch(/could not launch.*T3 unreachable/));
    expect(h.downs).toContainEqual({ reason: `canary approval_seen: ${FAILURE.reason}`, phase: "none" });
    h.failLaunch(undefined);
    h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO });
    await vi.waitFor(() => expect(h.launches).toHaveLength(1));
    expect(h.launches[0]!.branch).toBe(BRANCH);
  });

  it("refuses to launch when it cannot persist the dedupe state", () => {
    const h = harness();
    mkdirSync(h.config.stateDir, { recursive: true });
    chmodSync(h.config.stateDir, 0o500);
    try {
      expect(() => h.orchestrator.onBroken(FAILURE, { from: FROM, to: TO })).toThrow(/could not save repair state/);
      expect(h.launches).toHaveLength(0);
    } finally {
      chmodSync(h.config.stateDir, 0o700);
    }
  });

  it("a branch name never carries characters git refuses", async () => {
    const h = harness();
    h.orchestrator.onBroken(FAILURE, { to: "1.2 beta~1:x+orch3" });
    await vi.waitFor(() => expect(h.launches).toHaveLength(1));
    expect(h.launches[0]!.branch).toBe("repair/t3-1.2-beta-1-x+orch3-1");
  });
});

describe("deploy", () => {
  it("pulls, installs, builds, records the SHA, then restarts the unit without waiting on itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-deploy-"));
    const config: RelayConfig = { ...DEFAULT_CONFIG, stateDir: join(root, "state"), repair: { ...DEFAULT_CONFIG.repair, deployDir: join(root, "deploy") } };
    const calls: Call[] = [];
    const exec: Exec = async (file, args, options) => {
      calls.push({ file, args, options });
      return file === "git" && args[0] === "rev-parse" ? `${SHA}\n` : "";
    };
    await deploy(config, exec);
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "git pull --ff-only origin main",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "git rev-parse HEAD",
      "systemctl --user restart --no-block t3-cardputer-relay",
    ]);
    expect(calls.map((c) => c.options.cwd)).toEqual([config.repair.deployDir, join(config.repair.deployDir, "relay"), join(config.repair.deployDir, "relay"), config.repair.deployDir, undefined]);
    expect(JSON.parse(readFileSync(join(config.stateDir, DEPLOYED_STATE_NAME), "utf8"))).toMatchObject({ sha: SHA });
  });

  it("stops before restarting when a step fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-deploy-"));
    const config: RelayConfig = { ...DEFAULT_CONFIG, stateDir: join(root, "state"), repair: { ...DEFAULT_CONFIG.repair, deployDir: join(root, "deploy") } };
    const calls: string[] = [];
    const exec: Exec = async (file, args) => {
      calls.push(`${file} ${args[0]}`);
      if (file === "pnpm" && args[0] === "build") throw new Error("pnpm build failed: exit 2");
      return "";
    };
    await expect(deploy(config, exec)).rejects.toThrow(/pnpm build failed/);
    expect(calls).not.toContain("systemctl --user");
    expect(existsSync(join(config.stateDir, DEPLOYED_STATE_NAME))).toBe(false);
  });
});

describe("execRunner", () => {
  it("returns stdout and passes extra env without argv", async () => {
    const out = await execRunner(process.execPath, ["-e", "process.stdout.write(process.env.T3_EXEC_PROBE ?? 'unset')"], {
      env: { T3_EXEC_PROBE: "seen" },
      timeoutMs: 10_000,
      timeoutName: "repairStepTimeoutMs",
    });
    expect(out).toBe("seen");
  });

  it("names the command, exit code and stderr tail on failure", async () => {
    await expect(
      execRunner(process.execPath, ["-e", "process.stderr.write('boom on stderr'); process.exit(3)"], { timeoutMs: 10_000, timeoutName: "repairStepTimeoutMs" }),
    ).rejects.toThrow(/exit 3.*boom on stderr/);
  });

  it("names the budget, the limit and the wait on timeout", async () => {
    await expect(
      execRunner(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 50, timeoutName: "repairStepTimeoutMs" }),
    ).rejects.toThrow(/timed out: repairStepTimeoutMs=50/);
  });
});
