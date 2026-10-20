import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSim } from "../src/sim/device-sim.js";
import { loadSimConfig, pairDevice, saveSimConfig } from "../src/sim/sim-config.js";
import { cleanupAfterEach, startRelay, summary } from "./helpers/relay-fixture.js";

cleanupAfterEach();

describe("simulator against the real server", () => {
  it("sim pairs, sees home, opens a thread, replies with queue, launches a task, approves", async () => {
    const { server, auth, t3, approvals, dir } = await startRelay();
    t3.threads = [summary("t1"), summary("t2")];
    t3.replies.set("t2", "I finished the migration and all tests pass.");
    approvals.pending = [{ threadId: "t1", requestId: "req1", summary: "pnpm db:migrate", detail: [], decisions: ["allow_once", "allow_always", "deny", "deny_with_reason"] }];

    const url = `http://127.0.0.1:${server.port}`;
    const token = await pairDevice(url, auth.createPairingCode().code, "sim");
    const configPath = join(dir, "sim.json");
    saveSimConfig(configPath, { url, token });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(loadSimConfig(configPath)).toEqual({ url, token });

    const result = await runSim({
      url,
      token,
      cols: 40,
      bodyRows: 8,
      maxFrameBytes: 4096,
      write: () => {},
      script: [
        "2",
        "?I finished the migration",
        "on it please",
        "!steer stop now",
        "/b",
        "N",
        "1",
        "fix the flaky test",
        "1",
        "?Allow once",
        "Y",
      ],
    });

    expect(result.problems).toEqual([]);
    expect(result.closeCode).toBeUndefined();
    expect(t3.sends.map(({ threadId, text, mode }) => ({ threadId, text, mode }))).toEqual([
      { threadId: "t2", text: "on it please", mode: "queue" },
      { threadId: "t2", text: "stop now", mode: "steer" },
    ]);
    expect(t3.launches).toHaveLength(1);
    expect(t3.launches[0]).toMatchObject({ projectId: "p1", message: "fix the flaky test" });
    expect(approvals.responses).toEqual([{ threadId: "t1", requestId: "req1", decision: { kind: "allow_once" } }]);

    const shown = result.screens.join("\n");
    expect(shown).toMatch(/! api title t1\s+2h/);
    expect(shown).toMatch(/\* api title t2\s+2h/);
    expect(shown).toContain("pnpm db:migrate");
    expect(shown).toContain("[Y] Allow once");
    expect(shown).toMatch(/1 \|api /);
  });
});
