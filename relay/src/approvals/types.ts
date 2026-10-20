import type { z } from "zod";

export type ApprovalDecision = { kind: "allow_once" } | { kind: "allow_always" } | { kind: "deny" } | { kind: "deny_with_reason"; reason: string };

export type PendingApproval = {
  threadId: string;
  requestId: string;
  summary: string;
  detail: string[];
  decisions: ApprovalDecision["kind"][];
};

export interface ApprovalsAdapter {
  listPending(threadIds: string[]): Promise<PendingApproval[]>;
  respond(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  close(): Promise<void>;
}

export class AdapterBrokenError extends Error {
  override name = "AdapterBrokenError";
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`T3 approvals adapter broken: ${reason}`, options);
  }
}

export class ApprovalRejectedError extends Error {
  override name = "ApprovalRejectedError";
}

export function decode<T extends z.ZodType>(schema: T, value: unknown, where: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `${[where, ...issue.path].join(".")}: ${issue.message}`);
  throw new AdapterBrokenError(issues.join("; "));
}
