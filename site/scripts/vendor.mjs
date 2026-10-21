import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(site, "node_modules");
const vendor = join(site, "public", "vendor");
const out = join(vendor, "esptool-js");
const md5Out = join(vendor, "spark-md5");
const versionOf = (name) => JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8")).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(modules, "esptool-js", "bundle.js"), join(out, "bundle.js"));
copyFileSync(join(modules, "esptool-js", "LICENSE"), join(out, "LICENSE"));
copyFileSync(join(modules, "pako", "LICENSE"), join(out, "LICENSE.pako"));
copyFileSync(join(modules, "atob-lite", "LICENSE.md"), join(out, "LICENSE.atob-lite.md"));
rmSync(md5Out, { recursive: true, force: true });
mkdirSync(md5Out, { recursive: true });
copyFileSync(join(modules, "spark-md5", "spark-md5.min.js"), join(md5Out, "spark-md5.min.js"));
copyFileSync(join(modules, "spark-md5", "LICENSE"), join(md5Out, "LICENSE"));
console.log(`vendored esptool-js ${versionOf("esptool-js")} and spark-md5 ${versionOf("spark-md5")} into public/vendor`);
