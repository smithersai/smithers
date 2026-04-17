import type React from "react";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
import type { SmithersWorkflow } from "../SmithersWorkflow.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type SubflowProps = {
	id: string;
	/** The child workflow definition. */
	workflow: SmithersWorkflow<any>;
	/** Input to pass to the child workflow. */
	input?: unknown;
	/** `"childRun"` gets its own DB row/run; `"inline"` embeds in parent. */
	mode?: "childRun" | "inline";
	/** Where to store the subflow's result. */
	output: OutputTarget;
	skipIf?: boolean;
	timeoutMs?: number;
	heartbeatTimeoutMs?: number;
	heartbeatTimeout?: number;
	retries?: number;
	retryPolicy?: RetryPolicy;
	continueOnFail?: boolean;
	cache?: CachePolicy;
	/** Explicit dependency on other task node IDs. */
	dependsOn?: string[];
	/** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
	needs?: Record<string, string>;
	label?: string;
	meta?: Record<string, unknown>;
	key?: string;
	children?: React.ReactNode;
};
