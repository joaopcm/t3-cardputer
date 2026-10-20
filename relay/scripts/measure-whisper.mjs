import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const [model, threadsArg = "8", runsArg = "5", wavArg] = process.argv.slice(2);
if (!model) {
  console.error("usage: node measure-whisper.mjs <model> [threads=8] [runs=5] [wav]");
  process.exit(2);
}
const threads = Number(threadsArg);
const runs = Number(runsArg);
const binDir = process.env.T3_CARDPUTER_WHISPER_DIR ?? join(homedir(), ".local", "share", "t3-cardputer", "whisper");
const wav = readFileSync(wavArg ?? join(binDir, "samples", "jfk.wav"));
const port = 19_000 + Math.floor(Math.random() * 1000);
const reference = "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.";

const words = (text) => text.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);

function wordErrors(expected, actual) {
  const a = words(expected);
  const b = words(actual);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

const child = spawn(
  join(binDir, "build", "bin", "whisper-server"),
  ["-m", join(dirname(binDir), "models", `ggml-${model}.bin`), "-t", String(threads), "-l", "en", "--host", "127.0.0.1", "--port", String(port)],
  { stdio: ["ignore", "ignore", "ignore"] },
);

async function infer() {
  const body = new FormData();
  body.set("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  body.set("response_format", "json");
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body });
  const { text } = await response.json();
  return { ms: performance.now() - started, text: text.replace(/\s+/g, " ").trim() };
}

const loadStarted = performance.now();
for (;;) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const loadMs = performance.now() - loadStarted;

await infer();
const results = [];
for (let i = 0; i < runs; i++) results.push(await infer());

const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
const peakRssMb = Number(/VmHWM:\s+(\d+) kB/.exec(status)[1]) / 1024;
child.kill("SIGKILL");

const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
console.log(
  JSON.stringify(
    {
      model,
      threads,
      runs,
      audioSec: (wav.length - 44) / 32000,
      loadMs: Math.round(loadMs),
      latencyMs: sorted.map(Math.round),
      medianMs: Math.round(median),
      p95Ms: Math.round(p95),
      peakRssMb: Math.round(peakRssMb),
      wordErrors: results.map((r) => wordErrors(reference, r.text)),
      transcript: results[0].text,
    },
    null,
    2,
  ),
);
