import { Metric } from "effect";
import { fastBuckets } from "./_buckets";

export const heartbeatIntervalMs = Metric.histogram(
  "smithers.heartbeats.interval_ms",
  fastBuckets,
);
