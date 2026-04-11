import { Metric } from "effect";

export const errorsTotal = Metric.counter("smithers.errors.total");
