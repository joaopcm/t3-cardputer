const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

export class BudgetError extends Error {
  override name = "BudgetError";
}

export class AudioBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(
    private readonly sampleRate: 16000,
    private readonly maxSeconds: number,
  ) {
    this.maxBytes = sampleRate * BYTES_PER_SAMPLE * maxSeconds;
  }

  get durationSec(): number {
    return this.bytes / BYTES_PER_SAMPLE / this.sampleRate;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0 || chunk.length % BYTES_PER_SAMPLE !== 0) {
      throw new RangeError(`audio frame must be a non-empty even number of bytes, got ${chunk.length}`);
    }
    if (this.bytes + chunk.length > this.maxBytes) {
      throw new BudgetError(`audio budget: audio_max_seconds=${this.maxSeconds}, recording reached ${this.maxSeconds}s`);
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  toWav(): Buffer {
    const header = Buffer.alloc(WAV_HEADER_BYTES);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(WAV_HEADER_BYTES - 8 + this.bytes, 4);
    header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.sampleRate * BYTES_PER_SAMPLE, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(this.bytes, 40);
    return Buffer.concat([header, ...this.chunks]);
  }
}
