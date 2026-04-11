import { Metric } from "effect";

export const runsCancelledTotal = Metric.counter("smithers.runs.cancelled_total");
