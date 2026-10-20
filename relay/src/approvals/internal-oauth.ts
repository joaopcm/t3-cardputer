import { z } from "zod";
import type { TokenRecord } from "../secrets.js";
import { T3UnavailableError, isConnectionError } from "../t3/mcp.js";
import { AdapterBrokenError, decode } from "./types.js";

const tokenResponseSchema = z.looseObject({ access_token: z.string(), expires_in: z.number() });

export async function pairT3Internal(baseUrl: string, pairingToken: string): Promise<TokenRecord> {
  const requestedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(new URL("/oauth/token", baseUrl), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: pairingToken,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        client_label: "t3-cardputer-relay",
        client_device_type: "bot",
      }),
    });
  } catch (error) {
    if (isConnectionError(error)) throw new T3UnavailableError(`T3 unreachable at ${baseUrl}`, { cause: error });
    throw error;
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`POST /oauth/token returned ${response.status}: ${text}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AdapterBrokenError("POST /oauth/token returned non-JSON");
  }
  const token = decode(tokenResponseSchema, body, "POST /oauth/token");
  return { token: token.access_token, expiresAt: new Date(requestedAt + token.expires_in * 1000).toISOString() };
}
