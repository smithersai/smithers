import { Metric } from "effect";

export const timersFired = Metric.counter("smithers.timers.fired");
