import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../src/approvals/index.js";
import { relayMessageSchema } from "../src/protocol/messages.js";
import type { T3Question, T3ThreadSummary } from "../src/t3/mcp.js";
import { buildHome } from "../src/views/home.js";
import { buildProjects } from "../src/views/projects.js";
import { buildRequest } from "../src/views/request.js";
import { buildThreadPage } from "../src/views/thread.js";

const now = new Date("2026-10-20T12:00:00.000Z");

function hoursAgo(h: number): string {
  return new Date(now.getTime() - h * 3_600_000).toISOString();
}

function thread(threadId: string, status: string, updatedAt: string, title = threadId): T3ThreadSummary & { project: string } {
  return { threadId, projectId: "p1", title, status, updatedAt, project: "api" };
}

function approval(threadId: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    threadId,
    requestId: `req-${threadId}`,
    summary: "Run shell command?",
    detail: ["pnpm db:migrate"],
    decisions: ["allow_once", "allow_always", "deny", "deny_with_reason"],
    ...overrides,
  };
}

function question(overrides: Partial<T3Question> = {}): T3Question {
  return {
    requestId: "req-q",
    questionId: "q1",
    prompt: "Which database should I use?",
    options: [
      { label: "staging", value: "staging" },
      { label: "local", value: "local" },
    ],
    multiSelect: false,
    ...overrides,
  };
}

const baseHome = {
  approvals: [] as PendingApproval[],
  questions: new Map<string, T3Question[]>(),
  now,
  maxRows: 50,
  cols: 40,
  approvalsState: { available: true },
  warnings: [] as string[],
  t3: "ok" as const,
};

