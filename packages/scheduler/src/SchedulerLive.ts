import { Effect, Layer } from "effect";
import { Scheduler } from "./Scheduler.ts";
import { scheduleTasks } from "./scheduleTasks.ts";

export const SchedulerLive = Layer.succeed(Scheduler, {
  schedule: (plan, states, descriptors, ralphState, retryWait, nowMs) =>
    Effect.sync(() =>
      scheduleTasks(plan, states, descriptors, ralphState, retryWait, nowMs),
    ),
});
