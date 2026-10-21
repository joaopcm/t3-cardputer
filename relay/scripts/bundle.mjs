import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const relayDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(relayDir, "dist-bundle", "t3-cardputer-relay.mjs");
const { version } = JSON.parse(readFileSync(join(relayDir, "package.json"), "utf8"));

await build({
  entryPoints: [join(relayDir, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // ws is CommonJS and requires node builtins, which an ESM bundle only resolves through createRequire
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  define: { __RELAY_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});

chmodSync(outfile, 0o755);
