import { Metric } from "effect";

export const scorerEventsFailed = Metric.counter("smithers.scorer_events.failed");
