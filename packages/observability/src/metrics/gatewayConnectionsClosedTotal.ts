import { Metric } from "effect";

export const gatewayConnectionsClosedTotal = Metric.counter(
  "smithers.gateway.connections_closed_total",
);
