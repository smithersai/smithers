import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type DriftDetectorProps = {
	/** ID prefix for generated task/component ids. */
	id?: string;
	/** Agent that captures the current state snapshot. */
	captureAgent: AgentLike;
	/** Agent that compares current state against the baseline. */
	compareAgent: AgentLike;
	/** Output schema for the captured state. */
	captureOutput: OutputTarget;
	/** Output schema for the comparison result. Should include `drifted: boolean` and `significance: string`. */
	compareOutput: OutputTarget;
	/** Static baseline data, or a function/agent that fetches it. */
	baseline: unknown;
	/** Condition function that determines whether to fire the alert. If omitted, uses the `drifted` field from comparison output. */
	alertIf?: (comparison: unknown) => boolean;
	/** Element to render when drift is detected (e.g. a Task that sends a notification). */
	alert?: React.ReactElement;
	/** If set, wraps the detector in a Loop for periodic polling. */
	poll?: {
		intervalMs: number;
		maxPolls?: number;
	};
	/** Skip the entire component. */
	skipIf?: boolean;
};
