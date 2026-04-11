import { Metric } from "effect";
import { fastBuckets } from "./_buckets";

export const vcsDuration = Metric.histogram(
  "smithers.vcs.duration_ms",
  fastBuckets,
);
