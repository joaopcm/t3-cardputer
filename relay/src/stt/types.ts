export interface Stt {
  transcribe(wav: Buffer): Promise<string>;
  warning?(): string | undefined;
  onWarningChange?(listener: () => void): void;
}
