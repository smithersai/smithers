import { Metric } from "effect";
import { sizeBuckets } from "./_buckets";

export const sandboxBundleSizeBytes = Metric.histogram(
  "smithers.sandbox.bundle_size_bytes",
  sizeBuckets,
);
