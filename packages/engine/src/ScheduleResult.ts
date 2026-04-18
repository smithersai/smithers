import type { TaskDescriptor } from "@smithers-orchestrator/graph/TaskDescriptor";
import type { RalphMeta } from "./RalphMeta.ts";
import type { ContinuationRequest } from "./ContinuationRequest.ts";

export type ScheduleResult = {
	runnable: TaskDescriptor[];
	pendingExists: boolean;
	waitingApprovalExists: boolean;
	waitingEventExists: boolean;
	waitingTimerExists: boolean;
	readyRalphs: RalphMeta[];
	continuation?: ContinuationRequest;
	nextRetryAtMs?: number;
	fatalError?: string;
};
