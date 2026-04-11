import { Metric } from "effect";

export const alertsAcknowledgedTotal = Metric.counter(
  "smithers.alerts.acknowledged_total",
);
