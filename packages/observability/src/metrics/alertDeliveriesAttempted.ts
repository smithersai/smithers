import { Metric } from "effect";

export const alertDeliveriesAttempted = Metric.counter("smithers.alerts.deliveries_attempted");
