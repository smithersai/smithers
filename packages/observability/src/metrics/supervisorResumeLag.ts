import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const supervisorResumeLag = Metric.histogram(
  "smithers.supervisor.resume_lag_ms",
  durationBuckets,
);
