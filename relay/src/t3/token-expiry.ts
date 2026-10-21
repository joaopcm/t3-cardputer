import type { Secrets } from "../secrets.js";

// receipt: both T3 tokens last 30 days (docs/install.md "Updating"), and 5 days spans a weekend plus a work week
export const T3_TOKEN_WARN_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW_HINT = "run t3-cardputer-relay renew";

export function tokenExpiryWarnings(secrets: Secrets, now: Date): string[] {
  const expiries = [secrets.t3McpToken, secrets.t3InternalToken].flatMap((record) => (record === undefined ? [] : [Date.parse(record.expiresAt)]));
  if (expiries.length === 0) return [];
  const left = Math.min(...expiries) - now.getTime();
  if (left <= 0) return [`T3 tokens expired: ${RENEW_HINT}`];
  const days = Math.ceil(left / DAY_MS);
  if (days > T3_TOKEN_WARN_DAYS) return [];
  return [`T3 tokens expire in ${days} ${days === 1 ? "day" : "days"}: ${RENEW_HINT}`];
}
