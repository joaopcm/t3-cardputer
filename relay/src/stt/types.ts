export interface Stt {
  transcribe(wav: Buffer): Promise<string>;
}
