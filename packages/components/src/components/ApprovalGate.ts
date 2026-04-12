import React from "react";
import type { ApprovalRequest } from "./Approval";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
/** Valid output targets for ApprovalGate: Zod schema, Drizzle table, or string key. */
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
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
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
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
export declare function ApprovalGate(props: ApprovalGateProps): React.FunctionComponentElement<import("./Branch").BranchProps> | null;
export {};
