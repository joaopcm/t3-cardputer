import { createHash, randomBytes } from "node:crypto";
import type { TokenRecord } from "../secrets.js";
import { T3UnavailableError, isConnectionError } from "./mcp.js";

const CLIENT_NAME = "t3-cardputer-relay";
const LOOPBACK_REDIRECT = "http://127.0.0.1:53682/callback";
// receipt: docs/receipts/2026-10-20-approvals-spike.md (d), only full-access can launch full-access threads
const ACCESS_LEVEL = "full-access";

async function post(baseUrl: string, path: string, init: { json?: unknown; form?: Record<string, string> }): Promise<Record<string, unknown>> {
  const headers = init.json === undefined ? undefined : { "content-type": "application/json" };
  const body = init.json === undefined ? new URLSearchParams(init.form) : JSON.stringify(init.json);
  let response: Response;
  try {
    response = await fetch(new URL(path, baseUrl), { method: "POST", ...(headers ? { headers } : {}), body });
  } catch (error) {
    if (isConnectionError(error)) throw new T3UnavailableError(`T3 unreachable at ${baseUrl}`, { cause: error });
    throw error;
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function pairT3Mcp(baseUrl: string, pairingCode: string): Promise<TokenRecord> {
  const registered = await post(baseUrl, "/oauth/mcp/register", { json: { client_name: CLIENT_NAME, redirect_uris: [LOOPBACK_REDIRECT] } });
  const clientId = String(registered.client_id);

  const verifier = randomBytes(32).toString("base64url");
  const authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: LOOPBACK_REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(8).toString("base64url"),
    resource: `${baseUrl.replace(/\/$/, "")}/mcp`,
  };
  const decided = await post(baseUrl, "/oauth/mcp/decision", {
    json: { authorization, decision: { _tag: "pairing-code", access: ACCESS_LEVEL, code: pairingCode } },
  });
  const redirect = new URL(String(decided.redirectTo));
  const code = redirect.searchParams.get("code");
  if (!code || redirect.searchParams.get("state") !== authorization.state) {
    throw new Error("POST /oauth/mcp/decision returned a redirect without a matching code and state");
  }

  const requestedAt = Date.now();
  const token = await post(baseUrl, "/oauth/mcp/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: authorization.resource,
    },
  });
  if (typeof token.access_token !== "string" || typeof token.expires_in !== "number") {
    throw new Error("POST /oauth/mcp/token response has no access_token and expires_in");
  }
  return { token: token.access_token, expiresAt: new Date(requestedAt + token.expires_in * 1000).toISOString() };
}
