import { createServer } from "node:http";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];

if (process.env.FAKE_WHISPER_EXIT_ON_START === "1") process.exit(3);

const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (process.env.FAKE_WHISPER_HANG === "1") return;
    if (process.env.FAKE_WHISPER_CRASH_FILE && existsSync(process.env.FAKE_WHISPER_CRASH_FILE)) process.exit(4);
    const body = Buffer.concat(chunks);
    const text = ` heard ${req.url} model=${flag("-m")} threads=${flag("-t")} lang=${flag("-l")} riff=${body.includes("RIFF")} json=${body.includes("json")} \n`;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text }));
  });
});
server.listen(Number(flag("--port")), flag("--host"));
