import { Metric } from "effect";

export const timersCancelled = Metric.counter("smithers.timers.cancelled");
