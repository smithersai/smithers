import { Effect, Layer } from "effect";
import { MetricsService } from "../observability/metrics.ts";
import { TracingService } from "../observability/tracing.ts";
import { Scheduler } from "./Scheduler.ts";
import { scheduleTasks } from "./scheduleTasks.ts";

export const SchedulerLive = Layer.effect(
  Scheduler,
  Effect.gen(function* () {
    const metrics = yield* MetricsService;
    const tracing = yield* TracingService;
    return {
      schedule: (plan, states, descriptors, ralphState, retryWait, nowMs) =>
        tracing.withSpan(
          "smithers.scheduler.schedule",
          Effect.sync(() =>
            scheduleTasks(plan, states, descriptors, ralphState, retryWait, nowMs),
          ).pipe(
            Effect.tap((result) =>
              metrics.gauge("smithers.scheduler.queue_depth", result.runnable.length),
            ),
          ),
          { runnableInputs: descriptors.size },
        ),
    };
  }),
);
