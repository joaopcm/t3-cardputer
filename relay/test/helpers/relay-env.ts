import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export async function relayEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "relay-serve-"));
  const stateDir = join(root, "state");
  const binDir = join(root, "whisper");
  mkdirSync(join(binDir, "build", "bin"), { recursive: true });
  const script = join(binDir, "build", "bin", "whisper-server");
  writeFileSync(script, "#!/bin/sh\nwhile :; do sleep 0.2; done\n");
  chmodSync(script, 0o755);
  const port = await freePort();
  const configPath = join(root, "relay.json");
  writeFileSync(
    configPath,
    JSON.stringify({ port, stateDir, t3BaseUrl: "http://127.0.0.1:1", whisper: { binDir, port: await freePort() }, limits: { pollIntervalMs: 50 } }),
  );
  return { root, stateDir, port, configPath, secretsPath: join(root, "secrets.json"), pidFile: join(stateDir, "whisper.pid"), socketPath: join(stateDir, "admin.sock") };
}
