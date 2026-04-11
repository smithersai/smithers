import { Metric } from "effect";

export const dbTransactionRetries = Metric.counter("smithers.db.transaction_retries");
