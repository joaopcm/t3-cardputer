import { runSim } from "./device-sim.js";
import { DEFAULT_SIM_CONFIG_PATH, loadSimConfig, pairDevice, saveSimConfig } from "./sim-config.js";

// receipt: docs/protocol.md hello, maxFrameBytes is the device's receive budget; 4096 is the docs example
const MAX_FRAME_BYTES = 4096;

const USAGE = `usage:
  sim pair <relay-url> <code> [name]   trade a pairing code for a token, saved to ${DEFAULT_SIM_CONFIG_PATH}
  sim run [--wav file.wav] [--url u]   open the simulator with the saved token, --url replaces the saved relay url`;

export async function main(argv: string[], configPath: string = DEFAULT_SIM_CONFIG_PATH): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "pair") {
    const [url, code, name = "sim"] = rest;
    if (url === undefined || code === undefined) return usage("pair needs <relay-url> and <code>");
    saveSimConfig(configPath, { url, token: await pairDevice(url, code, name) });
    console.log(`paired, token saved to ${configPath}`);
    return 0;
  }
  if (command === "run") {
    const wav = flagValue(rest, "--wav");
    if (wav === null) return usage("--wav needs a value");
    const urlOverride = flagValue(rest, "--url");
    if (urlOverride === null) return usage("--url needs a value");
    const { url, token } = loadSimConfig(configPath);
    const result = await runSim({ url: urlOverride ?? url, token, cols: 40, bodyRows: 8, maxFrameBytes: MAX_FRAME_BYTES, ...(wav === undefined ? {} : { wav }) });
    return result.problems.length === 0 ? 0 : 1;
  }
  return usage("unknown command");
}

function flagValue(args: string[], flag: string): string | undefined | null {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  return args[at + 1] ?? null;
}

function usage(problem: string): number {
  console.error(`${problem}\n${USAGE}`);
  return 2;
}
