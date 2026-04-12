import React from "react";
import type { ApprovalRequest } from "./Approval";
import type { AgentLike } from "@smithers/agents/AgentLike";
/** Valid output targets: Zod schema, Drizzle table, or string key. */
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type EscalationLevel = {
    /** Agent to handle this escalation level. */
    agent: AgentLike;
    /** Output target for this level's result. */
    output: OutputTarget;
    /** Display label for this level. */
    label?: string;
    /** Predicate evaluated on the level's result. Return `true` to escalate. */
    escalateIf?: (result: any) => boolean;
};
export type EscalationChainProps = {
    /** ID prefix for generated nodes. */
    id?: string;
    /** Ordered escalation levels. Each level runs only if the previous escalated. */
    levels: EscalationLevel[];
    /** If `true`, the final escalation produces a human approval node. */
    humanFallback?: boolean;
    /** Approval request config used when `humanFallback` is `true`. */
    humanRequest?: ApprovalRequest;
    /** Output target for escalation tracking at each level. */
    escalationOutput: OutputTarget;
    skipIf?: boolean;
    /** Prompt / input passed to each agent level. */
    children?: React.ReactNode;
};
/**
 * Escalation chain: tries agents in order, escalating on failure or when
 * `escalateIf` returns `true`. Optionally ends with a human approval fallback.
 *
 * Composes Sequence + Task (with `continueOnFail`) + Branch + Approval.
 */
export declare function EscalationChain(props: EscalationChainProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
export {};
