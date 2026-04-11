import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const agentDurationMs = Metric.histogram(
  "smithers.agent_duration_ms",
  durationBuckets,
);
