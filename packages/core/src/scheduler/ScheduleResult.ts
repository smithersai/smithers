import type { TaskDescriptor } from "../graph.ts";
import type { ContinuationRequest } from "./ContinuationRequest.ts";
import type { RalphMeta } from "./RalphMeta.ts";

export type ScheduleResult = {
  readonly runnable: readonly TaskDescriptor[];
  readonly pendingExists: boolean;
  readonly waitingApprovalExists: boolean;
  readonly waitingEventExists: boolean;
  readonly waitingTimerExists: boolean;
  readonly readyRalphs: readonly RalphMeta[];
  readonly continuation?: ContinuationRequest;
  readonly nextRetryAtMs?: number;
  readonly fatalError?: string;
};
