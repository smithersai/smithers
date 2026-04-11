import { Metric } from "effect";
import { fastBuckets } from "./_buckets";

export const dbTransactionDuration = Metric.histogram(
  "smithers.db.transaction_ms",
  fastBuckets,
);
