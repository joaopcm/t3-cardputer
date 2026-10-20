import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSim } from "../src/sim/device-sim.js";
import { loadSimConfig, pairDevice, saveSimConfig } from "../src/sim/sim-config.js";
import type { Stt } from "../src/stt/types.js";
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

  it("sim shows the model list on the new task screen", async () => {
    const { server, auth, t3 } = await startRelay();
    t3.models = [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }];

    const url = `http://127.0.0.1:${server.port}`;
    const result = await runSim({
      url,
      token: await pairDevice(url, auth.createPairingCode().code, "sim"),
      cols: 40,
      bodyRows: 8,
      maxFrameBytes: 4096,
      write: () => {},
      script: ["N", "1", "?opus-5-5"],
    });

    expect(result.problems).toEqual([]);
    expect(result.screens.join("\n")).toContain("models opus-5-5 haiku-5-5");
  });

  it("sim denies with a reason and answers a free-text question", async () => {
    const { server, auth, t3, approvals } = await startRelay();
    t3.threads = [summary("t1"), summary("t3")];
    approvals.pending = [{ threadId: "t1", requestId: "req1", summary: "rm -rf build", detail: [], decisions: ["allow_once", "allow_always", "deny", "deny_with_reason"] }];
    t3.questions.set("t3", [{ requestId: "q1", questionId: "why", prompt: "Why did the test fail?", options: [], multiSelect: false }]);

    const url = `http://127.0.0.1:${server.port}`;
    const result = await runSim({
      url,
      token: await pairDevice(url, auth.createPairingCode().code, "sim"),
      cols: 40,
      bodyRows: 8,
      maxFrameBytes: 4096,
      write: () => {},
      script: ["2", "?[T] Type answer", "T", "it was a race in the setup", "/b", "1", "?Deny, say why", "T", "use staging instead"],
    });

    expect(result.problems).toEqual([]);
    expect(t3.answers).toEqual([{ threadId: "t3", requestId: "q1", answers: { why: "it was a race in the setup" } }]);
    expect(approvals.responses).toEqual([{ threadId: "t1", requestId: "req1", decision: { kind: "deny_with_reason", reason: "use staging instead" } }]);
    expect(result.screens.join("\n")).toContain("Why did the test fail?");
  });

  it("sim streams a wav with /talk, gets the transcript, and sends it as the reply", async () => {
    const heard: Buffer[] = [];
    const stt: Stt = {
      transcribe: async (wav) => {
        heard.push(wav);
        return "ship it now";
      },
    };
    const { server, auth, t3, dir } = await startRelay({}, stt);
    t3.threads = [summary("t1"), summary("t2")];
    const pcm = Buffer.alloc(16_000 * 2 * 0.5);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(pcm.length, 40);
    const wav = join(dir, "talk.wav");
    writeFileSync(wav, Buffer.concat([header, pcm]));

    const url = `http://127.0.0.1:${server.port}`;
    const result = await runSim({
      url,
      token: await pairDevice(url, auth.createPairingCode().code, "sim"),
      cols: 40,
      bodyRows: 8,
      maxFrameBytes: 4096,
      write: () => {},
      wav,
      script: ["2", "/talk", "?ship it now", ""],
    });

    expect(result.problems).toEqual([]);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.length).toBe(44 + pcm.length);
    expect(t3.sends.map(({ threadId, text }) => ({ threadId, text }))).toEqual([{ threadId: "t2", text: "ship it now" }]);
  });
});
