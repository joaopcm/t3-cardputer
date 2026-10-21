import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(site, "node_modules");
const out = join(site, "public", "vendor", "esptool-js");
const { version } = JSON.parse(readFileSync(join(modules, "esptool-js", "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(modules, "esptool-js", "bundle.js"), join(out, "bundle.js"));
copyFileSync(join(modules, "esptool-js", "LICENSE"), join(out, "LICENSE"));
copyFileSync(join(modules, "pako", "LICENSE"), join(out, "LICENSE.pako"));
copyFileSync(join(modules, "atob-lite", "LICENSE.md"), join(out, "LICENSE.atob-lite.md"));
console.log(`vendored esptool-js ${version} into public/vendor/esptool-js`);
