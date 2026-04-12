import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./Task";
export type DebateProps = {
    id?: string;
    proposer: AgentLike;
    opponent: AgentLike;
    judge: AgentLike;
    rounds?: number;
    argumentOutput: OutputTarget;
    verdictOutput: OutputTarget;
    topic: string | React.ReactNode;
    skipIf?: boolean;
};
/**
 * <Debate> — Adversarial rounds with rebuttals, followed by a judge verdict.
 *
 * Composes: Sequence > Loop[Parallel(proposer, opponent)] > Task(judge)
 */
export declare function Debate(props: DebateProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
