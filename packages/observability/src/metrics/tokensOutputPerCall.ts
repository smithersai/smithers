import { Metric } from "effect";
import { tokenBuckets } from "./_buckets";

export const tokensOutputPerCall = Metric.histogram(
  "smithers.tokens.output_per_call",
  tokenBuckets,
);
