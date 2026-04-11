import { Metric } from "effect";
import { tokenBuckets } from "./_buckets";

export const sandboxPatchCount = Metric.histogram(
  "smithers.sandbox.patch_count",
  tokenBuckets,
);