describe("buildHome", () => {
  it("puts approval before question before failed, running after, done last", () => {
    const home = buildHome({
      ...baseHome,
      threads: [
        thread("done", "completed", hoursAgo(1)),
        thread("running", "running", hoursAgo(2)),
        thread("failed", "failed", hoursAgo(3)),
        thread("asks", "running", hoursAgo(4)),
        thread("needs-ok", "running", hoursAgo(5)),
      ],
      approvals: [approval("needs-ok")],
      questions: new Map([["asks", [question()]]]),
    });

    expect(home.rows.map((r) => [r.threadId, r.kind])).toEqual([
      ["needs-ok", "approval"],
      ["asks", "question"],
      ["failed", "failed"],
      ["running", "running"],
      ["done", "done"],
    ]);
    expect(home.counts).toEqual({ needs: 3, running: 1, done: 1 });
    expect(relayMessageSchema.safeParse(home).success).toBe(true);
  });

  it("completed 25h ago is excluded from done", () => {
    const home = buildHome({
      ...baseHome,
      threads: [thread("fresh", "completed", hoursAgo(23)), thread("stale", "completed", hoursAgo(25))],
    });

    expect(home.rows.map((r) => r.threadId)).toEqual(["fresh"]);
    expect(home.counts.done).toBe(1);
  });

  it("maxRows=3 with 7 threads keeps counts exact", () => {
    const threads = [
      thread("f1", "failed", hoursAgo(9)),
      thread("f2", "interrupted", hoursAgo(8)),
      thread("f3", "cancelled", hoursAgo(7)),
      thread("r1", "running", hoursAgo(6)),
      thread("r2", "queued", hoursAgo(5)),
      thread("d1", "completed", hoursAgo(4)),
      thread("d2", "completed", hoursAgo(3)),
    ];
    const home = buildHome({ ...baseHome, threads, maxRows: 3 });

    expect(home.rows.map((r) => r.threadId)).toEqual(["f1", "f2", "f3"]);
    expect(home.counts).toEqual({ needs: 3, running: 2, done: 2 });
  });

  it("orders needs oldest first within a kind, running and done newest first", () => {
    const home = buildHome({
      ...baseHome,
      threads: [
        thread("f-new", "failed", hoursAgo(1)),
        thread("f-old", "failed", hoursAgo(5)),
        thread("r-old", "starting", hoursAgo(5)),
        thread("r-new", "preparing", hoursAgo(1)),
        thread("d-old", "completed", hoursAgo(5)),
        thread("d-new", "completed", hoursAgo(1)),
      ],
    });

    expect(home.rows.map((r) => r.threadId)).toEqual(["f-old", "f-new", "r-new", "r-old", "d-new", "d-old"]);
  });

  it("lists a thread with both an approval and a question once, as approval", () => {
    const home = buildHome({
      ...baseHome,
      threads: [thread("t", "running", hoursAgo(1))],
      approvals: [approval("t"), approval("t", { requestId: "second" })],
      questions: new Map([["t", [question()]]]),
    });

    expect(home.rows).toHaveLength(1);
    expect(home.rows[0]?.kind).toBe("approval");
    expect(home.counts).toEqual({ needs: 1, running: 0, done: 0 });
  });

  it("computes ageSec and cleans text to device ascii", () => {
    const home = buildHome({
      ...baseHome,
      threads: [{ ...thread("t", "running", hoursAgo(1), "café 🚀\nfix"), project: "müller api" }],
    });

    expect(home.rows[0]?.ageSec).toBe(3600);
    expect(home.rows[0]?.title).toBe("cafe ? fix");
    expect(home.rows[0]?.project).toBe("muller api");
  });

  it("never drops an unknown status: shows it as failed and warns once per status", () => {
    const home = buildHome({
      ...baseHome,
      threads: [
        thread("a", "paused", hoursAgo(1), "first"),
        thread("b", "paused", hoursAgo(2), "second"),
        thread("c", "weird\u00e9", hoursAgo(3), "third"),
        thread("d", "running", hoursAgo(4)),
      ],
      warnings: ["existing"],
    });

    expect(home.rows.map((r) => [r.threadId, r.kind])).toEqual([
      ["c", "failed"],
      ["b", "failed"],
      ["a", "failed"],
      ["d", "running"],
    ]);
    expect(home.counts).toEqual({ needs: 3, running: 1, done: 0 });
    expect(home.warnings).toEqual(["existing", 'unknown thread status "paused" on first', 'unknown thread status "weirde" on third']);
  });

  it("warns on an unparseable updatedAt instead of silently using age 0", () => {
    const home = buildHome({
      ...baseHome,
      threads: [thread("a", "running", "not a date", "broken one"), thread("b", "running", "", "other")],
    });

    expect(home.rows).toHaveLength(2);
    expect(home.warnings).toEqual(["unparseable updatedAt on 2 thread(s), first: broken one"]);
  });

  it("clips project to a third of cols and title to the rest, ending with ~", () => {
    const home = buildHome({
      ...baseHome,
      cols: 40,
      threads: [{ ...thread("t", "running", hoursAgo(1), "t".repeat(30)), project: "p".repeat(20) }],
    });

    const row = home.rows[0];
    expect(row?.project).toBe(`${"p".repeat(12)}~`);
    expect(row?.title).toBe(`${"t".repeat(18)}~`);
    expect(`X ${row?.project} ${row?.title} 999d`.length).toBe(40);
  });

  it("leaves short project and title untouched and gives title the spare room", () => {
    const home = buildHome({
      ...baseHome,
      cols: 40,
      threads: [{ ...thread("t", "running", hoursAgo(1), "t".repeat(28)), project: "api" }],
    });

    expect(home.rows[0]?.project).toBe("api");
    expect(home.rows[0]?.title).toBe("t".repeat(28));
  });

  it("never clips below one column on a tiny screen", () => {
    const home = buildHome({ ...baseHome, cols: 5, threads: [thread("t", "running", hoursAgo(1), "title")] });

    expect(home.rows[0]?.project).toBe("~");
    expect(home.rows[0]?.title).toBe("~");
  });

  it("passes approvals state, warnings and t3 status through", () => {
    const home = buildHome({
      ...baseHome,
      threads: [],
      approvalsState: { available: false, reason: "adapter drift — pair again" },
      warnings: ["t3 slow …"],
      t3: "unreachable",
    });

    expect(home.approvals).toEqual({ available: false, reason: "adapter drift - pair again" });
    expect(home.warnings).toEqual(["t3 slow ..."]);
    expect(home.t3).toBe("unreachable");
    expect(relayMessageSchema.safeParse(home).success).toBe(true);
  });
});

