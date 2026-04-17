import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type ScanFixVerifyProps = {
	/** ID prefix for generated task/component ids. */
	id?: string;
	/** Agent that scans for problems. */
	scanner: AgentLike;
	/** Agent (or agents) that fixes problems. When an array is provided, agents are cycled across issues. */
	fixer: AgentLike | AgentLike[];
	/** Agent that verifies the fixes were applied correctly. */
	verifier: AgentLike;
	/** Output schema for scan results. Should include `issues: Array`. */
	scanOutput: OutputTarget;
	/** Output schema for each individual fix. */
	fixOutput: OutputTarget;
	/** Output schema for verification results. */
	verifyOutput: OutputTarget;
	/** Output schema for the final summary report. */
	reportOutput: OutputTarget;
	/** Maximum number of parallel fix tasks. */
	maxConcurrency?: number;
	/** Maximum scan-fix-verify cycles before stopping. Default 3. */
	maxRetries?: number;
	/** Skip the entire component. */
	skipIf?: boolean;
	/** Prompt/context describing what to scan for. */
	children?: React.ReactNode;
};
