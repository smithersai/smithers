import type { TaskDescriptor } from "@smithers-orchestrator/graph/types";

export type SchedulerWaitHandler = (
  durationMs: number,
  context: { runId: string; tasks: readonly TaskDescriptor[] },
) => Promise<void> | void;
