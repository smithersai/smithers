import type React from "react";
import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type ReviewLoopProps = {
	id?: string;
	/** Agent that produces or fixes the work each iteration. */
	producer: AgentLike;
	/** Agent (or agents) that reviews the produced work. */
	reviewer: AgentLike | AgentLike[];
	/** Output schema for the produced work. */
	produceOutput: OutputTarget;
	/** Output schema for the review result. Must include an `approved: boolean` field. */
	reviewOutput: OutputTarget;
	/** Maximum number of review cycles before stopping. @default 5 */
	maxIterations?: number;
	/** Behavior when maxIterations is reached. @default "return-last" */
	onMaxReached?: "return-last" | "fail";
	/** Skip the entire review loop. */
	skipIf?: boolean;
	/** Initial prompt for the producer (string or ReactNode). */
	children: string | React.ReactNode;
};
