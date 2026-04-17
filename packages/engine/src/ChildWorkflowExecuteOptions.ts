import type { ChildWorkflowDefinition } from "./ChildWorkflowDefinition.ts";

export type ChildWorkflowExecuteOptions = {
	workflow: ChildWorkflowDefinition;
	input?: unknown;
	runId?: string;
	parentRunId?: string;
	rootDir?: string;
	allowNetwork?: boolean;
	maxOutputBytes?: number;
	toolTimeoutMs?: number;
	workflowPath?: string;
	signal?: AbortSignal;
};
