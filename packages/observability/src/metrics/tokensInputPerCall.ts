import { Metric } from "effect";
import { tokenBuckets } from "./_buckets";

export const tokensInputPerCall = Metric.histogram(
  "smithers.tokens.input_per_call",
  tokenBuckets,
);
