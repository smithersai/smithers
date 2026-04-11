import { Metric } from "effect";
import { fastBuckets } from "./_buckets";

export const dbQueryDuration = Metric.histogram(
  "smithers.db.query_ms",
  fastBuckets,
);
