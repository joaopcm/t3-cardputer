export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
// receipt: docs/protocol.md leaves chunk size to the device; 100 ms is 3200 bytes, far under DEVICE_FRAME_BYTES_MAX
export const CHUNK_MS = 100;
export const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;

export class WavError extends Error {
  override name = "WavError";
}

export function parseWav(file: Buffer): Buffer {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") {
    throw new WavError("not a RIFF/WAVE file");
  }
  let format: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let offset = 12;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      if (start + 16 > file.length) throw new WavError("truncated fmt chunk");
      format = {
        tag: file.readUInt16LE(start),
        channels: file.readUInt16LE(start + 2),
        rate: file.readUInt32LE(start + 4),
        bits: file.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      if (format === undefined) throw new WavError("data chunk before fmt chunk");
      if (format.tag !== 1 || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) {
        throw new WavError(
          `wav must be 16000 Hz mono 16-bit PCM (s16le), got format ${format.tag}, ${format.rate} Hz, ${format.channels} ch, ${format.bits} bit`,
        );
      }
      const end = Math.min(start + size, file.length);
      const even = end - ((end - start) % BYTES_PER_SAMPLE);
      return file.subarray(start, even);
    }
    offset = start + size + (size % 2);
  }
  throw new WavError("no data chunk");
}

export function* pcmChunks(pcm: Buffer): Generator<Buffer> {
  for (let at = 0; at < pcm.length; at += CHUNK_BYTES) yield pcm.subarray(at, Math.min(at + CHUNK_BYTES, pcm.length));
}
