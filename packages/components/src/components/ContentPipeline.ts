import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./Task";
export type ContentPipelineStage = {
    /** Unique identifier for this stage. */
    id: string;
    /** Agent that performs this stage's work. */
    agent: AgentLike;
    /** Output schema for this stage. */
    output: OutputTarget;
    /** Human-readable label for the stage (used as task label). */
    label?: string;
};
export type ContentPipelineProps = {
    id?: string;
    /** Pipeline stages executed in order. Each stage receives the previous stage's output. */
    stages: ContentPipelineStage[];
    /** Skip the entire pipeline. */
    skipIf?: boolean;
    /** Initial prompt/content for the first stage (string or ReactNode). */
    children: string | React.ReactNode;
};
/**
 * Progressive content refinement: outline -> draft -> edit -> publish.
 *
 * Composes Sequence and Task to create a typed waterfall where each
 * stage is explicitly defined. Each Task uses `needs` to depend on
 * the previous stage, passing output forward through the pipeline.
 */
export declare function ContentPipeline(props: ContentPipelineProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
