import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const voiceDuration = Metric.histogram(
  "smithers.voice.duration_ms",
  durationBuckets,
);
