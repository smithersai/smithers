import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type PollerProps = {
	/** ID prefix for generated task/component ids. */
	id?: string;
	/** Agent or compute function that checks the condition. */
	check: AgentLike | (() => unknown | Promise<unknown>);
	/** Output schema for the check result. Must include `satisfied: boolean`. */
	checkOutput: OutputTarget;
	/** Maximum poll attempts. Default 30. */
	maxAttempts?: number;
	/** Backoff strategy between polls. Default "fixed". */
	backoff?: "fixed" | "linear" | "exponential";
	/** Base interval in milliseconds between polls. Default 5000. */
	intervalMs?: number;
	/** Behavior when maxAttempts is reached. Default "fail". */
	onTimeout?: "fail" | "return-last";
	/** Skip the entire component. */
	skipIf?: boolean;
	/** Prompt/condition description for the check agent. */
	children?: React.ReactNode;
};
