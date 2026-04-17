import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";
import type { SourceDef } from "./SourceDef.ts";

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
