import { Metric } from "effect";

export const timersPending = Metric.gauge("smithers.timers.pending");
