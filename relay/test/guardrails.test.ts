import { describe, expect, it } from "vitest";
import { checkMergeable, type PullRequestFacts } from "../src/repair/guardrails.js";

const expected = { repo: "joaopcm/t3-cardputer", branch: "repair/t3-0.0.27+orch3-1" };

function pr(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    headRepo: "joaopcm/t3-cardputer",
    baseRepo: "joaopcm/t3-cardputer",
    headRef: "repair/t3-0.0.27+orch3-1",
    files: ["relay/src/approvals/internal-ws.ts", "relay/src/approvals/internal-ws.test.ts"],
    checks: [{ name: "relay", conclusion: "success" }],
    ...overrides,
  };
}

function reasons(facts: PullRequestFacts, want = expected): string[] {
  const verdict = checkMergeable(facts, want);
  return verdict.ok ? [] : verdict.reasons;
}

describe("checkMergeable", () => {
  it("accepts the relay's own branch, approvals-only files and green checks", () => {
    expect(checkMergeable(pr(), expected)).toEqual({ ok: true });
  });

  it("fork PR is not mergeable", () => {
    const got = reasons(pr({ headRepo: "stranger/t3-cardputer" }));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^no forks: .*stranger\/t3-cardputer/);
  });

  it("fork PR on the relay's exact branch name with green checks named like ours is not mergeable", () => {
    expect(reasons(pr({ headRepo: "stranger/t3-cardputer", checks: [{ name: "relay", conclusion: "success" }] }))).toEqual([
      expect.stringMatching(/^no forks: /),
    ]);
  });

  it("PR whose base is another repo is not mergeable", () => {
    expect(reasons(pr({ baseRepo: "stranger/t3-cardputer" }))[0]).toMatch(/^no forks: .*base.*stranger\/t3-cardputer/);
  });

  it("repo names differing only in case are not the expected repo", () => {
    expect(reasons(pr({ headRepo: "JoaoPCM/t3-cardputer", baseRepo: "JoaoPCM/t3-cardputer" }))[0]).toMatch(/^no forks: /);
  });

  it("PR touching relay/src/server.ts is not mergeable and names the file", () => {
    const got = reasons(pr({ files: ["relay/src/approvals/rpc.ts", "relay/src/server.ts"] }));
    expect(got).toEqual([expect.stringMatching(/^files outside relay\/src\/approvals\/: relay\/src\/server\.ts$/)]);
  });

  it.each([
    ["dot-dot escape", "relay/src/approvals/../server.ts"],
    ["dot segment", "relay/src/approvals/./x.ts"],
    ["empty segment", "relay/src/approvals//x.ts"],
    ["leading slash", "/relay/src/approvals/x.ts"],
    ["leading dot-slash", "./relay/src/approvals/x.ts"],
    ["folder prefix without slash", "relay/src/approvals.ts"],
    ["sibling folder sharing the prefix", "relay/src/approvals-v2/x.ts"],
    ["folder itself replaced (file or symlink)", "relay/src/approvals"],
    ["folder with trailing slash only", "relay/src/approvals/"],
    ["case variant of the folder", "relay/src/Approvals/x.ts"],
    ["case variant of the root", "Relay/src/approvals/x.ts"],
    ["backslash traversal", "relay/src/approvals/..\\server.ts"],
    ["newline smuggling a second path", "relay/src/approvals/x.ts\n.github/workflows/ci.yml"],
    ["lookalike unicode letter", "relay/src/apprоvals/x.ts"],
    ["CI workflow", ".github/workflows/ci.yml"],
    ["lockfile", "relay/pnpm-lock.yaml"],
    ["package scripts", "relay/package.json"],
    ["sibling src file", "relay/src/cli.ts"],
    ["tests outside the folder", "relay/test/guardrails.test.ts"],
  ])("rejects %s", (_name, file) => {
    const got = reasons(pr({ files: ["relay/src/approvals/rpc.ts", file] }));
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("files outside relay/src/approvals/");
    expect(got[0]).toContain(JSON.stringify(file).slice(1, -1));
  });

  it("a rename out of the folder lists both paths and the outside one blocks", () => {
    expect(reasons(pr({ files: ["relay/src/approvals/rpc.ts", "relay/src/rpc.ts"] }))[0]).toMatch(/relay\/src\/rpc\.ts/);
  });

  it("a rename into the folder lists the old path and blocks", () => {
    expect(reasons(pr({ files: ["relay/src/server.ts", "relay/src/approvals/server.ts"] }))[0]).toMatch(/: relay\/src\/server\.ts$/);
  });

  it("accepts nested files in the folder", () => {
    expect(checkMergeable(pr({ files: ["relay/src/approvals/__fixtures__/snapshot.json"] }), expected)).toEqual({ ok: true });
  });

  it("a PR that changes no files is not mergeable", () => {
    expect(reasons(pr({ files: [] }))).toEqual([expect.stringMatching(/^files: none changed/)]);
  });

  it("PR with zero checks is not mergeable", () => {
    expect(reasons(pr({ checks: [] }))).toEqual([expect.stringMatching(/^checks: none reported/)]);
  });

  it.each(["pending", "neutral", "skipped", "failure", "cancelled", "timed_out", "action_required", "stale", "error", "", "SUCCESS", "Success"])(
    "a check concluded %j is not mergeable",
    (conclusion) => {
      const got = reasons(pr({ checks: [{ name: "relay", conclusion: "success" }, { name: "leak-grep", conclusion }] }));
      expect(got).toEqual([`checks not successful: leak-grep (${conclusion})`]);
    },
  );

  it("a duplicate check name with one failure is not mergeable", () => {
    const got = reasons(pr({ checks: [{ name: "relay", conclusion: "success" }, { name: "relay", conclusion: "failure" }] }));
    expect(got).toEqual(["checks not successful: relay (failure)"]);
  });

  it("PR on a different branch than the relay created is not mergeable", () => {
    expect(reasons(pr({ headRef: "repair/t3-0.0.27+orch3-2" }))).toEqual([expect.stringMatching(/^branch: .*repair\/t3-0\.0\.27\+orch3-2.*repair\/t3-0\.0\.27\+orch3-1/)]);
  });

  it.each([
    ["prefix of the relay's branch", "repair/t3-0.0.27+orch3"],
    ["relay's branch plus a suffix", "repair/t3-0.0.27+orch3-1x"],
    ["fully qualified ref", "refs/heads/repair/t3-0.0.27+orch3-1"],
    ["case variant", "Repair/t3-0.0.27+orch3-1"],
    ["main", "main"],
  ])("rejects a head ref that is a %s", (_name, headRef) => {
    expect(reasons(pr({ headRef }))[0]).toMatch(/^branch: /);
  });

  it("an expected branch outside repair/ is never mergeable", () => {
    expect(reasons(pr({ headRef: "main" }), { ...expected, branch: "main" })).toEqual([expect.stringMatching(/^branch: .*repair\//)]);
  });

  it("names every broken rule at once", () => {
    const got = reasons({ headRepo: "stranger/x", baseRepo: "joaopcm/t3-cardputer", headRef: "main", files: ["relay/src/server.ts"], checks: [] });
    expect(got.map((reason) => reason.split(":")[0])).toEqual(["no forks", "branch", "files outside relay/src/approvals/", "checks"]);
  });
});
