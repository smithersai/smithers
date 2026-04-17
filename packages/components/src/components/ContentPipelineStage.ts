import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

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
