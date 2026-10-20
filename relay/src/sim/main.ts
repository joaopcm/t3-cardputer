import { runSim } from "./device-sim.js";
import { DEFAULT_SIM_CONFIG_PATH, loadSimConfig, pairDevice, saveSimConfig } from "./sim-config.js";

// receipt: docs/protocol.md hello, maxFrameBytes is the device's receive budget; 4096 is the docs example
const MAX_FRAME_BYTES = 4096;

const USAGE = `usage:
  sim pair <relay-url> <code> [name]   trade a pairing code for a token, saved to ${DEFAULT_SIM_CONFIG_PATH}
  sim run [--wav file.wav]             open the simulator with the saved token`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "pair") {
    const [url, code, name = "sim"] = rest;
    if (url === undefined || code === undefined) return usage("pair needs <relay-url> and <code>");
    saveSimConfig(DEFAULT_SIM_CONFIG_PATH, { url, token: await pairDevice(url, code, name) });
    console.log(`paired, token saved to ${DEFAULT_SIM_CONFIG_PATH}`);
    return 0;
  }
  if (command === "run") {
    const wavAt = rest.indexOf("--wav");
    const wav = wavAt === -1 ? undefined : rest[wavAt + 1];
    if (wavAt !== -1 && wav === undefined) return usage("--wav needs a file");
    const { url, token } = loadSimConfig(DEFAULT_SIM_CONFIG_PATH);
    const result = await runSim({ url, token, cols: 40, bodyRows: 8, maxFrameBytes: MAX_FRAME_BYTES, ...(wav === undefined ? {} : { wav }) });
    return result.problems.length === 0 ? 0 : 1;
  }
  return usage("unknown command");
}

function usage(problem: string): number {
  console.error(`${problem}\n${USAGE}`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
