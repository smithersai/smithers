import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type SourceDef = {
    agent: AgentLike;
    /** Prompt for this source. A string or ReactNode. */
    prompt?: string;
    /** Output schema for this specific source. Overrides `gatherOutput`. */
    output?: OutputTarget;
    children?: React.ReactNode;
};
export type GatherAndSynthesizeProps = {
    id?: string;
    /** Record mapping source names to source definitions. */
    sources: Record<string, SourceDef>;
    /** Agent that synthesizes gathered data. */
    synthesizer: AgentLike;
    /** Default output schema for each source gather task. */
    gatherOutput: OutputTarget;
    /** Output schema for the synthesis task. */
    synthesisOutput: OutputTarget;
    /** Gathered results keyed by source name. Typically from ctx.outputMaybe(). */
    gatheredResults?: Record<string, unknown> | null;
    /** Max parallel gatherers. */
    maxConcurrency?: number;
    /** Prompt for the synthesis task. If omitted, a default prompt is generated. */
    synthesisPrompt?: string;
    skipIf?: boolean;
    children?: React.ReactNode;
};
/**
 * <GatherAndSynthesize> — Parallel data collection from different sources,
 * then synthesis into a unified result.
 *
 * Composes Sequence, Parallel, and Task. First a Parallel block gathers data
 * from each source agent, then a synthesis Task receives all gathered data
 * and produces a combined output.
 */
export declare function GatherAndSynthesize(props: GatherAndSynthesizeProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
export {};
