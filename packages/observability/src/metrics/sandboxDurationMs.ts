import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const sandboxDurationMs = Metric.histogram(
  "smithers.sandbox.duration_ms",
  durationBuckets,
);
