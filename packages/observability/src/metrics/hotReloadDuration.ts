import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const hotReloadDuration = Metric.histogram(
  "smithers.hot.reload_duration_ms",
  durationBuckets,
);
