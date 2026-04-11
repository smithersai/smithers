import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const attemptDuration = Metric.histogram(
  "smithers.attempt.duration_ms",
  durationBuckets,
);
