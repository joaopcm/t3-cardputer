import { describe, expect, it } from "vitest";
import { T3_TOKEN_WARN_DAYS, tokenExpiryWarnings } from "../src/t3/token-expiry.js";

const DAY_MS = 86_400_000;
const now = new Date("2026-10-20T12:00:00.000Z");
const inDays = (days: number) => ({ token: "t", expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString() });

describe("tokenExpiryWarnings", () => {
  it("warns 5 days out", () => {
    expect(T3_TOKEN_WARN_DAYS).toBe(5);
  });

  it("says nothing 6 days out", () => {
    expect(tokenExpiryWarnings({ devices: [], t3McpToken: inDays(6), t3InternalToken: inDays(20) }, now)).toEqual([]);
  });

  it("counts the days to the nearer of the two tokens at 5 days", () => {
    expect(tokenExpiryWarnings({ devices: [], t3McpToken: inDays(20), t3InternalToken: inDays(5) }, now)).toEqual(["T3 tokens expire in 5 days: run t3-cardputer-relay renew"]);
  });

  it("says expired at 0 and -1 days", () => {
    expect(tokenExpiryWarnings({ devices: [], t3McpToken: inDays(0), t3InternalToken: inDays(20) }, now)).toEqual(["T3 tokens expired: run t3-cardputer-relay renew"]);
    expect(tokenExpiryWarnings({ devices: [], t3McpToken: inDays(20), t3InternalToken: inDays(-1) }, now)).toEqual(["T3 tokens expired: run t3-cardputer-relay renew"]);
  });

  it("rounds a part day up, so the last day reads 1 day", () => {
    expect(tokenExpiryWarnings({ devices: [], t3McpToken: inDays(1 / 24) }, now)).toEqual(["T3 tokens expire in 1 day: run t3-cardputer-relay renew"]);
  });

  it("says nothing without tokens, the missing-token reasons cover that", () => {
    expect(tokenExpiryWarnings({ devices: [] }, now)).toEqual([]);
  });
});
