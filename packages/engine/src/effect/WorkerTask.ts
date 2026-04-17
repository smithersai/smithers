import type { WorkerTaskKind } from "./WorkerTaskKind.ts";
import type { WorkerDispatchKind } from "./WorkerDispatchKind.ts";

export type WorkerTask = {
	executionId: string;
	bridgeKey: string;
	workflowName: string;
	runId: string;
	nodeId: string;
	iteration: number;
	retries: number;
	taskKind: WorkerTaskKind;
	dispatchKind: WorkerDispatchKind;
};
