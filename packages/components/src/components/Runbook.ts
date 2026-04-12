import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { ApprovalRequest } from "./Approval";
import type { OutputTarget } from "./Task";
export type RunbookStep = {
    /** Unique step identifier. */
    id: string;
    /** Agent for this step (falls back to `defaultAgent`). */
    agent?: AgentLike;
    /** Shell command or instruction for the step. */
    command?: string;
    /** Risk classification: safe auto-executes, risky/critical require approval. */
    risk: "safe" | "risky" | "critical";
    /** Human-readable label for the step. */
    label?: string;
    /** Per-step output schema override. */
    output?: OutputTarget;
};
export type RunbookProps = {
    id?: string;
    /** Ordered steps to execute. */
    steps: RunbookStep[];
    /** Default agent for steps that don't specify one. */
    defaultAgent?: AgentLike;
    /** Default output schema for step results. */
    stepOutput: OutputTarget;
    /** Template for approval requests on risky/critical steps. */
    approvalRequest?: Partial<ApprovalRequest>;
    /** Behavior when a risky/critical step is denied: "fail" (default) or "skip". */
    onDeny?: "fail" | "skip";
    skipIf?: boolean;
};
/**
 * <Runbook> — Sequential steps with risk classification.
 *
 * Safe steps auto-execute. Risky and critical steps require human approval first.
 * Composes: Sequence of [Approval? → Task] per step, chained via `needs`.
 */
export declare function Runbook(props: RunbookProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
