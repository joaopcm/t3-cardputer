#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const state = process.env.STUB_STATE;
const [command, ...args] = process.argv.slice(2);
appendFileSync(join(state, "calls.log"), `relay ${process.argv.slice(2).join(" ")}\n`);
const configDir = join(homedir(), ".config", "t3-cardputer");

function fail(message) {
  console.error(message);
  process.exit(1);
}

switch (command) {
  case "--version":
    console.log(`t3-cardputer-relay ${process.env.STUB_RELAY_VERSION}`);
    break;
  case "pair-t3": {
    if (args.join(" ") !== "--stdin") fail(`fake relay: pair-t3 got ${args.join(" ")}`);
    const { mcp, internal } = JSON.parse(readFileSync(0, "utf8"));
    if (!mcp || !internal) fail('pair-t3 --stdin needs {"mcp":"<code>","internal":"<code>"} on stdin');
    writeFileSync(join(state, "paired.json"), JSON.stringify({ mcp, internal }));
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const secrets = { t3McpToken: { token: "tok-mcp", expiresAt }, t3InternalToken: { token: "tok-internal", expiresAt }, devices: [] };
    writeFileSync(join(configDir, "secrets.json"), JSON.stringify(secrets, null, 2), { mode: 0o600 });
    console.log(`mcp token stored, expires ${expiresAt}`);
    console.log(`internal token stored, expires ${expiresAt}`);
    break;
  }
  case "models":
    if (args.join(" ") !== "--json") fail(`fake relay: models got ${args.join(" ")}`);
    console.log(process.env.STUB_MODELS);
    break;
  case "install-link": {
    if (!existsSync(join(state, "service-up"))) fail("relay is not running");
    const { publicUrl } = JSON.parse(readFileSync(join(configDir, "relay.json"), "utf8"));
    if (publicUrl === undefined) fail("install-link needs publicUrl in relay.json (setup.sh sets it)");
    console.log(`https://t3-cardputer.jopcmelo.com/install#r=${encodeURIComponent(publicUrl)}&c=K7Q2AB9X`);
    console.log("code expires in 10 min");
    break;
  }
  default:
    fail(`fake relay: unexpected ${process.argv.slice(2).join(" ")}`);
}