describe("buildThreadPage", () => {
  const summary = thread("t1", "running", hoursAgo(1), "run migration");
  const base = { summary, project: "api", page: 1, cols: 20, bodyRows: 4, maxPages: 10 };

  it('thread page with null message shows "no reply yet"', () => {
    const page = buildThreadPage({ ...base, message: null });

    expect(page.lines).toEqual(["no reply yet"]);
    expect(page.page).toBe(1);
    expect(page.pages).toBe(1);
    expect(page.header).toEqual({ project: "api", title: "run migration", model: "-", status: "running" });
    expect(relayMessageSchema.safeParse(page).success).toBe(true);
  });

  it("wraps and paginates the reply", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const message = { text, model: "claude-opus-5", at: hoursAgo(1) };

    const second = buildThreadPage({ ...base, message, page: 2 });

    expect(second.pages).toBe(3);
    expect(second.page).toBe(2);
    expect(second.lines).toEqual(["line 5", "line 6", "line 7", "line 8"]);
    expect(second.header.model).toBe("claude-opus-5");
    expect(second.truncated).toBeUndefined();
    expect(second.lines.every((l) => l.length <= base.cols)).toBe(true);
  });

  it("clamps an out of range page", () => {
    const message = { text: "a\nb\nc\nd\ne", model: "m", at: hoursAgo(1) };

    expect(buildThreadPage({ ...base, message, page: 99 }).page).toBe(2);
    expect(buildThreadPage({ ...base, message, page: 0 }).page).toBe(1);
  });

  it("reserves rows for the truncation notice so it ends the last page intact", () => {
    const text = Array.from({ length: 13 }, (_, i) => `l${i + 1}`).join("\n");
    const message = { text, model: "m", at: hoursAgo(1) };
    const input = { ...base, message, bodyRows: 2, maxPages: 5, cols: 60 };

    const last = buildThreadPage({ ...input, page: 5 });
    const first = buildThreadPage({ ...input, page: 1 });

    expect(last.pages).toBe(5);
    expect(last.truncated).toEqual({ budget: "max_reply_pages", limit: 5, actual: 7 });
    expect(last.lines).toEqual(["l9", "reply truncated: max_reply_pages=5, reply needed 7"]);
    expect(first.lines).toEqual(["l1", "l2"]);
    expect(relayMessageSchema.safeParse(last).success).toBe(true);
  });

  it("keeps the whole notice and every other row of content with bodyRows=2 cols=20", () => {
    const text = Array.from({ length: 30 }, (_, i) => `r${i + 1}`).join("\n");
    const message = { text, model: "m", at: hoursAgo(1) };
    const input = { ...base, message, cols: 20, bodyRows: 2, maxPages: 5 };

    const shown = [1, 2, 3, 4, 5].flatMap((page) => buildThreadPage({ ...input, page }).lines);
    const notice = ["reply truncated:", "max_reply_pages=5,", "reply needed 15"];

    expect(shown.slice(-notice.length)).toEqual(notice);
    expect(shown.slice(0, shown.length - notice.length)).toEqual(Array.from({ length: 7 }, (_, i) => `r${i + 1}`));
    expect(shown).toHaveLength(10);
    expect(shown.every((l) => l.length <= 20)).toBe(true);
  });

  it("throws naming the budget when the notice cannot fit the page budget", () => {
    const message = { text: "a\nb\nc\nd", model: "m", at: hoursAgo(1) };

    expect(() => buildThreadPage({ ...base, message, cols: 20, bodyRows: 1, maxPages: 2 })).toThrow(/max_reply_pages\*bodyRows=2/);
  });

  it("cleans reply text to device ascii", () => {
    const message = { text: "done ✓ “quoted”", model: "m", at: hoursAgo(1) };

    expect(buildThreadPage({ ...base, message, cols: 40 }).lines).toEqual(['done v "quoted"']);
  });
});

