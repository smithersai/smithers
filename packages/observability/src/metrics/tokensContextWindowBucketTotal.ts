import { Metric } from "effect";

export const tokensContextWindowBucketTotal = Metric.counter(
  "smithers.tokens.context_window_bucket_total",
);
