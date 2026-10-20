import { z } from "zod";
import { T3UnavailableError, isConnectionError } from "./mcp.js";

const environmentSchema = z.object({
  serverVersion: z.string(),
  orchestrationProtocolVersion: z.number().int(),
  capabilities: z.record(z.string(), z.unknown()),
});

export type T3Environment = z.infer<typeof environmentSchema>;

export async function getEnvironment(baseUrl: string): Promise<T3Environment> {
  const url = new URL("/.well-known/t3/environment", baseUrl);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (isConnectionError(error)) throw new T3UnavailableError(`T3 unreachable at ${baseUrl}`, { cause: error });
    throw error;
  }
  if (!response.ok) throw new Error(`GET ${url.pathname} returned ${response.status}`);
  const parsed = environmentSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`GET ${url.pathname} is not a T3 environment: ${parsed.error.message}`);
  return parsed.data;
}
