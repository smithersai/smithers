import type { TaskDescriptor } from "@smithers/graph/types";

export type SchedulerWaitHandler = (
  durationMs: number,
  context: { runId: string; tasks: readonly TaskDescriptor[] },
) => Promise<void> | void;
