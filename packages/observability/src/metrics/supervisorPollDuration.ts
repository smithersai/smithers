import { Metric } from "effect";
import { fastBuckets } from "./_buckets";

export const supervisorPollDuration = Metric.histogram(
  "smithers.supervisor.poll_duration_ms",
  fastBuckets,
);
