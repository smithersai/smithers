import { Metric } from "effect";

export const alertsSilencedTotal = Metric.counter("smithers.alerts.silenced_total");
