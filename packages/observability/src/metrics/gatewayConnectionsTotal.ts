import { Metric } from "effect";

export const gatewayConnectionsTotal = Metric.counter(
  "smithers.gateway.connections_total",
);
