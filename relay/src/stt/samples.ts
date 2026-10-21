import { mkdir, chmod, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Sample = {
  wav: Buffer;
  deviceId: string;
  durationSec: number;
  peakDbfs: number | null;
  transcript: string;
  model: string;
  transcribeMs: number;
};

export type SampleKeeper = { save(sample: Sample): Promise<void> };

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const DEVICE_ID_SHORT = 8;

export function createSampleKeeper(opts: { dir: string; maxSamples: number }): SampleKeeper {
  return {
    async save(sample) {
      try {
        await store(opts, sample);
      } catch (error) {
        console.error(`voice sample not saved to ${opts.dir}: ${(error as Error).message}`);
      }
    },
  };
}

async function store({ dir, maxSamples }: { dir: string; maxSamples: number }, sample: Sample): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  await chmod(dir, PRIVATE_DIR);
  const kept = (await readdir(dir)).filter((name) => name.endsWith(".wav")).length;
  if (kept >= maxSamples) {
    console.error(`voice samples budget: stt.maxSamples=${maxSamples}, ${dir} already holds ${kept}, this recording was not saved (raise stt.maxSamples or move the old ones out)`);
    return;
  }
  const stem = `${new Date().toISOString()}-${sample.deviceId.slice(0, DEVICE_ID_SHORT)}`;
  const { wav, deviceId: _deviceId, ...meta } = sample;
  await writeAtomic(join(dir, `${stem}.wav`), wav);
  await writeAtomic(join(dir, `${stem}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`voice sample saved: ${join(dir, `${stem}.wav`)} (${sample.durationSec} s)`);
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data, { mode: PRIVATE_FILE });
  await rename(tmp, path);
}
