import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type SourceDef = {
	agent: AgentLike;
	/** Prompt for this source. A string or ReactNode. */
	prompt?: string;
	/** Output schema for this specific source. Overrides `gatherOutput`. */
	output?: OutputTarget;
	children?: React.ReactNode;
};
