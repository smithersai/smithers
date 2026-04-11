import { Context, Effect } from "effect";
import type { TaskDescriptor } from "@smithers/graph";
import type { TaskStateMap } from "./TaskStateMap.ts";
import type { PlanNode } from "./PlanNode.ts";
import type { RalphStateMap } from "./RalphStateMap.ts";
import type { RetryWaitMap } from "./RetryWaitMap.ts";
import type { ScheduleResult } from "./ScheduleResult.ts";

export class Scheduler extends Context.Tag("Scheduler")<
  Scheduler,
  {
    readonly schedule: (
      plan: PlanNode | null,
      states: TaskStateMap,
      descriptors: Map<string, TaskDescriptor>,
      ralphState: RalphStateMap,
      retryWait: RetryWaitMap,
      nowMs: number,
    ) => Effect.Effect<ScheduleResult>;
  }
>() {}
