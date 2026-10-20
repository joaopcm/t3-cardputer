export type SecretInput = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };

const ETX = "\u0003";
const BACKSPACE = "\u007f";

export async function readSecret(stdin: SecretInput): Promise<string> {
  if (stdin.isTTY !== true || stdin.setRawMode === undefined) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const setRawMode = stdin.setRawMode.bind(stdin);
  return new Promise((resolve, reject) => {
    let typed = "";
    const finish = (settle: () => void) => {
      stdin.removeListener("data", onData);
      setRawMode(false);
      stdin.pause();
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(() => resolve(typed.trim()));
        if (char === ETX) return finish(() => reject(new Error("aborted")));
        typed = char === BACKSPACE ? typed.slice(0, -1) : typed + char;
      }
    };
    setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}
