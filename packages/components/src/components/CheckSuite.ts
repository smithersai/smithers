import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./Task";
export type CheckConfig = {
    id: string;
    agent?: AgentLike;
    command?: string;
    label?: string;
};
export type CheckSuiteProps = {
    id?: string;
    checks: CheckConfig[] | Record<string, Omit<CheckConfig, "id">>;
    verdictOutput: OutputTarget;
    strategy?: "all-pass" | "majority" | "any-pass";
    maxConcurrency?: number;
    continueOnFail?: boolean;
    skipIf?: boolean;
};
/**
 * <CheckSuite> — Parallel checks with auto-aggregated pass/fail verdict.
 *
 * Composes: Sequence > Parallel[Task per check] > Task(verdict aggregator)
 */
export declare function CheckSuite(props: CheckSuiteProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
