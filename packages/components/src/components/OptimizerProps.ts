import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type OptimizerProps = {
	id?: string;
	/** Agent that generates or improves candidates each iteration. */
	generator: AgentLike;
	/** Agent (or compute function) that scores candidates. */
	evaluator: AgentLike | ((candidate: unknown) => unknown | Promise<unknown>);
	/** Output schema for generated candidates. */
	generateOutput: OutputTarget;
	/** Output schema for evaluation results. Must include a `score: number` field. */
	evaluateOutput: OutputTarget;
	/** Score threshold to stop early. When omitted, runs all iterations. */
	targetScore?: number;
	/** Maximum optimization rounds. @default 10 */
	maxIterations?: number;
	/** Behavior when maxIterations is reached. @default "return-last" */
	onMaxReached?: "return-last" | "fail";
	/** Skip the entire optimization loop. */
	skipIf?: boolean;
	/** Initial generation prompt (string or ReactNode). */
	children: string | React.ReactNode;
};
