import { Metric } from "effect";

export const dbRetries = Metric.counter("smithers.db.retries");
