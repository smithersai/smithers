import { Metric } from "effect";

export const dbTransactionRollbacks = Metric.counter("smithers.db.transaction_rollbacks");
