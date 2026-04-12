import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./Task";
export type PanelistConfig = {
    agent: AgentLike;
    role?: string;
    label?: string;
};
export type PanelProps = {
    id?: string;
    panelists: PanelistConfig[] | AgentLike[];
    moderator: AgentLike;
    panelistOutput: OutputTarget;
    moderatorOutput: OutputTarget;
    strategy?: "synthesize" | "vote" | "consensus";
    minAgree?: number;
    maxConcurrency?: number;
    skipIf?: boolean;
    children: string | React.ReactNode;
};
/**
 * <Panel> — Parallel specialists review the same input, then a moderator synthesizes.
 *
 * Composes: Sequence > Parallel[Task per panelist] > Task(moderator)
 */
export declare function Panel(props: PanelProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
