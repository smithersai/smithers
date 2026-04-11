import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const timerDelayDuration = Metric.histogram(
  "smithers.timers.delay_ms",
  durationBuckets,
);
