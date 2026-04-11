import { Metric } from "effect";

export const alertsFiredTotal = Metric.counter("smithers.alerts.fired_total");
