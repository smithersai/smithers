import type { RunStatusSchema } from "./RunStatusSchema.ts";

export type RunSummary = {
	runId: string;
	parentRunId: string | null;
	workflowName: string;
	workflowPath: string | null;
	workflowHash: string | null;
	status: RunStatusSchema;
	createdAtMs: number;
	startedAtMs: number | null;
	finishedAtMs: number | null;
	heartbeatAtMs: number | null;
	runtimeOwnerId: string | null;
	cancelRequestedAtMs: number | null;
	hijackRequestedAtMs: number | null;
	hijackTarget: string | null;
	vcsType: string | null;
	vcsRoot: string | null;
	vcsRevision: string | null;
	errorJson: string | null;
	configJson: string | null;
};