const screen = (cols: number, bodyRows = 11, maxFrameBytes = 4096) => ({ cols, bodyRows, maxFrameBytes });
const frameBytes = (msg: unknown) => Buffer.byteLength(JSON.stringify(msg));

describe("buildRequest", () => {
  it("a 120-line heredoc approval fits bodyRows and maxFrameBytes, keeps every option, and says how much was cut", () => {
    const heredoc = ["cat <<'EOF' > migrate.sql", ...Array.from({ length: 118 }, (_, i) => `INSERT INTO t VALUES (${i}, 'row ${i}');`), "EOF"].join("\n");
    const request = buildRequest(approval("t1", { summary: heredoc, detail: ["cwd: /repo"] }), screen(40, 11, 4096));

    expect(request.options.map((o) => o.key)).toEqual(["Y", "A", "N", "T"]);
    expect(request.lines.length + request.options.length).toBeLessThanOrEqual(11);
    expect(request.lines[0]).toBe("cat <<'EOF' > migrate.sql");
    expect(request.lines.slice(-2).join(" ")).toMatch(/^command truncated: \d+ more lines, bodyRows=11$/);
    expect(request.lines.every((l) => l.length <= 40)).toBe(true);
    expect(frameBytes(request)).toBeLessThanOrEqual(4096);
    expect(relayMessageSchema.safeParse(request).success).toBe(true);
  });

  it("counts the cut lines exactly", () => {
    const summary = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const request = buildRequest(approval("t1", { summary, detail: [] }), screen(80, 8, 4096));

    expect(request.lines).toEqual(["line 1", "line 2", "line 3", "command truncated: 17 more lines, bodyRows=8"]);
  });

  it("cuts to the frame budget when rows are not the limit, naming maxFrameBytes", () => {
    const summary = Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(200, "x")).join("\n");
    const request = buildRequest(approval("t1", { summary, detail: [] }), screen(255, 64, 2048));

    expect(frameBytes(request)).toBeLessThanOrEqual(2048);
    expect(request.options).toHaveLength(4);
    expect(request.lines.at(-1)).toMatch(/^command truncated: \d+ more lines, maxFrameBytes=2048$/);
  });

  it("leaves a request that fits untouched", () => {
    const request = buildRequest(approval("t1"), screen(40, 11, 4096));

    expect(request.lines).toEqual(["Run shell command?", "", "  pnpm db:migrate"]);
  });

  it("a long question prompt is cut the same way and names the question", () => {
    const request = buildRequest(question({ prompt: "word ".repeat(200) }), screen(40, 6, 4096), "t3");

    expect(request.lines.length + request.options.length).toBeLessThanOrEqual(6);
    expect(request.lines.join(" ")).toMatch(/question truncated: \d+ more lines, bodyRows=6/);
  });

  it("throws naming max_frame_bytes when even the options alone do not fit", () => {
    expect(() => buildRequest(approval("t1"), screen(40, 11, 256))).toThrow(/max_frame_bytes=256, request needed \d+/);
  });

  it("approval offering only allow_once and deny maps to keys Y and N only", () => {
    const request = buildRequest(approval("t1", { decisions: ["allow_once", "deny"] }), screen(40));

    expect(request.options).toEqual([
      { key: "Y", label: "Allow once", value: "allow_once" },
      { key: "N", label: "Deny", value: "deny" },
    ]);
    expect(request.kind).toBe("approval");
    expect(request.threadId).toBe("t1");
    expect(request.requestId).toBe("req-t1");
    expect(relayMessageSchema.safeParse(request).success).toBe(true);
  });

  it("maps all four decisions to Y A N T", () => {
    const request = buildRequest(approval("t1"), screen(40));

    expect(request.options.map((o) => [o.key, o.value])).toEqual([
      ["Y", "allow_once"],
      ["A", "allow_always"],
      ["N", "deny"],
      ["T", "deny_with_reason"],
    ]);
  });

  it("wraps summary and indents detail as ascii", () => {
    const request = buildRequest(
      approval("t1", { summary: "Run shell command — really?", detail: ["pnpm db:migrate --env “staging” now please"] }),
      screen(20),
    );

    expect(request.lines[0]).toBe("Run shell command -");
    expect(request.lines).toContain("");
    expect(request.lines.every((l) => l.length <= 20 && /^[\x20-\x7e]*$/.test(l))).toBe(true);
    expect(request.lines.at(-1)?.startsWith("  ")).toBe(true);
  });

  it("question maps options to keys 1..n with the T3 value", () => {
    const request = buildRequest(question({ options: [{ label: "Staging DB", value: "staging" }, { label: "Local", value: "local" }] }), screen(40), "t3");

    expect(request.kind).toBe("question");
    expect(request.threadId).toBe("t3");
    expect(request.requestId).toBe("req-q");
    expect(request.lines).toEqual(["Which database should I use?"]);
    expect(request.options).toEqual([
      { key: "1", label: "Staging DB", value: "staging" },
      { key: "2", label: "Local", value: "local" },
    ]);
    expect(relayMessageSchema.safeParse(request).success).toBe(true);
  });

  it("question with no options is free text", () => {
    const request = buildRequest(question({ options: [] }), screen(40), "t3");

    expect(request.options).toEqual([{ key: "T", label: "Type answer", value: "text" }]);
    expect(relayMessageSchema.safeParse(request).success).toBe(true);
  });

  it("question with more than 9 options keeps 9, says so, and offers typed answer", () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ label: `opt ${i + 1}`, value: `v${i + 1}` }));
    const request = buildRequest(question({ options }), screen(40), "t3");

    expect(request.options.map((o) => o.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "T"]);
    expect(request.options.at(-1)?.value).toBe("text");
    expect(request.lines.join(" ")).toContain("showing 9 of 12");
    expect(relayMessageSchema.safeParse(request).success).toBe(true);
  });

  it("multiSelect question says pick one", () => {
    const request = buildRequest(question({ multiSelect: true }), screen(40), "t3");

    expect(request.lines.join(" ")).toContain("pick one");
    expect(request.options).toHaveLength(2);
  });

  it("truncates long labels to the protocol limit and rejects oversize values loudly", () => {
    const long = "x".repeat(100);
    const request = buildRequest(question({ options: [{ label: long, value: "v" }] }), screen(40), "t3");

    expect(request.options[0]?.label).toHaveLength(64);
    expect(request.options[0]?.label.endsWith("...")).toBe(true);
    expect(() => buildRequest(question({ options: [{ label: "a", value: "v".repeat(129) }] }), screen(40), "t3")).toThrow(/max_ref_chars=128.*129/);
  });
});

describe("buildProjects", () => {
  const fallback = { model: "claude-opus-5", workspace: "worktree" as const, runtimeMode: "approval-required" };

  it("uses remembered defaults per project and the fallback otherwise", () => {
    const stored = { model: "m2", workspace: "root" as const, runtimeMode: "auto" };
    const projects = buildProjects(
      [
        { projectId: "p1", name: "api — core" },
        { projectId: "p2", name: "web" },
      ],
      { get: (id) => (id === "p1" ? stored : undefined) },
      fallback,
    );

    expect(projects.items).toEqual([
      { projectId: "p1", name: "api - core", defaults: stored },
      { projectId: "p2", name: "web", defaults: fallback },
    ]);
    expect(relayMessageSchema.safeParse(projects).success).toBe(true);
  });

  it("falls back for a remembered runtimeMode the protocol does not know", () => {
    const projects = buildProjects(
      [{ projectId: "p1", name: "api" }],
      { get: () => ({ model: "m2", workspace: "root", runtimeMode: "yolo" }) },
      fallback,
    );

    expect(projects.items[0]?.defaults).toEqual({ model: "m2", workspace: "root", runtimeMode: "approval-required" });
    expect(relayMessageSchema.safeParse(projects).success).toBe(true);
  });
});
