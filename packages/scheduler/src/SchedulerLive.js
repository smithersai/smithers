import { Effect, Layer } from "effect";
import { Scheduler } from "./Scheduler.js";
import { scheduleTasks } from "./scheduleTasks.js";

/** @type {Layer.Layer<Scheduler, never, never>} */
export const SchedulerLive = Layer.succeed(Scheduler, {
    schedule: (plan, states, descriptors, ralphState, retryWait, nowMs) => Effect.sync(() => scheduleTasks(plan, states, descriptors, ralphState, retryWait, nowMs)),
});
