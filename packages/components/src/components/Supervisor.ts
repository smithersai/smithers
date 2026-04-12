import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./Task";
export type SupervisorProps = {
    id?: string;
    /** Agent that plans, delegates, and reviews worker results. */
    boss: AgentLike;
    /** Map of worker type names to agents (e.g., { coder, tester, docs }). */
    workers: Record<string, AgentLike>;
    /** Output schema for the boss's plan. Must include `tasks: Array<{ id, workerType, instructions }>`. */
    planOutput: OutputTarget;
    /** Output schema for individual worker results. */
    workerOutput: OutputTarget;
    /** Output schema for the boss's review. Must include `allDone: boolean` and `retriable: string[]`. */
    reviewOutput: OutputTarget;
    /** Output schema for the final summary. */
    finalOutput: OutputTarget;
    /** Max delegate-review cycles (default 3). */
    maxIterations?: number;
    /** Max parallel workers (default 5). */
    maxConcurrency?: number;
    /** Whether each worker gets its own git worktree (default false). */
    useWorktrees?: boolean;
    skipIf?: boolean;
    /** Goal/prompt for the boss agent. */
    children: string | React.ReactNode;
};
/**
 * <Supervisor> — Boss plans, delegates to parallel workers, reviews, re-delegates failures.
 *
 * Composes: Sequence → [plan Task, Loop(until allDone) [Parallel worker Tasks, review Task], final Task]
 */
export declare function Supervisor(props: SupervisorProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
