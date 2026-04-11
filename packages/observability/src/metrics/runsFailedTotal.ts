import { Metric } from "effect";

export const runsFailedTotal = Metric.counter("smithers.runs.failed_total");
