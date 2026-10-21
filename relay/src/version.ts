import { readFileSync } from "node:fs";
import { z } from "zod";

declare const __RELAY_VERSION__: string | undefined;

// the bundle has no package.json beside it, so scripts/bundle.mjs bakes the version in
export const RELAY_VERSION =
  typeof __RELAY_VERSION__ === "string"
    ? __RELAY_VERSION__
    : z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;
