import { Metric } from "effect";

export const alertDeliveriesSuppressed = Metric.counter("smithers.alerts.deliveries_suppressed");
