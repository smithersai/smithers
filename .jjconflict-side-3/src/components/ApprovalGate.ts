import React from "react";
import { Branch } from "./Branch";
import { Approval } from "./Approval";
import { Task } from "./Task";
import type { ApprovalRequest } from "./Approval";
import type { RetryPolicy } from "../RetryPolicy";
import type { CachePolicy } from "../CachePolicy";

/** Valid output targets for ApprovalGate: Zod schema, Drizzle table, or string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type ApprovalGateProps = {
  id: string;
  /** Where to persist the approval decision. */
  output: OutputTarget;
  /** Human-facing approval request. */
  request: ApprovalRequest;
  /** When `true`, approval is required. When `false`, auto-approves. */
  when: boolean;
  /** Behavior after denial. */
  onDeny?: "fail" | "continue" | "skip";
  skipIf?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryPolicy?: RetryPolicy;
  continueOnFail?: boolean;
};

/**
 * Conditional approval gate. Requires human approval only when `when` is true;
 * otherwise auto-approves with a static `{ approved: true }` decision.
 *
 * Composes Branch + Approval + Task internally.
 */
export function ApprovalGate(props: ApprovalGateProps) {
  if (props.skipIf) return null;

  return React.createElement(Branch, {
    if: props.when,
    then: React.createElement(Approval, {
      id: props.id,
      output: props.output,
      request: props.request,
      onDeny: props.onDeny,
      timeoutMs: props.timeoutMs,
      retries: props.retries,
      retryPolicy: props.retryPolicy,
      continueOnFail: props.continueOnFail,
    }),
    else: React.createElement(Task, {
      id: props.id,
      output: props.output,
      label: `${props.request.title} (auto-approved)`,
      children: {
        approved: true,
        note: "auto-approved",
        decidedBy: null,
        decidedAt: new Date().toISOString(),
      },
    }),
  });
}
