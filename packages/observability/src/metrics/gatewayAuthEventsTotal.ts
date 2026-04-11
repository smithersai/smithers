import { Metric } from "effect";

export const gatewayAuthEventsTotal = Metric.counter(
  "smithers.gateway.auth_events_total",
);
