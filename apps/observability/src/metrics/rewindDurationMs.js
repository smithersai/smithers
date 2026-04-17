import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const rewindDurationMs = Metric.histogram("smithers_rewind_duration_ms", durationBuckets);
