import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const nodeDuration = Metric.histogram(
  "smithers.node.duration_ms",
  durationBuckets,
);
